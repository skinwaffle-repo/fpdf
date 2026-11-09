// UI regression: editing light text on a dark band, old text hidden while editing, links.
import { _electron as electron } from "playwright-core";
import path from "node:path";
import fs from "node:fs";
const root = path.resolve(import.meta.dirname, "../..");
const out = path.join(root, "test/out/ui"); fs.mkdirSync(out, { recursive: true });
const app = await electron.launch({ args: ["--no-sandbox", root, path.join(root, "test/fixtures/demo.pdf")], cwd: root });
await app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async (u) => { globalThis.__opened.push(u); }; });
const win = await app.firstWindow();
const errors = [];
win.on("pageerror", (e) => errors.push(e.message));
win.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
const wait = (ms) => win.waitForTimeout(ms);
const shot = (n) => win.screenshot({ path: path.join(out, n + ".png") });
const results = {};
await wait(2500);
async function pagePt(i, x, y) {
	return win.evaluate(([i, x, y]) => {
		const pg = document.querySelector(`.page[data-i="${i}"]`);
		const viewer = document.querySelector("#viewer");
		let r = pg.getBoundingClientRect(); const z = r.width / 595.276;
		const vr = viewer.getBoundingClientRect();
		const sy = r.top + y * z;
		if (sy < vr.top + 40 || sy > vr.bottom - 40) { viewer.scrollTop += sy - (vr.top + vr.height / 2); r = pg.getBoundingClientRect(); }
		return [r.left + x * z, r.top + y * z];
	}, [i, x, y]);
}
// pixel colour under a page point, read from the screen
async function editorStyle() {
	return win.evaluate(() => { const e = document.querySelector(".page .inline-edit"); if (!e) return null; const cs = getComputedStyle(e); return { bg: cs.backgroundColor, fg: cs.color, value: e.value }; });
}
// 1. edit the white INVOICE heading (white text on a near-black band)
await win.keyboard.press("e"); await wait(600);
let [x, y] = await pagePt(0, 100, 66);
await win.mouse.move(x, y); await wait(300);
await win.mouse.click(x, y); await wait(500);
results.whiteHeading = await editorStyle();
await win.keyboard.press("End"); await win.keyboard.type(" (PAID)");
await wait(200);
await shot("20-edit-white-text");
await win.keyboard.press("Enter"); await wait(1800);
// 2. edit the grey line under it
[x, y] = await pagePt(0, 120, 100);
await win.mouse.click(x, y); await wait(500);
results.greyLine = await editorStyle();
await win.keyboard.press("Control+a"); await win.keyboard.type("No. 2026-0114   |   PAID IN FULL");
await shot("21-edit-grey-text");
await win.keyboard.press("Enter"); await wait(1800);
// 3. black body text: the old glyphs must be hidden while editing
[x, y] = await pagePt(0, 80, 204);
await win.mouse.click(x, y); await wait(500);
results.blackLine = await editorStyle();
await win.keyboard.press("Control+a"); await win.keyboard.type("Jo");
await shot("22-edit-black-shorter");
await win.keyboard.press("Escape"); await wait(300);
results.textAfter = await win.evaluate(async () => {
	const id = document.querySelector(".tab.active") ? null : null;
	return null;
});
// 4. links (select tool)
await win.keyboard.press("v"); await wait(300);
[x, y] = await pagePt(0, 90, 842 - 152); // "Terms: see page 2"
await win.mouse.move(x, y); await wait(300);
results.debug = await win.evaluate(() => ({ viewer: document.querySelector("#viewer").className, layerKids: [...document.querySelectorAll(".page .layer > *")].map((n) => n.className + ":" + n.style.top), toasts: [...document.querySelectorAll(".toast")].map((t) => t.textContent) }));
await shot("23-before-link");
results.cursorOverLink = await win.evaluate(() => [...document.querySelectorAll(".page .ov")].some((o) => o.classList.contains("over-link")));
await win.mouse.click(x, y); await wait(800);
results.pageAfterInternalLink = await win.evaluate(() => document.querySelector("#sb-page").value);
[x, y] = await pagePt(0, 120, 842 - 168); // pay online link
await win.mouse.click(x, y); await wait(500);
results.opened = await app.evaluate(() => globalThis.__opened);
// 5. drag across the link still selects text instead of navigating
[x, y] = await pagePt(0, 52, 842 - 168); const [x2] = await pagePt(0, 250, 0);
await win.mouse.move(x, y); await win.mouse.down(); await win.mouse.move(x2, y, { steps: 6 }); await win.mouse.up(); await wait(600);
results.openedAfterDrag = (await app.evaluate(() => globalThis.__opened)).length;
results.errors = errors;
fs.writeFileSync(path.join(out, "edit-links.json"), JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, null, 1));
app.process().kill("SIGKILL");
