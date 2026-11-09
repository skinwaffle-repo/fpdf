// Windows build check: runs the packaged exe in node mode and drives the real engine.
// Linux:   npm run dist:win && npm run test:win   (needs wine)
// Windows: npm run dist:win && set ELECTRON_RUN_AS_NODE=1 && "dist\win-unpacked\fuck pdf.exe" test\win-smoke.mjs
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const app = path.join(root, "dist", "win-unpacked", "resources", "app", "src");
const outDir = path.join(root, "test", "out"); fs.mkdirSync(outDir, { recursive: true });
const report = { platform: process.platform, arch: process.arch, node: process.version, windir: process.env.WINDIR };
const worker = new Worker(path.join(app, "engine-worker.mjs"), { workerData: { fontDirs: [path.join(process.env.WINDIR || "C:\\windows", "Fonts")] } });
let seq = 0; const pending = new Map();
worker.on("message", (m) => { if (m.ready) return; const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error)) : p.res(m.result); });
worker.on("error", (e) => { report.workerError = String(e.stack); fs.writeFileSync(path.join(outDir, "win-smoke.json"), JSON.stringify(report, null, 1)); process.exit(1); });
const call = (method, ...args) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); worker.postMessage({ id, method, args }); });
try {
	const file = path.join(root, "test", "fixtures", "invoice.pdf");
	const info = await call("open", new Uint8Array(fs.readFileSync(file)), "invoice.pdf", file, null);
	report.pages = info.pageCount;
	const lines = await call("pageLines", info.id, 0);
	const t = lines.find((l) => l.text.startsWith("Termin"));
	await call("editLine", info.id, 0, t, "Termin płatności: 30 dni. Kwota do zapłaty: 9 999,99 zł (windows build)");
	report.edited = (await call("pageText", info.id, 0)).includes("9 999,99 zł (windows build)");
	report.fontsIndexed = (await call("systemFonts")).length;
	const r = await call("render", info.id, 0, 2);
	report.render = [r.width, r.height, r.data.length];
	await call("addAnnot", info.id, 0, { type: "textstamp", rect: [300, 600, 540, 660], text: "FUCK THIS", color: [0.8, 0, 0] });
	await call("watermark", info.id, { text: "WINDOWS", opacity: 0.2 });
	fs.writeFileSync(path.join(outDir, "win-smoke.png"), await call("renderPNG", info.id, 0, 100, "png"));
	const enc = await call("saveBytes", info.id, { security: "set", userPassword: "x", optimize: true });
	report.savedEncrypted = enc.length;
	const back = await call("open", enc, "e.pdf", null, "x");
	report.reopenedPages = back.pageCount;
	report.ok = true;
} catch (e) { report.error = String(e.stack || e); }
fs.writeFileSync(path.join(outDir, "win-smoke.json"), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
process.exit(report.ok ? 0 : 1);
