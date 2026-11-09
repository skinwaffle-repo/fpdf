// Produces the README screenshots in docs/screenshots from a scripted session.
import { _electron as electron } from "playwright-core";
import path from "node:path";
import fs from "node:fs";
const root = path.resolve(import.meta.dirname, "../..");
const outDir = path.join(root, "docs/screenshots");
fs.mkdirSync(outDir, { recursive: true });
const W = 1440, H = 900;
const demo = path.join(root, "test/fixtures/demo.pdf");

async function launch(args = []) {
	const app = await electron.launch({ args: ["--no-sandbox", root, ...args], cwd: root });
	await app.evaluate(({ BrowserWindow, shell }, [w, h]) => {
		shell.openExternal = async () => {};
		const win = BrowserWindow.getAllWindows()[0];
		win.unmaximize(); win.setSize(w, h); win.center();
	}, [W, H]);
	const win = await app.firstWindow();
	win.on("pageerror", (e) => console.log("pageerror", e.message));
	await win.waitForTimeout(2200);
	return { app, win };
}
const shot = (win, n) => win.screenshot({ path: path.join(outDir, n + ".png") });
async function pagePt(win, i, x, y, center = true) {
	return win.evaluate(([i, x, y, center]) => {
		const pg = document.querySelector(`.page[data-i="${i}"]`);
		const viewer = document.querySelector("#viewer");
		let r = pg.getBoundingClientRect(); const z = r.width / 595.276; const vr = viewer.getBoundingClientRect();
		const sy = r.top + y * z;
		if (center && (sy < vr.top + 60 || sy > vr.bottom - 60)) { viewer.scrollTop += sy - (vr.top + vr.height / 2); r = pg.getBoundingClientRect(); }
		return [r.left + x * z, r.top + y * z];
	}, [i, x, y, center]);
}
async function drag(win, a, b, steps = 8) {
	await win.mouse.move(a[0], a[1]); await win.mouse.down();
	await win.mouse.move(b[0], b[1], { steps }); await win.mouse.up();
}

// ------------------------------------------------------------ 1. welcome
fs.rmSync(path.join(process.env.HOME, ".config", "fuck pdf"), { recursive: true, force: true });
let { app, win } = await launch();
await shot(win, "welcome");
app.process().kill("SIGKILL");

// ------------------------------------------------------------ 2.. with the demo document
({ app, win } = await launch([demo]));
await win.evaluate(() => document.querySelector("#sb-fitw").click());
await win.waitForTimeout(800);

// edit text: change the total
await win.keyboard.press("e"); await win.waitForTimeout(500);
let p = await pagePt(win, 0, 100, 66);
await win.mouse.click(...p); await win.waitForTimeout(400);
await win.keyboard.press("End"); await win.keyboard.type(" (PAID)"); await win.keyboard.press("Enter");
await win.waitForTimeout(1500);
p = await pagePt(win, 0, 80, 204);
await win.mouse.move(...p); await win.waitForTimeout(200);
await win.mouse.click(...p); await win.waitForTimeout(400);
await win.keyboard.press("End"); await win.keyboard.type("-Nowak (no relation to the goat)");
await win.waitForTimeout(300);
await shot(win, "edit-text");
await win.keyboard.press("Enter"); await win.waitForTimeout(1500);

// markup: highlight a row, circle the total, arrow, note, stamp
await win.keyboard.press("l"); await win.waitForTimeout(200);
await drag(win, await pagePt(win, 0, 57, 338, false), await pagePt(win, 0, 300, 338, false));
await win.waitForTimeout(900);
await win.keyboard.press("o"); await win.waitForTimeout(200);
await drag(win, await pagePt(win, 0, 314, 412, false), await pagePt(win, 0, 550, 446, false));
await win.waitForTimeout(900);
await win.keyboard.press("a"); await win.waitForTimeout(200);
await drag(win, await pagePt(win, 0, 205, 474, false), await pagePt(win, 0, 312, 440, false));
await win.waitForTimeout(900);
await win.keyboard.press("m"); await win.waitForTimeout(300);
await win.evaluate(() => { const i = [...document.querySelectorAll("#props input[type=text]")].find((x) => x.placeholder === "e.g. PAID"); i.value = "PAID, FINALLY"; i.dispatchEvent(new Event("input")); });
await drag(win, await pagePt(win, 0, 60, 455, false), await pagePt(win, 0, 200, 497, false));
await win.waitForTimeout(900);
await win.keyboard.press("n"); await win.waitForTimeout(200);
await win.mouse.click(...(await pagePt(win, 0, 548, 380, false))); await win.waitForTimeout(500);
await win.keyboard.type("why is the goat on the roof though"); await win.click(".modal footer button.primary");
await win.waitForTimeout(900);
await win.keyboard.press("Escape"); await win.keyboard.press("l"); await win.waitForTimeout(300);
await win.evaluate(() => { document.querySelector("#viewer").scrollTop += 120; }); await win.waitForTimeout(700);
await shot(win, "annotate");

// sign: draw a signature on the pad, place it on page 2
await win.keyboard.press("s"); await win.waitForTimeout(600);
const pad = await win.evaluate(() => { const r = document.querySelector(".sig-pad").getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
await win.mouse.move(pad[0] + 40, pad[1] + 120); await win.mouse.down();
for (let t = 0; t <= 1.0001; t += 0.01) {
	const x = pad[0] + 40 + t * 420;
	const y = pad[1] + 95 + Math.sin(t * 22) * 32 * (1 - t * 0.4) - t * 30 + Math.cos(t * 7) * 12;
	await win.mouse.move(x, y);
}
await win.mouse.up();
await win.mouse.move(pad[0] + 120, pad[1] + 140); await win.mouse.down();
await win.mouse.move(pad[0] + 360, pad[1] + 128, { steps: 12 }); await win.mouse.up();
await win.click(".modal footer button.primary"); await win.waitForTimeout(800);
await win.evaluate(() => document.querySelector("#sb-fitp").click()); await win.waitForTimeout(400);
await win.evaluate(() => { const v = document.querySelector("#viewer"); const pg = document.querySelector('.page[data-i="1"]'); v.scrollTop = pg.offsetTop - 14; }); await win.waitForTimeout(900);
await drag(win, await pagePt(win, 1, 325, 598, false), await pagePt(win, 1, 520, 645, false));
await win.waitForTimeout(1200);
await win.keyboard.press("Escape"); await win.waitForTimeout(400);
await shot(win, "sign");

// forms
await win.keyboard.press("v");
await win.evaluate(() => { const v = document.querySelector("#viewer"); const pg = document.querySelector('.page[data-i="2"]'); v.scrollTop = pg.offsetTop - 14; }); await win.waitForTimeout(900);
const fill = async (y, text) => { await win.mouse.click(...(await pagePt(win, 2, 300, y, false))); await win.waitForTimeout(400); await win.keyboard.type(text); await win.keyboard.press("Enter"); await win.waitForTimeout(800); };
await fill(129, "Jan Kowalski");
await fill(175, "jan@example.com");
await fill(221, "Gerald");
await win.mouse.click(...(await pagePt(win, 2, 68, 316, false))); await win.waitForTimeout(900);
await win.mouse.click(...(await pagePt(win, 2, 250, 268, false))); await win.waitForTimeout(500);
await shot(win, "forms");
await win.keyboard.press("Escape");

// pages: select two thumbnails and open the page menu
await win.click('.side-tabs button[data-side="pages"]');
await win.click('.thumb[data-i="0"]'); await win.click('.thumb[data-i="1"]', { modifiers: ["Control"] });
const t = await win.evaluate(() => { const r = document.querySelector('.thumb[data-i="1"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
await win.mouse.click(t[0], t[1], { button: "right" }); await win.waitForTimeout(500);
await shot(win, "pages");
await win.keyboard.press("Escape"); await win.mouse.click(700, 500); await win.waitForTimeout(200);

// protect dialog
await win.evaluate(() => document.querySelector('.tbtn[title="protect with password"]').click()); await win.waitForTimeout(300);
await win.keyboard.type("hunter2"); await win.keyboard.press("Tab"); await win.keyboard.type("hunter2");
await win.waitForTimeout(200);
await shot(win, "protect");
await win.keyboard.press("Escape"); await win.waitForTimeout(200);

// night mode
await win.evaluate(() => document.querySelector("#sb-fitw").click());
await win.keyboard.press("v");
await win.keyboard.press("Escape"); await win.keyboard.press("Escape");
await win.keyboard.press("Control+Shift+n");
await win.click('.thumb[data-i="0"]'); await win.evaluate(() => { document.querySelector("#viewer").scrollTop = 0; });
await win.waitForTimeout(1200);
await shot(win, "night");
await win.keyboard.press("Control+Shift+n");
app.process().kill("SIGKILL");
console.log("screenshots:", fs.readdirSync(outDir).join(", "));
