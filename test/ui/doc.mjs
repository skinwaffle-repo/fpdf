import { _electron as electron } from "playwright-core";
import path from "node:path";
import fs from "node:fs";
const root = path.resolve(import.meta.dirname, "../..");
const out = path.join(root, "test/out/ui"); fs.mkdirSync(out, { recursive: true });
const fx = (n) => path.join(root, "test/fixtures", n);
const app = await electron.launch({ args: ["--no-sandbox", root, fx("invoice.pdf")], cwd: root });
const win = await app.firstWindow();
const logs = [];
win.on("console", (m) => { if (m.type() !== "log") logs.push(`[${m.type()}] ${m.text()}`); });
win.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
const shot = (n) => win.screenshot({ path: path.join(out, n + ".png") });
const wait = (ms) => win.waitForTimeout(ms);
await wait(2500);
await shot("02-doc");
// page coordinates helper: click at pdf point on page i
async function pagePt(i, x, y) {
  return await win.evaluate(([i, x, y]) => {
    const pg = document.querySelector(`.page[data-i="${i}"]`); const r = pg.getBoundingClientRect();
    const z = r.width / 595.276; return [r.left + x * z, r.top + y * z];
  }, [i, x, y]);
}
// edit text tool: click the "Termin" line (baseline ~ 143.9pt from top, x 60..364)
await win.keyboard.press("e"); await wait(500);
let [x, y] = await pagePt(0, 120, 141);
await win.mouse.move(x, y); await wait(300);
await shot("03-edittext-hover");
await win.mouse.click(x, y); await wait(400);
await shot("04-edittext-editing");
await win.keyboard.press("End");
await win.keyboard.type(" (edited!)");
await win.keyboard.press("Enter"); await wait(1500);
await shot("05-edittext-done");
// highlight: select text with highlight tool
await win.keyboard.press("Escape"); await win.keyboard.press("l"); await wait(200);
[x, y] = await pagePt(0, 62, 159); const [x2, y2] = await pagePt(0, 200, 159);
await win.mouse.move(x, y); await win.mouse.down(); await win.mouse.move((x + x2) / 2, y2, { steps: 4 }); await win.mouse.move(x2, y2, { steps: 4 }); await wait(300); await win.mouse.up(); await wait(1200);
// draw a box
await win.keyboard.press("r"); [x, y] = await pagePt(0, 320, 260); [ , ] = [];
const b2 = await pagePt(0, 520, 330);
await win.mouse.move(x, y); await win.mouse.down(); await win.mouse.move(b2[0], b2[1], { steps: 6 }); await win.mouse.up(); await wait(1000);
// add text
await win.keyboard.press("t"); [x, y] = await pagePt(0, 70, 380);
await win.mouse.click(x, y); await wait(300);
await win.keyboard.type("Zażółć gęślą jaźń - added text");
await win.keyboard.press("Control+Enter"); await wait(1200);
// stamp
await win.keyboard.press("m"); [x, y] = await pagePt(0, 420, 420); await win.mouse.click(x, y); await wait(1000);
// select tool + click the stamp to select it
await win.keyboard.press("v"); await wait(200); await win.mouse.click(x, y); await wait(600);
await shot("06-annots");
// thumbnails + notes tab
await win.click('.side-tabs button[data-side="notes"]'); await wait(800);
await shot("07-notes");
// find bar
await win.keyboard.press("Control+f"); await win.keyboard.type("Kowalski"); await wait(1200);
await shot("08-find");
await win.keyboard.press("Escape");
// menus
await win.click('#menubar > button:nth-child(4)'); await wait(300);
await shot("09-pages-menu");
await win.keyboard.press("Escape"); await win.mouse.click(700, 500);
// watermark dialog
await win.evaluate(() => document.querySelector('.tbtn[title="watermark"]').click()); await wait(400);
await shot("10-watermark-dialog");
await win.click('.modal footer button.primary'); await wait(2000);
await shot("11-watermarked");
// undo twice
await win.keyboard.press("Control+z"); await wait(1500);
await shot("12-undo");
// signature dialog
await win.keyboard.press("s"); await wait(500);
await shot("13-signature");
console.log(logs.join("\n") || "(no console errors)");
app.process().kill("SIGKILL");
