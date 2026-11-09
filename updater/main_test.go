package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestVersions(t *testing.T) {
	a, _ := parseVersion("v1.10.2")
	b, _ := parseVersion("1.9.9")
	if a.cmp(b) <= 0 {
		t.Fatal("1.10.2 should beat 1.9.9")
	}
	if _, ok := parseVersion("banana"); ok {
		t.Fatal("banana is not a version")
	}
	c, _ := parseVersion("2.0.0-beta.1")
	if c.String() != "2.0.0" {
		t.Fatal(c.String())
	}
}

func TestSums(t *testing.T) {
	s := parseSums("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  fuck-pdf-1.0.0-setup.exe\r\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb *fuck-pdf-1.0.0-portable.exe\n")
	if len(s) != 2 || s["fuck-pdf-1.0.0-portable.exe"][0] != 'b' {
		t.Fatal(s)
	}
}

func TestFolderPicksNewestAndFallsBack(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"fuck-pdf-1.0.0-setup.exe", "fuck-pdf-1.2.0-setup.exe", "fuck-pdf-1.10.0-portable.exe", "fuck-pdf-1.1.0-setup.exe", "random.pdf"} {
		os.WriteFile(filepath.Join(dir, n), []byte(n), 0o644)
	}
	os.Setenv("FPDF_TEST_DIR", dir)
	cfg := Config{Sources: []Source{
		{Type: "github", Repo: "definitely-not/a-real-repo-xyz"},
		{Type: "folder", Path: "%FPDF_TEST_DIR%"},
	}}
	rel, errs := findLatest(cfg, "setup")
	if rel == nil || rel.Version.String() != "1.2.0" {
		t.Fatalf("want 1.2.0 setup, got %v (%v)", rel, errs)
	}
	if len(errs) != 1 {
		t.Fatalf("expected the github source to fail and be reported: %v", errs)
	}
	relP, _ := findLatest(cfg, "portable")
	if relP == nil || relP.Version.String() != "1.10.0" {
		t.Fatalf("want 1.10.0 portable, got %v", relP)
	}
	// download from folder + checksum
	f := filepath.Join(t.TempDir(), "out")
	w, _ := os.Create(f)
	sum, err := download(rel.Setup, w, nil)
	w.Close()
	if err != nil || len(sum) != 64 {
		t.Fatal(err, sum)
	}
}

func TestInstalledDetection(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "resources", "app"), 0o755)
	os.WriteFile(filepath.Join(dir, "resources", "app", "package.json"), []byte(`{"version":"1.1.0"}`), 0o644)
	tg := detectTarget(dir, "", "")
	if tg.Kind != "installed" || tg.Version.String() != "1.1.0" {
		t.Fatal(tg)
	}
	tp := detectTarget("", `C:\x\fuck-pdf-1.1.0-portable.exe`, "1.1.0")
	if tp.Kind != "portable" || tp.assetKind() != "portable" {
		t.Fatal(tp)
	}
}
