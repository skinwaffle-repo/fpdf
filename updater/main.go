// fuck pdf updater
// Copyright (C) fuck pdf contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Finds the newest fuck pdf on GitHub Releases or in a folder (e.g. a synced
// Nextcloud folder), downloads it, checks its SHA-256, closes the app,
// installs it silently (or swaps the portable exe) and starts it again.
//
//	fuck-pdf-updater.exe                  interactive: check + ask + update
//	fuck-pdf-updater.exe --check --json   what the app uses for its update check
//	fuck-pdf-updater.exe --yes            update without asking
//	--source github:owner/repo  --source folder:C:\path   (override config)
//	--portable C:\path\fuck-pdf-portable.exe --current 1.1.0   update a portable copy
//	--wait-pid N    wait for the app (pid N) to quit first
//	--no-relaunch   don't start the app afterwards
package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var version = "dev" // set at build time: -ldflags "-X main.version=1.1.0"

const appExe = "fuck pdf.exe"

const banner = `
    ____           __                ______
   / __/_  _______/ /__   ____  ____/ / __/
  / /_/ / / / ___/ //_/  / __ \/ __  / /_
 / __/ /_/ / /__/ ,<    / /_/ / /_/ / __/
/_/  \__,_/\___/_/|_|  / .___/\__,_/_/
                      /_/   updater
`

// ------------------------------------------------------------------ config

type Source struct {
	Type  string `json:"type"`            // "github" | "folder"
	Repo  string `json:"repo,omitempty"`  // owner/name, for github
	Token string `json:"token,omitempty"` // optional, for private repos
	Path  string `json:"path,omitempty"`  // for folder; %VARS% are expanded
}

type Config struct {
	Sources []Source `json:"sources"`
}

var defaultConfig = Config{Sources: []Source{
	{Type: "github", Repo: "skinwaffle-repo/fpdf"},
	{Type: "folder", Path: `%USERPROFILE%\Nextcloud\FPDF`},
}}

// If this exe sits next to fuck pdf installers (e.g. copied into a shared
// folder with them), that folder is a source too.
func withOwnFolder(cfg Config) Config {
	exe, err := os.Executable()
	if err != nil {
		return cfg
	}
	dir := filepath.Dir(exe)
	for _, s := range cfg.Sources {
		if s.Type == "folder" && strings.EqualFold(filepath.Clean(expandEnv(s.Path)), filepath.Clean(dir)) {
			return cfg
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return cfg
	}
	for _, e := range entries {
		if setupRe.MatchString(e.Name()) || portableRe.MatchString(e.Name()) {
			cfg.Sources = append(cfg.Sources, Source{Type: "folder", Path: dir})
			return cfg
		}
	}
	return cfg
}

func (s Source) label() string {
	if s.Type == "github" {
		return "github " + s.Repo
	}
	return "folder " + expandEnv(s.Path)
}

// %VAR% (Windows style) and $VAR / ${VAR}
var winVar = regexp.MustCompile(`%([A-Za-z0-9_()]+)%`)

func expandEnv(s string) string {
	s = winVar.ReplaceAllStringFunc(s, func(m string) string {
		if v, ok := os.LookupEnv(m[1 : len(m)-1]); ok {
			return v
		}
		return m
	})
	return os.ExpandEnv(s)
}

func loadConfig(explicit string) (Config, string) {
	var candidates []string
	if explicit != "" {
		candidates = append(candidates, explicit)
	} else {
		if appdata := os.Getenv("APPDATA"); appdata != "" {
			candidates = append(candidates, filepath.Join(appdata, "fuck pdf", "updater.json"))
		}
		if exe, err := os.Executable(); err == nil {
			candidates = append(candidates, filepath.Join(filepath.Dir(exe), "updater.json"))
		}
	}
	for _, p := range candidates {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var c Config
		if err := json.Unmarshal(b, &c); err != nil {
			warn("ignoring %s: %v", p, err)
			continue
		}
		if len(c.Sources) > 0 {
			return c, p
		}
	}
	return defaultConfig, ""
}

// ------------------------------------------------------------------ versions

type semver [3]int

func parseVersion(s string) (semver, bool) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "v")
	if i := strings.IndexAny(s, "-+ "); i >= 0 {
		s = s[:i]
	}
	parts := strings.Split(s, ".")
	if len(parts) < 1 || len(parts) > 3 {
		return semver{}, false
	}
	var v semver
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return semver{}, false
		}
		v[i] = n
	}
	return v, true
}

func (a semver) cmp(b semver) int {
	for i := 0; i < 3; i++ {
		if a[i] != b[i] {
			if a[i] < b[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

func (a semver) String() string { return fmt.Sprintf("%d.%d.%d", a[0], a[1], a[2]) }

// ------------------------------------------------------------------ releases

type Asset struct {
	Name   string
	Size   int64
	URL    string // https URL or a local file path
	Local  bool
	Token  string
	APIURL string // github asset API url (used with a token)
}

type Release struct {
	Version  semver
	Source   string
	Setup    *Asset
	Portable *Asset
	Sums     map[string]string // file name -> sha256 hex
}

func (r *Release) asset(kind string) *Asset {
	if kind == "portable" {
		return r.Portable
	}
	return r.Setup
}

var (
	setupRe    = regexp.MustCompile(`(?i)^fuck-pdf-(\d+\.\d+\.\d+)-setup\.exe$`)
	portableRe = regexp.MustCompile(`(?i)^fuck-pdf-(\d+\.\d+\.\d+)-portable\.exe$`)
	httpClient = &http.Client{Timeout: 0}
)

func userAgent() string { return "fuck-pdf-updater/" + version }

func fetchGithub(s Source) (*Release, error) {
	if s.Repo == "" {
		return nil, errors.New("no repo configured")
	}
	req, _ := http.NewRequest("GET", "https://api.github.com/repos/"+s.Repo+"/releases/latest", nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", userAgent())
	if s.Token != "" {
		req.Header.Set("Authorization", "Bearer "+s.Token)
	}
	c := &http.Client{Timeout: 20 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return nil, fmt.Errorf("can't reach github (%v)", shortErr(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return nil, errors.New("no releases found (private repo without a token, or nothing published yet)")
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("github said %s", resp.Status)
	}
	var data struct {
		Tag    string `json:"tag_name"`
		Assets []struct {
			Name     string `json:"name"`
			Size     int64  `json:"size"`
			URL      string `json:"url"`
			Download string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, fmt.Errorf("bad answer from github: %v", err)
	}
	v, ok := parseVersion(data.Tag)
	if !ok {
		return nil, fmt.Errorf("latest release tag %q isn't a version", data.Tag)
	}
	rel := &Release{Version: v, Source: s.label(), Sums: map[string]string{}}
	var sums *Asset
	for _, a := range data.Assets {
		as := &Asset{Name: a.Name, Size: a.Size, URL: a.Download, APIURL: a.URL, Token: s.Token}
		switch {
		case setupRe.MatchString(a.Name):
			rel.Setup = as
		case portableRe.MatchString(a.Name):
			rel.Portable = as
		case strings.EqualFold(a.Name, "SHA256SUMS") || strings.EqualFold(a.Name, "SHA256SUMS.txt"):
			sums = as
		}
	}
	if sums != nil {
		var sb strings.Builder
		if _, err := download(sums, &sb, nil); err == nil {
			rel.Sums = parseSums(sb.String())
		}
	}
	return rel, nil
}

func fetchFolder(s Source, kind string) (*Release, error) {
	dir := expandEnv(s.Path)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("can't read folder (%v)", shortErr(err))
	}
	type pair struct{ setup, portable *Asset }
	found := map[semver]*pair{}
	sums := map[string]string{}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		full := filepath.Join(dir, name)
		info, _ := e.Info()
		size := int64(0)
		if info != nil {
			size = info.Size()
		}
		if m := setupRe.FindStringSubmatch(name); m != nil {
			v, _ := parseVersion(m[1])
			p := found[v]
			if p == nil {
				p = &pair{}
				found[v] = p
			}
			p.setup = &Asset{Name: name, Size: size, URL: full, Local: true}
		} else if m := portableRe.FindStringSubmatch(name); m != nil {
			v, _ := parseVersion(m[1])
			p := found[v]
			if p == nil {
				p = &pair{}
				found[v] = p
			}
			p.portable = &Asset{Name: name, Size: size, URL: full, Local: true}
		} else if strings.EqualFold(name, "SHA256SUMS") || strings.EqualFold(name, "SHA256SUMS.txt") || strings.HasSuffix(strings.ToLower(name), ".sha256") {
			if b, err := os.ReadFile(full); err == nil {
				for k, v := range parseSums(string(b)) {
					sums[k] = v
				}
			}
		}
	}
	var versions []semver
	for v, p := range found {
		if (kind == "portable" && p.portable != nil) || (kind != "portable" && p.setup != nil) {
			versions = append(versions, v)
		}
	}
	if len(versions) == 0 {
		return nil, errors.New("no fuck pdf installers in there")
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i].cmp(versions[j]) > 0 })
	best := found[versions[0]]
	return &Release{Version: versions[0], Source: s.label(), Setup: best.setup, Portable: best.portable, Sums: sums}, nil
}

func parseSums(text string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(strings.TrimSpace(line))
		if len(f) >= 2 && len(f[0]) == 64 {
			out[strings.TrimPrefix(f[len(f)-1], "*")] = strings.ToLower(f[0])
		}
	}
	return out
}

// newest release that has the file we need. Sources are tried in order;
// on a version tie the earlier source wins.
func findLatest(cfg Config, kind string) (*Release, []string) {
	var best *Release
	var errs []string
	for _, s := range cfg.Sources {
		var rel *Release
		var err error
		switch s.Type {
		case "github":
			rel, err = fetchGithub(s)
		case "folder":
			rel, err = fetchFolder(s, kind)
		default:
			err = fmt.Errorf("unknown source type %q", s.Type)
		}
		if err != nil {
			errs = append(errs, s.label()+": "+err.Error())
			continue
		}
		if rel.asset(kind) == nil {
			errs = append(errs, s.label()+": release "+rel.Version.String()+" has no "+kind+" file")
			continue
		}
		if best == nil || rel.Version.cmp(best.Version) > 0 {
			best = rel
		}
	}
	return best, errs
}

// ------------------------------------------------------------------ target

type Target struct {
	Kind    string // installed | portable | none
	Dir     string // install dir
	Exe     string // app exe to (re)launch / replace
	Version semver
	HasVer  bool
}

func defaultInstallDir() string {
	if la := os.Getenv("LOCALAPPDATA"); la != "" {
		return filepath.Join(la, "Programs", "fuck pdf")
	}
	return ""
}

func readInstalledVersion(dir string) (semver, bool) {
	b, err := os.ReadFile(filepath.Join(dir, "resources", "app", "package.json"))
	if err != nil {
		return semver{}, false
	}
	var p struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(b, &p) != nil {
		return semver{}, false
	}
	return parseVersion(p.Version)
}

func detectTarget(installDir, portable, current string) Target {
	if portable != "" {
		t := Target{Kind: "portable", Exe: portable, Dir: filepath.Dir(portable)}
		if v, ok := parseVersion(current); ok {
			t.Version, t.HasVer = v, true
		}
		return t
	}
	var cands []string
	if installDir != "" {
		cands = append(cands, installDir)
	}
	if exe, err := os.Executable(); err == nil {
		// <install>/resources/updater/fuck-pdf-updater.exe
		cands = append(cands, filepath.Clean(filepath.Join(filepath.Dir(exe), "..", "..")))
	}
	cands = append(cands, defaultInstallDir())
	if pf := os.Getenv("ProgramFiles"); pf != "" {
		cands = append(cands, filepath.Join(pf, "fuck pdf"))
	}
	for _, d := range cands {
		if d == "" {
			continue
		}
		if v, ok := readInstalledVersion(d); ok {
			return Target{Kind: "installed", Dir: d, Exe: filepath.Join(d, appExe), Version: v, HasVer: true}
		}
	}
	return Target{Kind: "none", Dir: defaultInstallDir()}
}

func (t Target) assetKind() string {
	if t.Kind == "portable" {
		return "portable"
	}
	return "setup"
}

// ------------------------------------------------------------------ download

type progressFn func(done, total int64)

func download(a *Asset, w io.Writer, progress progressFn) (string, error) {
	h := sha256.New()
	out := io.MultiWriter(w, h)
	var r io.Reader
	total := a.Size
	if a.Local {
		f, err := os.Open(a.URL)
		if err != nil {
			return "", err
		}
		defer f.Close()
		if st, err := f.Stat(); err == nil {
			total = st.Size()
		}
		r = f
	} else {
		url := a.URL
		req, _ := http.NewRequest("GET", url, nil)
		req.Header.Set("User-Agent", userAgent())
		if a.Token != "" && a.APIURL != "" {
			req, _ = http.NewRequest("GET", a.APIURL, nil)
			req.Header.Set("User-Agent", userAgent())
			req.Header.Set("Accept", "application/octet-stream")
			req.Header.Set("Authorization", "Bearer "+a.Token)
		}
		resp, err := httpClient.Do(req)
		if err != nil {
			return "", err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return "", fmt.Errorf("download failed: %s", resp.Status)
		}
		if resp.ContentLength > 0 {
			total = resp.ContentLength
		}
		r = resp.Body
	}
	buf := make([]byte, 256*1024)
	var done int64
	last := time.Time{}
	for {
		n, err := r.Read(buf)
		if n > 0 {
			if _, werr := out.Write(buf[:n]); werr != nil {
				return "", werr
			}
			done += int64(n)
			if progress != nil && time.Since(last) > 120*time.Millisecond {
				progress(done, total)
				last = time.Now()
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
	}
	if progress != nil {
		progress(done, total)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func bar(done, total int64) {
	const width = 32
	pct := 0.0
	if total > 0 {
		pct = float64(done) / float64(total)
	}
	fill := int(pct * width)
	if fill > width {
		fill = width
	}
	fmt.Printf("\r  [%s%s] %3d%%  %6.1f / %.1f MB ", strings.Repeat("#", fill), strings.Repeat(".", width-fill), int(pct*100), float64(done)/1e6, float64(total)/1e6)
}

// ------------------------------------------------------------------ process helpers (Windows)

func appRunning() bool {
	if runtime.GOOS != "windows" {
		return false
	}
	out, err := exec.Command("tasklist", "/FI", "IMAGENAME eq "+appExe, "/FO", "CSV", "/NH").Output()
	if err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(string(out)), strings.ToLower(appExe))
}

func pidRunning(pid int) bool {
	if runtime.GOOS != "windows" {
		p, err := os.FindProcess(pid)
		return err == nil && p != nil && p.Signal(syscall.Signal(0)) == nil
	}
	out, err := exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %d", pid), "/FO", "CSV", "/NH").Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), fmt.Sprintf("\"%d\"", pid))
}

func waitFor(cond func() bool, timeout time.Duration) bool {
	end := time.Now().Add(timeout)
	for time.Now().Before(end) {
		if cond() {
			return true
		}
		time.Sleep(400 * time.Millisecond)
	}
	return cond()
}

// make sure the app is closed before files get replaced
func closeApp(waitPid int, yes bool) error {
	if waitPid > 0 {
		say("waiting for fuck pdf to close...")
		if !waitFor(func() bool { return !pidRunning(waitPid) }, 2*time.Minute) {
			warn("it's still running.")
		}
	}
	for attempt := 0; appRunning(); attempt++ {
		if attempt == 0 && !yes && !ask("fuck pdf is running. close it now?", true) {
			return errors.New("can't update while fuck pdf is open")
		}
		if attempt < 3 {
			say("asking fuck pdf to close (save your work if it asks)...")
			exec.Command("taskkill", "/IM", appExe).Run()
			if waitFor(func() bool { return !appRunning() }, 45*time.Second) {
				break
			}
			if yes {
				continue
			}
			if !ask("it's still open (unsaved changes?). try again?", true) {
				break
			}
			continue
		}
		if !yes && ask("force close it? anything unsaved is lost.", false) {
			exec.Command("taskkill", "/F", "/IM", appExe).Run()
			waitFor(func() bool { return !appRunning() }, 10*time.Second)
		}
		break
	}
	if appRunning() {
		return errors.New("fuck pdf is still running")
	}
	return nil
}

// re-run from %TEMP% so the installer can overwrite this exe
// sources resolved before relocating (tokens stay in the config file, which is passed along too)
var ownSources []Source

func relocate(target Target, cfgPath string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	tmp := filepath.Join(os.TempDir(), fmt.Sprintf("fuck-pdf-updater-%d.exe", os.Getpid()))
	if err := copyFile(exe, tmp); err != nil {
		return err
	}
	args := append([]string{}, os.Args[1:]...)
	args = append(args, "--from-temp", "--self-delete")
	if !hasFlag("install-dir") && target.Kind == "installed" {
		args = append(args, "--install-dir", target.Dir)
	}
	if !hasFlag("config") && cfgPath != "" {
		args = append(args, "--config", cfgPath)
	}
	if !hasFlag("source") {
		for _, s := range ownSources {
			switch s.Type {
			case "github":
				args = append(args, "--source", "github:"+s.Repo)
			case "folder":
				args = append(args, "--source", "folder:"+s.Path)
			}
		}
	}
	cmd := exec.Command(tmp, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Start()
}

func scheduleSelfDelete() {
	if runtime.GOOS != "windows" {
		return
	}
	exe, err := os.Executable()
	if err != nil {
		return
	}
	cmd := exec.Command("cmd", "/c", "ping 127.0.0.1 -n 3 > nul & del /f /q \""+exe+"\"")
	cmd.Start()
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// ------------------------------------------------------------------ install

func installSetup(file string, target Target) error {
	args := []string{"/S"}
	if target.Kind == "installed" && target.Dir != "" && !strings.EqualFold(filepath.Clean(target.Dir), filepath.Clean(defaultInstallDir())) {
		args = append(args, "/D="+target.Dir) // must be last, unquoted (NSIS rule)
	}
	say("installing (silent)...")
	cmd := exec.Command(file, args...)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("installer failed: %v", err)
	}
	return nil
}

func replacePortable(file string, target Target) error {
	old := target.Exe + ".old"
	os.Remove(old)
	ok := waitFor(func() bool { return os.Rename(target.Exe, old) == nil }, 30*time.Second)
	if !ok {
		return fmt.Errorf("can't replace %s (is it still running?)", target.Exe)
	}
	if err := copyFile(file, target.Exe); err != nil {
		os.Rename(old, target.Exe)
		return err
	}
	os.Remove(old)
	return nil
}

// ------------------------------------------------------------------ console UI

var stdin = bufio.NewReader(os.Stdin)
var quiet bool

func say(f string, a ...any) {
	if !quiet {
		fmt.Printf("  "+f+"\n", a...)
	}
}
func warn(f string, a ...any) {
	if !quiet {
		fmt.Printf("  ! "+f+"\n", a...)
	}
}

func ask(q string, def bool) bool {
	hint := "[Y/n]"
	if !def {
		hint = "[y/N]"
	}
	fmt.Printf("  %s %s ", q, hint)
	line, err := stdin.ReadString('\n')
	if err != nil {
		return def
	}
	line = strings.ToLower(strings.TrimSpace(line))
	if line == "" {
		return def
	}
	return line == "y" || line == "yes" || line == "t" || line == "tak"
}

func pause() {
	fmt.Print("\n  press enter to close ")
	stdin.ReadString('\n')
}

func shortErr(err error) string {
	s := err.Error()
	if i := strings.LastIndex(s, ": "); i >= 0 && len(s)-i < 80 {
		return s[i+2:]
	}
	return s
}

// ------------------------------------------------------------------ flags

type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(v string) error { *m = append(*m, v); return nil }

var setFlags = map[string]bool{}

func hasFlag(name string) bool { return setFlags[name] }

func configHasToken(c Config) bool {
	for _, s := range c.Sources {
		if s.Token != "" {
			return true
		}
	}
	return false
}

func parseSources(list []string) []Source {
	var out []Source
	for _, s := range list {
		kind, val, ok := strings.Cut(s, ":")
		if !ok {
			continue
		}
		switch strings.ToLower(kind) {
		case "github":
			out = append(out, Source{Type: "github", Repo: val})
		case "folder":
			out = append(out, Source{Type: "folder", Path: val})
		}
	}
	return out
}

func main() {
	var (
		check      = flag.Bool("check", false, "only check, don't install")
		asJSON     = flag.Bool("json", false, "machine readable output (with --check)")
		yes        = flag.Bool("yes", false, "don't ask, just update")
		waitPid    = flag.Int("wait-pid", 0, "wait for this process to exit first")
		portable   = flag.String("portable", "", "update this portable exe instead of the installed app")
		current    = flag.String("current", "", "current version of the portable exe")
		installDir = flag.String("install-dir", "", "where fuck pdf is installed")
		cfgFile    = flag.String("config", "", "config file (default: %APPDATA%\\fuck pdf\\updater.json, then next to this exe)")
		noRelaunch = flag.Bool("no-relaunch", false, "don't start fuck pdf afterwards")
		fromTemp   = flag.Bool("from-temp", false, "internal")
		selfDelete = flag.Bool("self-delete", false, "internal")
		showVer    = flag.Bool("version", false, "print version")
		sources    multi
	)
	flag.Var(&sources, "source", "github:owner/repo or folder:C:\\path (repeatable, overrides config)")
	flag.Parse()
	flag.Visit(func(f *flag.Flag) { setFlags[f.Name] = true })

	if *showVer {
		fmt.Println(version)
		return
	}
	cfg, cfgPath := loadConfig(*cfgFile)
	if len(sources) > 0 {
		cfg.Sources = parseSources(sources)
	} else if !*fromTemp {
		cfg = withOwnFolder(cfg)
	}
	target := detectTarget(*installDir, *portable, *current)
	kind := target.assetKind()

	// ---- check only (used by the app)
	if *check {
		quiet = *asJSON
		rel, errs := findLatest(cfg, kind)
		res := map[string]any{"kind": target.Kind, "current": "", "latest": "", "available": false, "source": "", "errors": errs}
		if target.HasVer {
			res["current"] = target.Version.String()
		}
		code := 0
		if rel != nil {
			res["latest"] = rel.Version.String()
			res["source"] = rel.Source
			if !target.HasVer || rel.Version.cmp(target.Version) > 0 {
				res["available"] = true
				code = 10
			}
		} else {
			code = 1
		}
		if *asJSON {
			b, _ := json.Marshal(res)
			fmt.Println(string(b))
		} else {
			fmt.Printf("installed: %v\nlatest:    %v (%v)\n", res["current"], res["latest"], res["source"])
			for _, e := range errs {
				fmt.Println("  !", e)
			}
		}
		os.Exit(code)
	}

	// ---- interactive / install
	ownSources = nil
	if !hasFlag("source") && !configHasToken(cfg) {
		ownSources = cfg.Sources
	}
	if runtime.GOOS == "windows" && !*fromTemp {
		if err := relocate(target, cfgPath); err == nil {
			return // the copy in %TEMP% carries on in this console
		}
	}
	if *selfDelete {
		defer scheduleSelfDelete()
	}
	setTitle("fuck pdf updater")
	fmt.Print(banner)
	fmt.Println()
	code := run(cfg, target, kind, *yes, *waitPid, *noRelaunch)
	if code != 0 || !*yes {
		pause()
	} else {
		time.Sleep(2500 * time.Millisecond)
	}
	if *selfDelete {
		scheduleSelfDelete()
	}
	os.Exit(code)
}

func run(cfg Config, target Target, kind string, yes bool, waitPid int, noRelaunch bool) int {
	switch target.Kind {
	case "installed":
		say("installed:  %s   (%s)", target.Version, target.Dir)
	case "portable":
		cur := "unknown"
		if target.HasVer {
			cur = target.Version.String()
		}
		say("portable:   %s   (%s)", cur, target.Exe)
	default:
		say("fuck pdf isn't installed here yet. i can install it.")
	}
	say("looking for updates...")
	rel, errs := findLatest(cfg, kind)
	for _, e := range errs {
		warn("%s", e)
	}
	if rel == nil {
		say("")
		say("couldn't find any release. check your internet or the sources in updater.json.")
		return 1
	}
	say("latest:     %s   (%s)", rel.Version, rel.Source)
	if target.HasVer && rel.Version.cmp(target.Version) <= 0 {
		say("")
		say("you're up to date. nothing to do.")
		return 0
	}
	say("")
	if !yes {
		q := fmt.Sprintf("update to %s?", rel.Version)
		if target.Kind == "none" {
			q = fmt.Sprintf("install fuck pdf %s?", rel.Version)
		}
		if !ask(q, true) {
			say("ok, maybe later.")
			return 0
		}
	}
	asset := rel.asset(kind)
	dir := filepath.Join(os.TempDir(), "fuck-pdf-update")
	os.MkdirAll(dir, 0o755)
	file := filepath.Join(dir, asset.Name)
	part := file + ".part"
	say("downloading %s", asset.Name)
	f, err := os.Create(part)
	if err != nil {
		warn("%v", err)
		return 1
	}
	sum, err := download(asset, f, bar)
	f.Close()
	fmt.Println()
	if err != nil {
		os.Remove(part)
		warn("download failed: %v", err)
		return 1
	}
	if want, ok := rel.Sums[asset.Name]; ok {
		if !strings.EqualFold(want, sum) {
			os.Remove(part)
			warn("checksum mismatch. the file is damaged or tampered with. not installing it.")
			warn("expected %s", want)
			warn("got      %s", sum)
			return 1
		}
		say("sha-256 ok")
	} else {
		warn("no checksum published for %s, can't verify it", asset.Name)
	}
	os.Remove(file)
	if err := os.Rename(part, file); err != nil {
		warn("%v", err)
		return 1
	}
	if err := closeApp(waitPid, yes); err != nil {
		warn("%v", err)
		return 1
	}
	if target.Kind == "portable" {
		if err := replacePortable(file, target); err != nil {
			warn("%v", err)
			return 1
		}
	} else {
		if err := installSetup(file, target); err != nil {
			warn("%v", err)
			return 1
		}
		dir := target.Dir
		if dir == "" {
			dir = defaultInstallDir()
		}
		if v, ok := readInstalledVersion(dir); ok && v.cmp(rel.Version) == 0 {
			target.Exe = filepath.Join(dir, appExe)
		} else if ok {
			warn("installer finished but version is still %s", v)
			return 1
		} else {
			target.Exe = filepath.Join(dir, appExe)
		}
	}
	os.Remove(file)
	say("")
	say("done. fuck pdf %s is installed.", rel.Version)
	if !noRelaunch && target.Exe != "" {
		if err := exec.Command(target.Exe).Start(); err == nil {
			say("starting it...")
		}
	}
	return 0
}
