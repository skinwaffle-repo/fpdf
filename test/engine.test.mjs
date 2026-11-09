// Engine test suite: node test/engine.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as mupdf from "mupdf";
import { Engine, parseRanges } from "../src/engine.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => new Uint8Array(fs.readFileSync(path.join(here, "fixtures", n)));
const outDir = path.join(here, "out");
fs.mkdirSync(outDir, { recursive: true });

let passed = 0, failed = 0;
function test(name, fn) {
	try {
		fn();
		passed++;
		console.log("  ok   " + name);
	} catch (e) {
		failed++;
		console.log("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 3).join("\n       ").slice(0, 600));
	}
}
function eq(a, b, msg = "") { if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }
function ok(v, msg = "assertion failed") { if (!v) throw new Error(msg); }
function reopen(bytes, pw) {
	const d = mupdf.Document.openDocument(bytes, "application/pdf");
	if (pw) d.authenticatePassword(pw);
	return d;
}
function text(doc, i) { return doc.loadPage(i).toStructuredText("preserve-whitespace").asText(); }
const save = (name, bytes) => fs.writeFileSync(path.join(outDir, name), bytes);

const E = new Engine();
console.log("fuck pdf engine tests");

let inv;
test("open pdf + info", () => {
	inv = E.open(fx("invoice.pdf"), "invoice.pdf", "/tmp/invoice.pdf");
	eq(inv.pageCount, 3, "pages");
	eq(inv.meta.Title, "Faktura testowa");
	ok(!inv.dirty, "fresh doc not dirty");
	ok(Math.abs(inv.pages[0].w - 595.27) < 1, "A4 width");
});

test("render RGBA", () => {
	const r = E.render(inv.id, 0, 1);
	eq(r.data.length, r.width * r.height * 4, "rgba size");
	ok(r.data[0] === 255 && r.data[3] === 255, "white opaque background");
});

test("render scale is linear (no double scaling)", () => {
	const firstDark = (r, rowY) => { for (let x = 0; x < r.width; x++) { if (r.data[(rowY * r.width + x) * 4] < 100) return x; } return -1; };
	const r1 = E.render(inv.id, 0, 1), r2 = E.render(inv.id, 0, 2), r3 = E.render(inv.id, 0, 3);
	eq(r2.width, Math.ceil(595.276 * 2), "width");
	const y = 842 - 770 - 8; // middle of the title row, in points
	const a = firstDark(r1, y), b = firstDark(r2, y * 2), c = firstDark(r3, y * 3);
	ok(a > 50 && Math.abs(b - a * 2) <= 3 && Math.abs(c - a * 3) <= 4, `title x at 1x/2x/3x: ${a} ${b} ${c}`);
});

test("page lines + polish text", () => {
	const lines = E.pageLines(inv.id, 0);
	ok(lines.length >= 6, "line count " + lines.length);
	const seller = lines.find((l) => l.text.startsWith("Sprzedawca"));
	ok(seller, "found seller line");
	ok(seller.text.includes("Zażółć"), "polish chars extracted");
	ok(Math.abs(seller.size - 11) < 0.1, "font size 11 got " + seller.size);
	const blue = lines.find((l) => l.text.startsWith("Blue"));
	ok(blue.family === "times", "serif detected: " + blue.family + " " + blue.font);
	ok(blue.color[2] > 0.6, "blue colour detected");
});

test("search", () => {
	const r = E.search(inv.id, "Kowalski");
	eq(r.total, 3, "one hit per page");
	eq(r.results[1].page, 1);
});

test("select text", () => {
	const lines = E.pageLines(inv.id, 0);
	const l = lines.find((x) => x.text.startsWith("Nabywca"));
	const s = E.selectText(inv.id, 0, [l.bbox[0] + 1, (l.bbox[1] + l.bbox[3]) / 2], [l.bbox[2] - 1, (l.bbox[1] + l.bbox[3]) / 2]);
	ok(s.text.includes("Kowalski"), "copied: " + s.text);
	ok(s.quads.length > 0);
});

test("edit existing line keeps neighbours, uses original font", () => {
	const lines = E.pageLines(inv.id, 0);
	const l = lines.find((x) => x.text.startsWith("Termin"));
	const r = E.editLine(inv.id, 0, l, "Termin płatności: 30 dni. Kwota do zapłaty: 9 999,99 zł");
	ok(r.state.dirty, "dirty after edit");
	const t = E.pageText(inv.id, 0);
	ok(t.includes("9 999,99 zł"), "new text present");
	ok(!t.includes("1 234,56"), "old text gone");
	ok(t.includes("Nabywca: Jan Kowalski"), "line above intact");
	ok(t.includes("This line stays untouched"), "line below intact");
	const after = E.pageLines(inv.id, 0).find((x) => x.text.startsWith("Termin"));
	ok(Math.abs(after.bbox[1] - l.bbox[1]) < 2, "same vertical position");
	ok(after.font.includes("DejaVu"), "original font reused: " + after.font);
});

test("edit line with glyphs missing from subset falls back to base font", () => {
	const l = E.pageLines(inv.id, 0).find((x) => x.text.startsWith("Blue"));
	E.editLine(inv.id, 0, l, "QXZ@#~ totally new glyphs ¿¡ ∑");
	const after = E.pageLines(inv.id, 0).find((x) => x.text.startsWith("QXZ"));
	ok(after, "text written");
	ok(after.color[2] > 0.6, "colour kept");
});

test("delete line", () => {
	const l = E.pageLines(inv.id, 1).find((x) => x.text.startsWith("Nabywca"));
	E.deleteLine(inv.id, 1, l);
	ok(!E.pageText(inv.id, 1).includes("Kowalski"), "deleted");
	ok(E.pageText(inv.id, 1).includes("Sprzedawca"), "neighbour kept");
});

const added = {};
test("annotations: every type", () => {
	const q = E.search(inv.id, "Sprzedawca").results[0].hits[0];
	added.hl = E.addAnnot(inv.id, 0, { type: "highlight", quads: q }).result;
	added.ul = E.addAnnot(inv.id, 0, { type: "underline", quads: q, color: [0, 0, 1] }).result;
	added.so = E.addAnnot(inv.id, 0, { type: "strikeout", quads: q }).result;
	added.ink = E.addAnnot(inv.id, 0, { type: "ink", strokes: [[[100, 300], [150, 350], [200, 300]]], color: [0, 0.5, 0], width: 3 }).result;
	added.rect = E.addAnnot(inv.id, 0, { type: "rect", rect: [300, 300, 400, 360], color: [1, 0, 0], width: 2 }).result;
	added.ell = E.addAnnot(inv.id, 0, { type: "ellipse", rect: [420, 300, 520, 360], color: [0, 0, 1], fill: [0.8, 0.8, 1] }).result;
	added.arrow = E.addAnnot(inv.id, 0, { type: "arrow", a: [100, 400], b: [250, 450], color: [0, 0, 0], width: 2 }).result;
	added.note = E.addAnnot(inv.id, 0, { type: "note", point: [540, 60], contents: "Sprawdź to!" }).result;
	added.text = E.addAnnot(inv.id, 0, { type: "text", rect: [60, 460, 400, 490], text: "Dodany tekst ąęłńóśźż", size: 16, color: [0.8, 0, 0] }).result;
	added.img = E.addAnnot(inv.id, 0, { type: "image", rect: [300, 600, 450, 660], bytes: fx("sig.png"), signature: true }).result;
	added.stamp = E.addAnnot(inv.id, 0, { type: "stamp", rect: [60, 680, 220, 730], name: "Approved" }).result;
	added.ts = E.addAnnot(inv.id, 0, { type: "textstamp", rect: [240, 680, 520, 730], text: "FUCK THIS", color: [0.8, 0, 0] }).result;
	added.wo = E.addAnnot(inv.id, 0, { type: "whiteout", rect: [60, 760, 200, 790] }).result;
	const list = E.annotations(inv.id, 0);
	ok(list.length >= 13, "annotation count " + list.length);
	const ft = list.find((a) => a.id === added.text);
	eq(ft.type, "FreeText");
	eq(Math.round(ft.fontSize), 16);
	save("annots.png", E.renderPNG(inv.id, 0, 100));
});

test("move / resize / update / delete annotation", () => {
	const before = E.annotations(inv.id, 0).find((a) => a.id === added.rect).rect;
	E.moveAnnot(inv.id, 0, added.rect, 10, 20);
	const after = E.annotations(inv.id, 0).find((a) => a.id === added.rect).rect;
	ok(Math.abs(after[0] - before[0] - 10) < 0.5 && Math.abs(after[1] - before[1] - 20) < 0.5, "moved");
	E.moveAnnot(inv.id, 0, added.ink, 5, 5);
	E.moveAnnot(inv.id, 0, added.arrow, 5, 5);
	E.moveAnnot(inv.id, 0, added.hl, 0, 30);
	E.resizeAnnot(inv.id, 0, added.img, [300, 600, 500, 700]);
	E.resizeAnnot(inv.id, 0, added.ink, [100, 300, 300, 400]);
	E.updateAnnot(inv.id, 0, added.text, { size: 20, color: [0, 0, 1], contents: "Zmieniony" });
	const ft = E.annotations(inv.id, 0).find((a) => a.id === added.text);
	eq(Math.round(ft.fontSize), 20, "font size");
	eq(ft.contents, "Zmieniony");
	E.moveAnnot(inv.id, 0, added.ts, 0, 10);
	E.resizeAnnot(inv.id, 0, added.ts, [240, 690, 560, 760]);
	E.updateAnnot(inv.id, 0, added.ts, { color: [0, 0, 0.8] });
	save("textstamp.png", E.renderPNG(inv.id, 0, 60));
	E.deleteAnnot(inv.id, 0, added.so);
	ok(!E.annotations(inv.id, 0).some((a) => a.id === added.so), "deleted");
});

test("undo / redo", () => {
	const n = E.annotations(inv.id, 0).length;
	E.undo(inv.id);
	eq(E.annotations(inv.id, 0).length, n + 1, "undo restores deleted annot");
	E.redo(inv.id);
	eq(E.annotations(inv.id, 0).length, n, "redo deletes again");
});

test("redaction: search + apply removes text for real", () => {
	const r = E.markRedactions(inv.id, "Gdańsk");
	eq(r.result, 3, "marks");
	const ap = E.applyRedactions(inv.id);
	eq(ap.result, 3, "applied");
	ok(!E.extractText(inv.id).includes("Gdańsk"), "text is gone from every page");
});

test("forms: fill text, checkbox, choice", () => {
	const f = E.open(fx("form.pdf"), "form.pdf");
	ok(f.hasForms, "has forms");
	const ws = E.widgets(f.id, 0);
	const name = ws.find((w) => w.name === "name");
	const agree = ws.find((w) => w.type === "checkbox");
	const country = ws.find((w) => w.type === "combobox" || w.type === "listbox");
	ok(name && agree && country, "fields found: " + ws.map((w) => w.type).join(","));
	E.setField(f.id, 0, name.id, "Bartosz Ąę");
	E.setField(f.id, 0, agree.id, true);
	E.setField(f.id, 0, country.id, "Ireland");
	const ws2 = E.widgets(f.id, 0);
	eq(ws2.find((w) => w.id === name.id).value, "Bartosz Ąę");
	ok(ws2.find((w) => w.id === agree.id).checked, "checked");
	eq(ws2.find((w) => w.id === country.id).value, "Ireland");
	const bytes = E.saveBytes(f.id);
	const d = new mupdf.PDFDocument(bytes);
	eq(d.loadPage(0).getWidgets().find((w) => w.getName() === "name").getValue(), "Bartosz Ąę", "persisted");
	save("form-filled.pdf", bytes);
	E.flatten(f.id);
	eq(E.widgets(f.id, 0).length, 0, "flattened forms gone");
	ok(E.pageText(f.id, 0).includes("Bartosz"), "value burned into page");
});

test("watermark + header/footer + page text", () => {
	E.watermark(inv.id, { text: "POUFNE / CONFIDENTIAL", opacity: 0.25, angle: 45, color: [1, 0, 0] });
	E.headerFooter(inv.id, { footer: ["{file}", "page {page} of {pages}", "{date}"], header: ["", "", "BATES {bates}"], batesPrefix: "DYN-", size: 9 });
	E.addPageText(inv.id, 2, { x: 60, y: 300, text: "Permanent text łódź\nsecond line", size: 14, family: "times", bold: true });
	const t = E.pageText(inv.id, 1);
	ok(t.includes("page 2 of 3"), "page numbers");
	ok(t.includes("BATES DYN-000002"), "bates");
	ok(t.includes("POUFNE"), "watermark text extractable");
	ok(E.pageText(inv.id, 2).includes("Permanent text łódź"), "page text");
	save("watermarked.png", E.renderPNG(inv.id, 1, 80));
});

test("page ops: rotate, duplicate, insert blank, move, delete, crop", () => {
	E.rotatePages(inv.id, [0], 90);
	eq(E.info(inv.id).pages[0].rotate, 90, "rotated");
	E.rotatePages(inv.id, [0], -90);
	E.duplicatePages(inv.id, [1]);
	eq(E.info(inv.id).pageCount, 4);
	ok(E.pageText(inv.id, 2).includes("FAKTURA VAT nr 2"), "duplicate content");
	E.insertBlank(inv.id, 0);
	eq(E.info(inv.id).pageCount, 5);
	eq(E.pageText(inv.id, 0).trim(), "", "blank first");
	E.movePages(inv.id, [0], 5);
	eq(E.pageText(inv.id, 4).trim(), "", "blank moved to end");
	E.deletePages(inv.id, [4]);
	eq(E.info(inv.id).pageCount, 4);
	E.cropPage(inv.id, [3], [50, 50, 400, 400]);
	const p = E.info(inv.id).pages[3];
	ok(Math.abs(p.w - 350) < 1 && Math.abs(p.h - 350) < 1, "cropped " + p.w + "x" + p.h);
	E.cropPage(inv.id, [3], null);
	ok(E.info(inv.id).pages[3].w > 590, "uncropped");
});

test("merge: insert file + combine + images", () => {
	const before = E.info(inv.id).pageCount;
	E.insertFile(inv.id, -1, fx("form.pdf"), "form.pdf");
	eq(E.info(inv.id).pageCount, before + 1);
	E.insertFile(inv.id, 0, fx("photo.jpg"), "photo.jpg");
	eq(E.info(inv.id).pageCount, before + 2);
	const c = E.combine([{ bytes: fx("form.pdf"), name: "form.pdf" }, { bytes: fx("invoice.pdf"), name: "invoice.pdf" }, { bytes: fx("sig.png"), name: "sig.png" }]);
	eq(c.pageCount, 5);
	const im = E.imagesToPdf([{ bytes: fx("photo.jpg"), name: "photo.jpg" }, { bytes: fx("sig.png"), name: "sig.png" }], "imgs.pdf", { pageSize: "a4" });
	eq(im.pageCount, 2);
	ok(Math.abs(im.pages[0].h - 595.27) < 1, "landscape a4 for wide photo");
	save("images.pdf", E.saveBytes(im.id));
});

test("extract + split", () => {
	const b = E.extractPages(inv.id, [1, 2]);
	eq(reopen(b).countPages(), 2);
	const parts = E.split(inv.id, { every: 2 });
	ok(parts.length >= 2, "split parts");
	const r = E.split(inv.id, { ranges: "1-2;3" });
	eq(r.length, 2);
	eq(reopen(r[1].bytes).countPages(), 1);
});

test("resize pages to letter", () => {
	E.resizePages(inv.id, [1], 612, 792);
	const p = E.info(inv.id).pages[1];
	eq(Math.round(p.w), 612);
	ok(E.pageText(inv.id, 1).length > 20, "content survives");
});

test("insert image as page content", () => {
	E.insertImageContent(inv.id, 1, [100, 100, 250, 160], fx("sig.png"));
	save("image-content.png", E.renderPNG(inv.id, 1, 60));
});

test("metadata", () => {
	E.setMetadata(inv.id, { Title: "Nowy tytuł", Author: "fuck pdf" });
	eq(E.info(inv.id).meta.Title, "Nowy tytuł");
});

test("save: plain, optimized, encrypted, decrypted", () => {
	const plain = E.saveBytes(inv.id);
	const d = reopen(plain);
	ok(!d.needsPassword());
	eq(d.countPages(), E.info(inv.id).pageCount);
	save("edited.pdf", plain);
	const opt = E.saveBytes(inv.id, { optimize: true });
	ok(opt.length <= plain.length, `optimized ${opt.length} <= ${plain.length}`);
	const enc = E.saveBytes(inv.id, { security: "set", userPassword: "tajne", ownerPassword: "owner", permissions: { copy: false, print: true } });
	const de = reopen(enc);
	ok(de.needsPassword(), "needs password");
	ok(de.authenticatePassword("tajne") > 0, "user pw works");
	ok(String(de.getMetaData("encryption")).includes("AES"), "AES");
	save("encrypted.pdf", enc);
	// open encrypted through the engine, then remove security
	const r1 = E.open(enc, "encrypted.pdf");
	ok(r1.needsPassword, "engine asks for password");
	const r2 = E.open(enc, "encrypted.pdf", null, "nope");
	ok(r2.wrongPassword, "wrong pw detected");
	const r3 = E.open(enc, "encrypted.pdf", null, "tajne");
	eq(r3.pageCount, E.info(inv.id).pageCount);
	const kept = E.saveBytes(r3.id, { optimize: true });
	ok(reopen(kept).needsPassword(), "keep security on optimize");
	const removed = E.saveBytes(r3.id, { security: "remove" });
	ok(!reopen(removed).needsPassword(), "security removed");
	const san = E.saveBytes(inv.id, { sanitize: true });
	eq(reopen(san).getMetaData("info:Author") || "", "", "sanitized metadata");
	ok(E.info(inv.id).canUndo, "undo still available after saving");
});

test("export page image + text", () => {
	const png = E.renderPNG(inv.id, 0, 72, "png");
	ok(png[0] === 0x89 && png[1] === 0x50, "png magic");
	const jpg = E.renderPNG(inv.id, 0, 72, "jpg");
	ok(jpg[0] === 0xff && jpg[1] === 0xd8, "jpeg magic");
	ok(E.extractText(inv.id).includes("--- page 1 ---"));
});

test("non-pdf docs convert on open", () => {
	const html = new TextEncoder().encode("<html><body><h1>hello html</h1><p>zażółć</p></body></html>");
	const r = E.open(html, "x.html");
	eq(r.pageCount, 1);
	ok(r.dirty, "converted doc needs saving");
	ok(E.pageText(r.id, 0).includes("hello html"), "text survives");
	const img = E.open(fx("photo.jpg"), "photo.jpg");
	eq(img.pageCount, 1);
});

test("new blank + ranges", () => {
	const b = E.newBlank(595, 842, 2);
	eq(b.pageCount, 2);
	eq(JSON.stringify(parseRanges("1-3, 5, 8-", 9)), JSON.stringify([0, 1, 2, 4, 7, 8]));
	eq(JSON.stringify(parseRanges("odd", 5)), JSON.stringify([0, 2, 4]));
	eq(JSON.stringify(parseRanges("3-1", 5)), JSON.stringify([2, 1, 0]));
});

test("system font index", () => {
	const list = E.systemFonts();
	ok(list.length > 0, "found system fonts");
	const m = E.fonts.match("ABCDEF+DejaVuSans-Bold", { bold: true });
	ok(m && /Bold/.test(m.sub), "matched bold face: " + (m && m.full));
	const l = E.pageLines(inv.id, 2).find((x) => x.text.startsWith("Sprzedawca"));
	E.editLine(inv.id, 2, l, "Sprzedawca: X", { family: list[0].key });
	ok(E.pageText(inv.id, 2).includes("Sprzedawca: X"), "edited with explicit system font");
});

test("dirty tracking + close", () => {
	ok(E.dirtyDocs().some((d) => d.id === inv.id), "listed dirty");
	E.markSaved(inv.id, "/tmp/x.pdf", "x.pdf");
	ok(!E.dirtyDocs().some((d) => d.id === inv.id), "clean after save");
	E.close(inv.id);
	let threw = false;
	try { E.info(inv.id); } catch { threw = true; }
	ok(threw, "closed");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
