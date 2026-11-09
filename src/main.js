// fuck pdf - Electron main process
// Copyright (C) fuck pdf contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { Worker } = require("node:worker_threads");

const APP_NAME = "fuck pdf";
app.setName(APP_NAME);
if (process.platform === "win32") app.setAppUserModelId("org.fuckpdf.app");
nativeTheme.themeSource = "dark";

const OPENABLE = /\.(pdf|png|jpe?g|gif|bmp|tiff?|webp|pnm|pbm|pgm|ppm|psd|jxr|jpx|jp2|epub|cbz|fb2|mobi|xhtml|html?|txt)$/i;

// ----------------------------------------------------------- single instance

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
}

let win = null;
let pendingOpen = filesFromArgv(process.argv);
let allowClose = false;

function filesFromArgv(argv) {
	return argv.slice(1).filter((a) => !a.startsWith("-") && OPENABLE.test(a) && safeExists(a)).map((a) => path.resolve(a));
}
function safeExists(p) {
	try { return fs.statSync(p).isFile(); } catch { return false; }
}

app.on("second-instance", (_e, argv) => {
	const files = filesFromArgv(argv);
	if (win) {
		if (win.isMinimized()) win.restore();
		win.focus();
		if (files.length) win.webContents.send("open-files", files);
	}
});

app.on("open-file", (e, file) => { // macOS
	e.preventDefault();
	if (win) win.webContents.send("open-files", [file]);
	else pendingOpen.push(file);
});

// ------------------------------------------------------------------- engine

let worker = null;
let seq = 0;
const pending = new Map();

function startWorker() {
	worker = new Worker(path.join(__dirname, "engine-worker.mjs"), {
		workerData: { fontDirs: fontDirs() },
		resourceLimits: { maxOldGenerationSizeMb: 4096 },
	});
	worker.on("message", (msg) => {
		if (msg.ready) return;
		const p = pending.get(msg.id);
		if (!p) return;
		pending.delete(msg.id);
		if (msg.error) {
			const err = new Error(msg.error);
			err.code = msg.code;
			p.reject(err);
		} else p.resolve(msg.result);
	});
	worker.on("error", (e) => {
		console.error("engine worker error:", e);
		for (const p of pending.values()) p.reject(e);
		pending.clear();
		if (win) win.webContents.send("engine-crashed", String(e && e.message || e));
		startWorker();
	});
}

function call(method, ...args) {
	return new Promise((resolve, reject) => {
		const id = ++seq;
		pending.set(id, { resolve, reject });
		worker.postMessage({ id, method, args });
	});
}

function fontDirs() {
	const dirs = [];
	const env = process.env;
	if (process.platform === "win32") {
		dirs.push(path.join(env.WINDIR || "C:\\Windows", "Fonts"));
		if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts"));
	} else if (process.platform === "darwin") {
		dirs.push("/System/Library/Fonts", "/Library/Fonts", path.join(os.homedir(), "Library", "Fonts"));
	} else {
		dirs.push("/usr/share/fonts", "/usr/local/share/fonts", path.join(os.homedir(), ".fonts"), path.join(os.homedir(), ".local", "share", "fonts"));
	}
	return dirs;
}

// ----------------------------------------------------------------- settings

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
let settings = null;
function loadSettings() {
	if (settings) return settings;
	try { settings = JSON.parse(fs.readFileSync(settingsFile(), "utf8")); } catch { settings = {}; }
	settings.recent = Array.isArray(settings.recent) ? settings.recent : [];
	settings.signatures = Array.isArray(settings.signatures) ? settings.signatures : [];
	settings.prefs = settings.prefs || {};
	return settings;
}
function saveSettings() {
	try {
		fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
		fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 1));
	} catch { /* not fatal */ }
}
function addRecent(file) {
	const s = loadSettings();
	s.recent = [file, ...s.recent.filter((f) => f !== file)].slice(0, 15);
	saveSettings();
}

// ------------------------------------------------------------------- window

function createWindow() {
	const s = loadSettings();
	const area = screen.getPrimaryDisplay().workAreaSize;
	const bounds = s.window || { width: Math.min(1440, area.width), height: Math.min(940, area.height) };
	win = new BrowserWindow({
		...bounds,
		minWidth: 860,
		minHeight: 560,
		backgroundColor: "#000000",
		title: APP_NAME,
		icon: path.join(__dirname, "..", "build", process.platform === "win32" ? "icon.ico" : "icon.png"),
		titleBarStyle: "hidden",
		titleBarOverlay: process.platform === "darwin" ? undefined : { color: "#000000", symbolColor: "#ffffff", height: 34 },
		show: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			spellcheck: false,
		},
	});
	if (s.maximized) win.maximize();
	win.removeMenu();
	win.loadFile(path.join(__dirname, "renderer", "index.html"));
	win.once("ready-to-show", () => win.show());

	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/.test(url)) shell.openExternal(url);
		return { action: "deny" };
	});
	win.webContents.on("will-navigate", (e) => e.preventDefault());

	win.on("close", async (e) => {
		const st = loadSettings();
		st.maximized = win.isMaximized();
		if (!st.maximized) st.window = win.getBounds();
		saveSettings();
		if (allowClose) return;
		e.preventDefault();
		let dirty = [];
		try { dirty = await call("dirtyDocs"); } catch { dirty = []; }
		if (!dirty.length) {
			allowClose = true;
			win.close();
			return;
		}
		const r = await dialog.showMessageBox(win, {
			type: "warning",
			title: APP_NAME,
			message: "Unsaved changes",
			detail: "These files have changes that aren't saved:\n\n" + dirty.map((d) => "  " + d.name).join("\n") + "\n\nQuit anyway and lose them?",
			buttons: ["Cancel", "Quit without saving"],
			defaultId: 0,
			cancelId: 0,
			noLink: true,
		});
		if (r.response === 1) {
			allowClose = true;
			win.close();
		}
	});
	win.on("closed", () => { win = null; });
}

app.whenReady().then(() => {
	startWorker();
	createWindow();
	if (process.env.FPDF_SELFTEST) selfTest(process.env.FPDF_SELFTEST, process.env.FPDF_SELFTEST_FILE);
});

// Build verification: FPDF_SELFTEST=<out prefix> FPDF_SELFTEST_FILE=<pdf> "fuck pdf.exe"
// exercises the packaged engine end to end, writes a report and quits.
async function selfTest(out, file) {
	const report = { platform: process.platform, electron: process.versions.electron, steps: [] };
	const step = (n) => { report.steps.push(n); fs.writeFileSync(out + ".json", JSON.stringify(report, null, 1)); };
	const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout: " + what)), ms))]);
	try {
		step("start");
		report.ping = await withTimeout(call("dirtyDocs"), 30000, "engine worker start");
		step("worker ok");
		const info = await withTimeout(call("open", new Uint8Array(fs.readFileSync(file)), path.basename(file), file, null), 30000, "open");
		report.pages = info.pageCount;
		step("opened");
		const lines = await call("pageLines", info.id, 0);
		report.lines = lines.length;
		if (lines.length) {
			await call("editLine", info.id, 0, lines[Math.min(2, lines.length - 1)], "edited by the self test: Zażółć gęślą jaźń");
		}
		step("edited");
		report.systemFonts = (await call("systemFonts")).length;
		step("fonts");
		fs.writeFileSync(out + "-page.png", await call("renderPNG", info.id, 0, 96, "png"));
		const saved = await call("saveBytes", info.id, { security: "set", userPassword: "test" });
		report.encryptedBytes = saved.length;
		await new Promise((r) => setTimeout(r, 6000));
		if (win) fs.writeFileSync(out + "-window.png", (await win.webContents.capturePage()).toPNG());
		report.ok = true;
	} catch (e) {
		report.error = String((e && e.stack) || e);
	}
	fs.writeFileSync(out + ".json", JSON.stringify(report, null, 1));
	allowClose = true;
	app.quit();
}

app.on("window-all-closed", () => {
	if (worker) worker.terminate();
	app.quit();
});

// ---------------------------------------------------------------------- IPC

const FILTERS = {
	open: [
		{ name: "Documents", extensions: ["pdf", "png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp", "epub", "cbz", "fb2", "html", "htm", "xhtml", "txt"] },
		{ name: "PDF", extensions: ["pdf"] },
		{ name: "All files", extensions: ["*"] },
	],
	pdf: [{ name: "PDF", extensions: ["pdf"] }],
	images: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp"] }],
	png: [{ name: "PNG image", extensions: ["png"] }],
	jpg: [{ name: "JPEG image", extensions: ["jpg", "jpeg"] }],
	txt: [{ name: "Text", extensions: ["txt"] }],
};

ipcMain.handle("engine", async (_e, method, args) => {
	try {
		return { ok: true, value: await call(method, ...(args || [])) };
	} catch (e) {
		return { ok: false, error: String(e.message || e), code: e.code || null };
	}
});

ipcMain.handle("file:openDialog", async (_e, opts = {}) => {
	const r = await dialog.showOpenDialog(win, {
		title: opts.title || "Open",
		properties: ["openFile", ...(opts.multi ? ["multiSelections"] : [])],
		filters: FILTERS[opts.kind || "open"] || FILTERS.open,
		defaultPath: opts.defaultPath,
	});
	return r.canceled ? [] : r.filePaths;
});

ipcMain.handle("file:saveDialog", async (_e, opts = {}) => {
	const r = await dialog.showSaveDialog(win, {
		title: opts.title || "Save",
		defaultPath: opts.defaultPath,
		filters: FILTERS[opts.kind || "pdf"] || FILTERS.pdf,
	});
	return r.canceled ? null : r.filePath;
});

ipcMain.handle("file:pickFolder", async (_e, opts = {}) => {
	const r = await dialog.showOpenDialog(win, { title: opts.title || "Choose folder", properties: ["openDirectory", "createDirectory"], defaultPath: opts.defaultPath });
	return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("file:open", async (_e, file, password) => {
	try {
		const bytes = await fs.promises.readFile(file);
		const info = await call("open", new Uint8Array(bytes), path.basename(file), file, password || null);
		if (!info.needsPassword) addRecent(file);
		return { ok: true, value: info };
	} catch (e) {
		return { ok: false, error: String(e.message || e) };
	}
});

ipcMain.handle("file:read", async (_e, file) => {
	const bytes = await fs.promises.readFile(file);
	return { name: path.basename(file), bytes: new Uint8Array(bytes) };
});

async function atomicWrite(file, bytes) {
	const tmp = file + ".fpdf-tmp";
	await fs.promises.writeFile(tmp, bytes);
	try {
		await fs.promises.rename(tmp, file);
	} catch (e) {
		// rename can fail across volumes or when the target is locked; fall back
		await fs.promises.copyFile(tmp, file);
		await fs.promises.unlink(tmp).catch(() => {});
	}
}

ipcMain.handle("file:saveDoc", async (_e, docId, file, opts = {}) => {
	try {
		const bytes = await call("saveBytes", docId, opts);
		await atomicWrite(file, bytes);
		const state = opts.copy ? null : await call("markSaved", docId, file, path.basename(file), opts);
		if (!opts.copy) addRecent(file);
		return { ok: true, value: { state, size: bytes.length, path: file, name: path.basename(file) } };
	} catch (e) {
		return { ok: false, error: String(e.message || e) };
	}
});

ipcMain.handle("file:write", async (_e, file, bytes) => {
	try {
		await atomicWrite(file, Buffer.from(bytes));
		return { ok: true };
	} catch (e) {
		return { ok: false, error: String(e.message || e) };
	}
});

ipcMain.handle("file:writeMany", async (_e, folder, files) => {
	try {
		const written = [];
		for (const f of files) {
			const target = uniquePath(path.join(folder, f.name.replace(/[\\/:*?"<>|]/g, "_")));
			await fs.promises.writeFile(target, Buffer.from(f.bytes));
			written.push(target);
		}
		return { ok: true, value: written };
	} catch (e) {
		return { ok: false, error: String(e.message || e) };
	}
});

function uniquePath(p) {
	if (!fs.existsSync(p)) return p;
	const ext = path.extname(p), base = p.slice(0, -ext.length || undefined);
	for (let i = 2; ; i++) {
		const c = `${base} (${i})${ext}`;
		if (!fs.existsSync(c)) return c;
	}
}

ipcMain.handle("file:exists", (_e, file) => safeExists(file));

ipcMain.handle("app:pendingFiles", () => {
	const f = pendingOpen;
	pendingOpen = [];
	return f;
});

ipcMain.handle("settings:get", () => loadSettings());
ipcMain.handle("settings:set", (_e, patch) => {
	const s = loadSettings();
	Object.assign(s, patch || {});
	saveSettings();
	return s;
});

ipcMain.handle("app:info", () => ({
	version: app.getVersion(),
	electron: process.versions.electron,
	chrome: process.versions.chrome,
	platform: process.platform,
	userData: app.getPath("userData"),
}));

ipcMain.handle("shell:show", (_e, file) => shell.showItemInFolder(file));
ipcMain.handle("shell:openPath", (_e, p) => shell.openPath(p));
ipcMain.handle("shell:external", (_e, url) => {
	if (/^https?:\/\//.test(url)) shell.openExternal(url);
});
ipcMain.handle("app:devtools", () => win && win.webContents.toggleDevTools());
ipcMain.handle("app:fullscreen", () => win && win.setFullScreen(!win.isFullScreen()));
ipcMain.handle("app:quit", () => win && win.close());

ipcMain.handle("app:print", async (_e, docId, opts = {}) => {
	let dir = null;
	try {
		const info = await call("info", docId);
		dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fuckpdf-print-"));
		const pages = opts.pages && opts.pages.length ? opts.pages : info.pages.map((_, i) => i);
		const imgs = [];
		for (const i of pages) {
			const bytes = await call("renderPNG", docId, i, opts.dpi || 200, "jpg", 92);
			const f = path.join(dir, `p${String(i).padStart(5, "0")}.jpg`);
			await fs.promises.writeFile(f, bytes);
			const p = info.pages[i];
			const rot = (p.rotate || 0) % 180 !== 0;
			imgs.push({ f: path.basename(f), landscape: rot ? p.h > p.w : p.w > p.h });
		}
		const html = `<!doctype html><meta charset="utf-8"><style>
@page { margin: 0 }
html, body { margin: 0; padding: 0; background: #fff }
.pg { width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; page-break-after: always; break-after: page; overflow: hidden }
.pg:last-child { page-break-after: auto; break-after: auto }
img { max-width: 100%; max-height: 100%; object-fit: contain }
</style>${imgs.map((i) => `<div class="pg"><img src="${i.f}"></div>`).join("")}`;
		const htmlFile = path.join(dir, "print.html");
		await fs.promises.writeFile(htmlFile, html);
		const pw = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
		await pw.loadFile(htmlFile);
		const landscape = imgs.length && imgs.filter((i) => i.landscape).length > imgs.length / 2;
		const result = await new Promise((resolve) => {
			pw.webContents.print({ silent: false, printBackground: true, landscape, margins: { marginType: "none" } }, (success, reason) => resolve({ success, reason }));
		});
		pw.destroy();
		return { ok: true, value: result };
	} catch (e) {
		return { ok: false, error: String(e.message || e) };
	} finally {
		if (dir) fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
});
