// fuck pdf - PDF engine
// Copyright (C) fuck pdf contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// All document work happens here, on top of MuPDF (AGPL, by Artifex).
// This module is pure Node: it runs inside a worker thread in the app
// and directly inside the test suite.

import * as mupdf from "mupdf";
import { FontIndex, defaultFontDirs } from "./fontindex.mjs";

const M = mupdf.Matrix;

// ---------------------------------------------------------------- helpers

const BASE_FONTS = {
	helv: ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"],
	times: ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"],
	cour: ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"],
};
const FREETEXT_FONT = { helv: "Helv", times: "TiRo", cour: "Cour" };

export const STAMP_NAMES = [
	"Approved", "NotApproved", "Draft", "Final", "Confidential", "ForComment",
	"ForPublicRelease", "NotForPublicRelease", "Experimental", "Expired",
	"AsIs", "Sold", "Departmental", "TopSecret",
];

const IMAGE_MAGIC = /\.(png|jpe?g|gif|bmp|tiff?|jxr|jpx|jp2|pnm|pbm|pgm|ppm|pam|psd|webp)$/i;
const OTHER_DOC_MAGIC = /\.(xps|oxps|epub|fb2|cbz|mobi|svg|txt|html?|xhtml)$/i;

function num(n) {
	if (!Number.isFinite(n)) return "0";
	const s = n.toFixed(4);
	return s.replace(/\.?0+$/, "") || "0";
}
function mat(m) { return m.map(num).join(" "); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function errMsg(e) { return String((e && e.message) || e); }

function normRect(r) {
	return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

function rgbOf(color, fallback = [0, 0, 0]) {
	if (!color || !color.length) return fallback;
	if (color.length === 1) return [color[0], color[0], color[0]];
	if (color.length === 4) {
		const [c, m, y, k] = color;
		return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
	}
	return color.slice(0, 3);
}

function stripSubset(name) {
	return String(name || "").replace(/^[A-Z]{6}\+/, "");
}

function familyFromFont(font) {
	const n = stripSubset(font.getName()).toLowerCase();
	if (/courier|mono|consol|code|typewriter/.test(n)) return "cour";
	if (/sans|arial|helvet|verdana|tahoma|calibri|segoe|gothic|grotesk|roboto|inter|open|lato|frutiger|univers|futura/.test(n)) return "helv";
	if (/times|serif|roman|georgia|garamond|cambria|book|minion|palatino|baskerville/.test(n)) return "times";
	if (font.isMono()) return "cour";
	if (font.isSerif()) return "times";
	return "helv";
}

function fontStyleFlags(font) {
	const n = stripSubset(font.getName()).toLowerCase();
	return {
		bold: font.isBold() || /bold|black|heavy|semibold|demi/.test(n),
		italic: font.isItalic() || /italic|oblique/.test(n),
	};
}

// -------------------------------------------------------------- the engine

export class Engine {
	constructor({ fontDirs } = {}) {
		this.docs = new Map();
		this.nextId = 1;
		this.baseFontCache = new Map();
		this.sysFontCache = new Map();
		this.fonts = new FontIndex(fontDirs || defaultFontDirs());
		this._openPages = [];
		this._depth = 0;
		// MuPDF keeps loaded pages (and their annotation/widget lists) cached
		// while any wrapper is alive. Release every page after each public
		// call so the next call always sees the document as it really is.
		for (const name of Object.getOwnPropertyNames(Engine.prototype)) {
			if (name === "constructor" || name.startsWith("_")) continue;
			const fn = this[name];
			if (typeof fn !== "function") continue;
			this[name] = (...args) => {
				this._depth++;
				try {
					return fn.apply(this, args);
				} finally {
					if (--this._depth === 0) this._releasePages();
				}
			};
		}
	}

	_page(rec, index) {
		const p = rec.doc.loadPage(index);
		this._openPages.push(p);
		return p;
	}

	_releasePages() {
		const list = this._openPages;
		this._openPages = [];
		for (const p of list) {
			try { p.destroy(); } catch { /* ignore */ }
		}
	}

	setFontDirs(dirs) {
		this.fonts.setDirs(dirs);
		this.sysFontCache.clear();
		return true;
	}

	systemFonts() {
		return this.fonts.list();
	}

	_sysFont(face) {
		let f = this.sysFontCache.get(face.key);
		if (!f) {
			f = new mupdf.Font(face.ps || face.full, this.fonts.read(face), face.index || 0);
			this.sysFontCache.set(face.key, f);
		}
		return f;
	}

	/** Resolve a font choice: "helv" | "times" | "cour" | "sys:N". */
	_fontFor(family, bold, italic) {
		if (family && family.startsWith("sys:")) {
			const face = this.fonts.byKey(family);
			if (face) {
				try { return this._sysFont(face); } catch { /* fall through */ }
			}
			family = "helv";
		}
		return this._baseFont(family, bold, italic);
	}

	// ---- document bookkeeping

	_rec(id) {
		const r = this.docs.get(id);
		if (!r) throw new Error("No such document (" + id + ")");
		return r;
	}

	_baseFont(family, bold, italic) {
		const names = BASE_FONTS[family] || BASE_FONTS.helv;
		const name = names[(bold ? 1 : 0) + (italic ? 2 : 0)];
		let f = this.baseFontCache.get(name);
		if (!f) {
			f = new mupdf.Font(name);
			this.baseFontCache.set(name, f);
		}
		return f;
	}

	_register(doc, meta) {
		const id = this.nextId++;
		const rec = {
			id, doc,
			name: meta.name || "untitled.pdf",
			path: meta.path || null,
			password: meta.password || null,
			wasEncrypted: false,
			changeCount: 0,
			savedAt: 0,
			version: 1,
			stextCache: new Map(),
			fontRefs: new Map(),
			convertedFrom: meta.convertedFrom || null,
		};
		this.docs.set(id, rec);
		return rec;
	}

	_ready(rec) {
		const doc = rec.doc;
		if (!rec.journalOn) {
			try { doc.enableJournal(); rec.journalOn = true; } catch { rec.journalOn = false; }
		}
		rec.wasEncrypted = !!(doc.getMetaData("encryption") && doc.getMetaData("encryption") !== "None");
	}

	_op(rec, name, fn, { pages = "all", structural = false } = {}) {
		const doc = rec.doc;
		let began = false;
		if (rec.journalOn) { doc.beginOperation(name); began = true; }
		let result;
		try {
			result = fn();
		} catch (e) {
			if (began) { try { doc.abandonOperation(); } catch { /* ignore */ } }
			throw e;
		}
		if (began) doc.endOperation();
		this._releasePages();
		rec.changeCount++;
		rec.version++;
		rec.stextCache.clear();
		return { result, changed: { pages, structural }, state: this._state(rec) };
	}

	_state(rec) {
		const d = rec.doc;
		return {
			version: rec.version,
			dirty: rec.changeCount !== rec.savedAt,
			canUndo: rec.journalOn ? d.canUndo() : false,
			canRedo: rec.journalOn ? d.canRedo() : false,
			pageCount: d.countPages(),
		};
	}

	// ---- opening / creating

	/**
	 * Open bytes. Non-PDF documents (images, XPS, EPUB, CBZ ...) are converted
	 * to PDF on the fly so every editing tool works on them too.
	 */
	open(bytes, name = "document.pdf", path = null, password = null) {
		bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
		if (IMAGE_MAGIC.test(name)) {
			return this.imagesToPdf([{ bytes, name }], name.replace(/\.[^.]+$/, "") + ".pdf");
		}
		let doc;
		try {
			doc = mupdf.Document.openDocument(bytes, name);
		} catch (e) {
			throw new Error("Can't open " + name + ": " + errMsg(e));
		}
		if (doc.needsPassword()) {
			if (!password) return { needsPassword: true, name };
			const ok = doc.authenticatePassword(password);
			if (!ok) return { needsPassword: true, wrongPassword: true, name };
		}
		let pdf = doc.asPDF ? doc.asPDF() : null;
		let convertedFrom = null;
		if (!pdf) {
			pdf = this._convertToPdf(doc);
			convertedFrom = name;
			name = name.replace(/\.[^.]+$/, "") + ".pdf";
			path = null;
		}
		const rec = this._register(pdf, { name, path, password, convertedFrom });
		this._ready(rec);
		if (convertedFrom) rec.changeCount = 1; // needs saving as PDF
		return this.info(rec.id);
	}

	_convertToPdf(doc) {
		const buf = new mupdf.Buffer();
		const writer = new mupdf.DocumentWriter(buf, "pdf", "");
		const n = doc.countPages();
		for (let i = 0; i < n; i++) {
			const page = doc.loadPage(i);
			const dev = writer.beginPage(page.getBounds());
			page.run(dev, M.identity);
			writer.endPage();
		}
		writer.close();
		return new mupdf.PDFDocument(buf.asUint8Array());
	}

	newBlank(width = 595.276, height = 841.89, count = 1) {
		const doc = new mupdf.PDFDocument();
		for (let i = 0; i < count; i++) doc.insertPage(-1, doc.addPage([0, 0, width, height], 0, {}, ""));
		const rec = this._register(doc, { name: "untitled.pdf" });
		this._ready(rec);
		rec.changeCount = 1;
		return this.info(rec.id);
	}

	/** Build a PDF where each image becomes a page (images to PDF). */
	imagesToPdf(images, name = "images.pdf", opts = {}) {
		const doc = new mupdf.PDFDocument();
		for (const { bytes } of images) {
			const img = new mupdf.Image(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
			const xres = img.getXResolution() || 96;
			const yres = img.getYResolution() || 96;
			let w = img.getWidth() * 72 / (xres > 1 ? xres : 96);
			let h = img.getHeight() * 72 / (yres > 1 ? yres : 96);
			let pw = w, ph = h, x = 0, y = 0;
			if (opts.pageSize === "a4") {
				pw = 595.276; ph = 841.89;
				if (w > h) [pw, ph] = [ph, pw];
				const m = opts.margin ?? 24;
				const s = Math.min((pw - 2 * m) / w, (ph - 2 * m) / h);
				w *= s; h *= s; x = (pw - w) / 2; y = (ph - h) / 2;
			}
			const ref = doc.addImage(img);
			const contents = `q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm /Im0 Do Q`;
			doc.insertPage(-1, doc.addPage([0, 0, pw, ph], 0, { XObject: { Im0: ref } }, contents));
		}
		const rec = this._register(doc, { name });
		this._ready(rec);
		rec.changeCount = 1;
		return this.info(rec.id);
	}

	authenticate(id, password) {
		const rec = this._rec(id);
		return rec.doc.authenticatePassword(password);
	}

	close(id) {
		const rec = this.docs.get(id);
		if (!rec) return true;
		rec.stextCache.clear();
		try { rec.doc.destroy(); } catch { /* ignore */ }
		this.docs.delete(id);
		return true;
	}

	dirtyDocs() {
		return [...this.docs.values()].filter((r) => r.changeCount !== r.savedAt).map((r) => ({ id: r.id, name: r.name }));
	}

	setPath(id, path, name) {
		const rec = this._rec(id);
		rec.path = path;
		if (name) rec.name = name;
		return true;
	}

	// ---- inspection

	info(id) {
		const rec = this._rec(id);
		const doc = rec.doc;
		const n = doc.countPages();
		const pages = [];
		let hasForms = false;
		for (let i = 0; i < n; i++) {
			const p = this._page(rec, i);
			const b = p.getBounds();
			let label = "";
			try { label = p.getLabel(); } catch { /* ignore */ }
			let rot = 0;
			try { rot = p.getObject().getInheritable("Rotate").asNumber() || 0; } catch { /* ignore */ }
			if (!hasForms) { try { hasForms = p.getWidgets().length > 0; } catch { /* ignore */ } }
			pages.push({ bounds: b, w: b[2] - b[0], h: b[3] - b[1], label: label || String(i + 1), rotate: rot });
		}
		const meta = {};
		for (const k of ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"]) {
			try { meta[k] = doc.getMetaData("info:" + k) || ""; } catch { meta[k] = ""; }
		}
		let format = "", encryption = "";
		try { format = doc.getMetaData("format") || ""; } catch { /* ignore */ }
		try { encryption = doc.getMetaData("encryption") || ""; } catch { /* ignore */ }
		return {
			id: rec.id, name: rec.name, path: rec.path, convertedFrom: rec.convertedFrom,
			pages, meta, format, encryption, hasForms,
			outline: this._outline(doc),
			...this._state(rec),
		};
	}

	_outline(doc) {
		let items = null;
		try { items = doc.loadOutline(); } catch { return []; }
		const walk = (list) => (list || []).map((it) => {
			let page = typeof it.page === "number" ? it.page : -1;
			if (page < 0 && it.uri) { try { page = doc.resolveLink(it.uri); } catch { /* ignore */ } }
			return { title: it.title || "(untitled)", page, uri: it.uri || null, open: !!it.open, down: walk(it.down) };
		});
		return walk(items);
	}

	// ---- rendering

	/** Render to RGBA pixels on a white background. */
	render(id, index, scale = 1, opts = {}) {
		const rec = this._rec(id);
		const page = this._page(rec, index);
		const b = page.getBounds();
		const ctm = M.scale(scale, scale);
		const x0 = Math.floor(b[0] * scale), y0 = Math.floor(b[1] * scale);
		const x1 = Math.ceil(b[2] * scale), y1 = Math.ceil(b[3] * scale);
		const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [x0, y0, x1, y1], true);
		pix.clear(255);
		// the device matrix is applied on top of the run matrix, so it must be identity here
		const dev = new mupdf.DrawDevice(M.identity, pix);
		try {
			if (opts.annots === false) page.runPageContents(dev, ctm);
			else page.run(dev, ctm);
		} finally {
			dev.close();
		}
		const data = new Uint8ClampedArray(pix.getPixels()); // copy out of wasm heap
		const out = { width: pix.getWidth(), height: pix.getHeight(), data, version: rec.version };
		pix.destroy();
		return out;
	}

	renderPNG(id, index, dpi = 150, format = "png", quality = 90) {
		const rec = this._rec(id);
		const page = this._page(rec, index);
		const s = dpi / 72;
		const pix = page.toPixmap(M.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true);
		pix.setResolution(dpi, dpi);
		const bytes = format === "jpg" || format === "jpeg" ? pix.asJPEG(quality) : pix.asPNG();
		const out = new Uint8Array(bytes);
		pix.destroy();
		return out;
	}

	// ---- text

	_stext(rec, index) {
		const key = index;
		let st = rec.stextCache.get(key);
		if (!st) {
			st = this._page(rec, index).toStructuredText("preserve-whitespace");
			if (rec.stextCache.size > 12) {
				const first = rec.stextCache.keys().next().value;
				rec.stextCache.get(first)?.destroy?.();
				rec.stextCache.delete(first);
			}
			rec.stextCache.set(key, st);
		}
		return st;
	}

	_lines(rec, index, keepFonts = false) {
		const st = this._stext(rec, index);
		const lines = [];
		let line = null;
		st.walk({
			beginLine(bbox, wmode, dir) {
				line = { bbox, dir: dir || [1, 0], wmode, chars: [] };
				lines.push(line);
			},
			onChar(c, origin, font, size, quad, color) {
				line.chars.push({ c, origin, font, size, quad, color });
			},
			endLine() { line = null; },
		});
		return lines.filter((l) => l.chars.length && l.chars.some((c) => c.c.trim())).map((l, i) => {
			const first = l.chars.find((c) => c.c.trim()) || l.chars[0];
			const f = first.font;
			const style = fontStyleFlags(f);
			const out = {
				index: i,
				bbox: l.bbox,
				dir: l.dir,
				text: l.chars.map((c) => c.c).join("").replace(/\s+$/, ""),
				origin: l.chars[0].origin,
				size: first.size,
				color: rgbOf(first.color),
				font: stripSubset(f.getName()),
				family: familyFromFont(f),
				bold: style.bold,
				italic: style.italic,
				quads: l.chars.map((c) => c.quad),
			};
			if (keepFonts) out._font = f;
			return out;
		});
	}

	/** Lines of text with geometry, for the edit-text tool. */
	pageLines(id, index) {
		const rec = this._rec(id);
		return this._lines(rec, index);
	}

	pageText(id, index) {
		const rec = this._rec(id);
		return this._stext(rec, index).asText();
	}

	extractText(id) {
		const rec = this._rec(id);
		const n = rec.doc.countPages();
		const parts = [];
		for (let i = 0; i < n; i++) {
			parts.push(`--- page ${i + 1} ---\n` + this._page(rec, i).toStructuredText("preserve-whitespace").asText());
		}
		return parts.join("\n");
	}

	selectText(id, index, p, q) {
		const rec = this._rec(id);
		const st = this._stext(rec, index);
		return { quads: st.highlight(p, q, 1000), text: st.copy(p, q) };
	}

	selectAll(id, index) {
		const rec = this._rec(id);
		const b = this._page(rec, index).getBounds();
		return this.selectText(id, index, [b[0], b[1]], [b[2], b[3]]);
	}

	search(id, needle, opts = {}) {
		const maxHits = opts.maxHits || 5000;
		const sopts = opts.matchCase ? "" : "ignore-case";
		const rec = this._rec(id);
		const n = rec.doc.countPages();
		const out = [];
		let total = 0;
		if (!needle) return { results: out, total };
		for (let i = 0; i < n && total < maxHits; i++) {
			let hits = [];
			try { hits = this._stext(rec, i).search(needle, sopts); } catch { hits = []; }
			if (hits.length) {
				out.push({ page: i, hits });
				total += hits.length;
			}
		}
		return { results: out, total };
	}

	// ---- annotations

	_annotByNum(page, objnum) {
		for (const a of page.getAnnotations()) {
			if (a.getObject().asIndirect() === objnum) return a;
		}
		throw new Error("Annotation not found (it may have been removed by undo)");
	}

	annotations(id, index) {
		const rec = this._rec(id);
		const page = this._page(rec, index);
		const list = [];
		for (const a of page.getAnnotations()) {
			const type = a.getType();
			if (type === "Popup" || type === "Link" || type === "Widget") continue;
			const o = {
				id: a.getObject().asIndirect(),
				type,
				rect: a.getBounds(),
				color: safe(() => a.getColor(), []),
				opacity: safe(() => a.getOpacity(), 1),
				contents: safe(() => a.getContents(), ""),
				author: safe(() => a.getAuthor(), ""),
			};
			if (safe(() => a.hasInteriorColor(), false)) o.interior = safe(() => a.getInteriorColor(), []);
			if (safe(() => a.hasBorder(), false)) o.width = safe(() => a.getBorderWidth(), 1);
			if (safe(() => a.hasIcon(), false)) o.icon = safe(() => a.getIcon(), "");
			if (type === "FreeText") {
				const da = safe(() => a.getDefaultAppearance(), null);
				if (da) { o.fontSize = da.size; o.font = da.font; o.textColor = da.color; }
			}
			list.push(o);
		}
		return list;
	}

	allAnnotations(id) {
		const rec = this._rec(id);
		const n = rec.doc.countPages();
		const out = [];
		for (let i = 0; i < n; i++) {
			for (const a of this.annotations(id, i)) out.push({ page: i, ...a });
		}
		return out;
	}

	/**
	 * spec.type: highlight | underline | strikeout | squiggly | ink | rect | ellipse
	 *            | line | arrow | note | text | image | stamp | whiteout | redact | textstamp
	 */
	addAnnot(id, index, spec) {
		const rec = this._rec(id);
		return this._op(rec, "add " + spec.type, () => {
			const page = this._page(rec, index);
			const a = this._createAnnot(rec, page, spec);
			a.update();
			return a.getObject().asIndirect();
		}, { pages: [index] });
	}

	_createAnnot(rec, page, spec) {
		const color = spec.color ?? [1, 0, 0];
		const opacity = spec.opacity ?? 1;
		const width = spec.width ?? 2;
		let a;
		switch (spec.type) {
			case "highlight": case "underline": case "strikeout": case "squiggly": {
				const t = { highlight: "Highlight", underline: "Underline", strikeout: "StrikeOut", squiggly: "Squiggly" }[spec.type];
				a = page.createAnnotation(t);
				a.setColor(spec.color ?? (spec.type === "highlight" ? [1, 0.9, 0] : [1, 0, 0]));
				a.setQuadPoints(spec.quads);
				if (spec.type === "highlight") a.setOpacity(spec.opacity ?? 0.5);
				else a.setOpacity(opacity);
				if (spec.contents) a.setContents(spec.contents);
				break;
			}
			case "ink": {
				a = page.createAnnotation("Ink");
				a.setInkList(spec.strokes);
				a.setColor(color);
				a.setBorderWidth(width);
				a.setOpacity(opacity);
				break;
			}
			case "rect": case "ellipse": case "whiteout": {
				a = page.createAnnotation(spec.type === "ellipse" ? "Circle" : "Square");
				a.setRect(normRect(spec.rect));
				if (spec.type === "whiteout") {
					a.setColor([]);
					a.setInteriorColor(spec.fill ?? [1, 1, 1]);
					a.setBorderWidth(0);
					a.setContents("whiteout");
				} else {
					a.setColor(spec.color ?? [1, 0, 0]);
					if (spec.fill && spec.fill.length) a.setInteriorColor(spec.fill);
					a.setBorderWidth(width);
					a.setOpacity(opacity);
				}
				break;
			}
			case "line": case "arrow": {
				a = page.createAnnotation("Line");
				a.setLine(spec.a, spec.b);
				a.setColor(color);
				a.setBorderWidth(width);
				a.setOpacity(opacity);
				if (spec.type === "arrow") a.setLineEndingStyles("None", "ClosedArrow");
				if (spec.type === "arrow") a.setInteriorColor(color);
				break;
			}
			case "note": {
				a = page.createAnnotation("Text");
				const [x, y] = spec.point;
				a.setRect([x, y, x + 20, y + 20]);
				a.setContents(spec.contents || "");
				a.setColor(spec.color ?? [1, 0.85, 0]);
				a.setIcon(spec.icon || "Comment");
				break;
			}
			case "text": {
				a = page.createAnnotation("FreeText");
				a.setRect(normRect(spec.rect));
				a.setContents(spec.text || "");
				const fam = FREETEXT_FONT[spec.family] || "Helv";
				a.setDefaultAppearance(fam, spec.size || 14, rgbOf(spec.color ?? [0, 0, 0]));
				a.setBorderWidth(0);
				if (spec.align) a.setQuadding(spec.align);
				if (opacity !== 1) a.setOpacity(opacity);
				break;
			}
			case "image": {
				a = page.createAnnotation("Stamp");
				a.setRect(normRect(spec.rect));
				const img = new mupdf.Image(spec.bytes instanceof Uint8Array ? spec.bytes : new Uint8Array(spec.bytes));
				a.setStampImage(img);
				a.setContents(spec.contents || (spec.signature ? "signature" : "image"));
				if (opacity !== 1) a.setOpacity(opacity);
				break;
			}
			case "stamp": {
				a = page.createAnnotation("Stamp");
				a.setRect(normRect(spec.rect));
				a.setIcon(spec.name || "Approved");
				break;
			}
			case "textstamp": {
				a = page.createAnnotation("Stamp");
				const r = normRect(spec.rect);
				a.setRect(r);
				a.setContents(spec.text);
				a.setIcon("FPDF");
				a.getObject().put("FPDFStamp", rec.doc.newString(spec.text));
				a.getObject().put("FPDFColor", rgbOf(spec.color ?? [0.85, 0, 0]));
				break;
			}
			case "redact": {
				a = page.createAnnotation("Redact");
				if (spec.quads && spec.quads.length) {
					a.setQuadPoints(spec.quads);
					a.setRect(quadsBounds(spec.quads));
				} else {
					a.setRect(normRect(spec.rect));
				}
				break;
			}
			default:
				throw new Error("Unknown annotation type " + spec.type);
		}
		if (spec.author) { try { a.setAuthor(spec.author); } catch { /* ignore */ } }
		try { a.setModificationDate(new Date()); } catch { /* ignore */ }
		this._refreshCustom(rec, a);
		return a;
	}

	/** Custom text stamps carry their own appearance; rebuild it after geometry changes. */
	_refreshCustom(rec, a) {
		const o = a.getObject();
		const t = o.get("FPDFStamp");
		if (t.isNull()) return;
		const c = o.get("FPDFColor");
		const color = c.isArray() ? [0, 1, 2].map((i) => c.get(i).asNumber()) : [0.85, 0, 0];
		this._textStampAppearance(rec, a, a.getRect(), t.asString(), color);
	}

	_textStampAppearance(rec, annot, rect, text, color) {
		const w = rect[2] - rect[0], h = rect[3] - rect[1];
		const font = this._baseFont("helv", true, false);
		const fref = rec.doc.addFont(font);
		const { hex, width } = encodeText(font, text);
		const size = Math.max(4, Math.min(h * 0.6, (w - 12) / Math.max(width, 0.01)));
		const tw = width * size;
		const tx = (w - tw) / 2, ty = (h - size * 0.7) / 2;
		const bw = Math.max(1.5, Math.min(w, h) * 0.05);
		const [r, g, b] = color;
		const contents = [
			`q ${num(r)} ${num(g)} ${num(b)} RG ${num(bw)} w`,
			`${num(bw / 2)} ${num(bw / 2)} ${num(w - bw)} ${num(h - bw)} re S Q`,
			`q BT ${num(r)} ${num(g)} ${num(b)} rg /F1 ${num(size)} Tf ${num(tx)} ${num(ty)} Td <${hex}> Tj ET Q`,
		].join("\n");
		annot.setAppearance(null, null, M.identity, [0, 0, w, h], { Font: { F1: fref } }, contents);
	}

	moveAnnot(id, index, objnum, dx, dy) {
		const rec = this._rec(id);
		return this._op(rec, "move annotation", () => {
			const page = this._page(rec, index);
			const a = this._annotByNum(page, objnum);
			const t = a.getType();
			if (t === "Ink") {
				a.setInkList(a.getInkList().map((s) => s.map(([x, y]) => [x + dx, y + dy])));
			} else if (t === "Line") {
				const [p, q] = a.getLine();
				a.setLine([p[0] + dx, p[1] + dy], [q[0] + dx, q[1] + dy]);
			} else if (a.hasQuadPoints() && a.getQuadPoints().length) {
				a.setQuadPoints(a.getQuadPoints().map((q) => q.map((v, i) => v + (i % 2 ? dy : dx))));
				if (t === "Redact") a.setRect(quadsBounds(a.getQuadPoints()));
			} else if (a.hasVertices && a.hasVertices()) {
				a.setVertices(a.getVertices().map(([x, y]) => [x + dx, y + dy]));
			} else {
				const r = a.getRect();
				a.setRect([r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]);
			}
			this._refreshCustom(rec, a);
			a.update();
			return objnum;
		}, { pages: [index] });
	}

	resizeAnnot(id, index, objnum, rect) {
		const rec = this._rec(id);
		return this._op(rec, "resize annotation", () => {
			const page = this._page(rec, index);
			const a = this._annotByNum(page, objnum);
			const t = a.getType();
			const r = normRect(rect);
			if (t === "Ink") {
				const old = a.getBounds();
				const sx = (r[2] - r[0]) / Math.max(1e-3, old[2] - old[0]);
				const sy = (r[3] - r[1]) / Math.max(1e-3, old[3] - old[1]);
				a.setInkList(a.getInkList().map((s) => s.map(([x, y]) => [r[0] + (x - old[0]) * sx, r[1] + (y - old[1]) * sy])));
			} else if (t === "Line") {
				const old = a.getBounds();
				const sx = (r[2] - r[0]) / Math.max(1e-3, old[2] - old[0]);
				const sy = (r[3] - r[1]) / Math.max(1e-3, old[3] - old[1]);
				const [p, q] = a.getLine();
				const f = ([x, y]) => [r[0] + (x - old[0]) * sx, r[1] + (y - old[1]) * sy];
				a.setLine(f(p), f(q));
			} else if (a.hasRect()) {
				a.setRect(r);
			}
			this._refreshCustom(rec, a);
			a.update();
			return objnum;
		}, { pages: [index] });
	}

	updateAnnot(id, index, objnum, props) {
		const rec = this._rec(id);
		return this._op(rec, "edit annotation", () => {
			const page = this._page(rec, index);
			const a = this._annotByNum(page, objnum);
			const t = a.getType();
			if (props.color !== undefined) {
				if (t === "FreeText") {
					const da = a.getDefaultAppearance();
					a.setDefaultAppearance(da.font || "Helv", props.size ?? da.size ?? 12, rgbOf(props.color));
				} else if (!(t === "Square" && a.getContents() === "whiteout")) {
					a.setColor(props.color);
					if (t === "Line" && a.hasInteriorColor()) a.setInteriorColor(props.color);
				}
			}
			if (props.fill !== undefined && a.hasInteriorColor()) a.setInteriorColor(props.fill || []);
			if (props.opacity !== undefined) a.setOpacity(clamp(props.opacity, 0.05, 1));
			if (props.width !== undefined && a.hasBorder()) a.setBorderWidth(props.width);
			if (props.contents !== undefined) a.setContents(props.contents);
			if (t === "FreeText" && (props.size !== undefined || props.family !== undefined)) {
				const da = a.getDefaultAppearance();
				const fam = props.family ? (FREETEXT_FONT[props.family] || "Helv") : (da.font || "Helv");
				a.setDefaultAppearance(fam, props.size ?? da.size ?? 12, props.color ? rgbOf(props.color) : (da.color || [0, 0, 0]));
			}
			if (t === "FreeText" && props.rect) a.setRect(normRect(props.rect));
			if (t === "Stamp" && props.color !== undefined && !a.getObject().get("FPDFStamp").isNull()) a.getObject().put("FPDFColor", rgbOf(props.color));
			try { a.setModificationDate(new Date()); } catch { /* ignore */ }
			this._refreshCustom(rec, a);
			a.update();
			return objnum;
		}, { pages: [index] });
	}

	deleteAnnot(id, index, objnum) {
		const rec = this._rec(id);
		return this._op(rec, "delete annotation", () => {
			const page = this._page(rec, index);
			page.deleteAnnotation(this._annotByNum(page, objnum));
			return true;
		}, { pages: [index] });
	}

	/** Permanently remove everything under redaction marks. */
	applyRedactions(id, pages = null) {
		const rec = this._rec(id);
		const n = rec.doc.countPages();
		const list = pages || [...Array(n).keys()];
		let count = 0;
		const touched = [];
		const res = this._op(rec, "apply redactions", () => {
			for (const i of list) {
				const page = this._page(rec, i);
				const marks = page.getAnnotations().filter((a) => a.getType() === "Redact");
				if (!marks.length) continue;
				count += marks.length;
				touched.push(i);
				page.applyRedactions(true, mupdf.PDFPage.REDACT_IMAGE_PIXELS, mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, mupdf.PDFPage.REDACT_TEXT_REMOVE);
			}
			return count;
		});
		res.changed.pages = touched;
		return res;
	}

	/** Mark every occurrence of a phrase for redaction. */
	markRedactions(id, needle, opts = {}) {
		const rec = this._rec(id);
		const found = this.search(id, needle, opts).results;
		let count = 0;
		const res = this._op(rec, "mark redactions", () => {
			for (const { page: i, hits } of found) {
				const page = this._page(rec, i);
				for (const quads of hits) {
					const a = page.createAnnotation("Redact");
					a.setQuadPoints(quads);
					a.setRect(quadsBounds(quads));
					a.update();
					count++;
				}
			}
			return count;
		});
		res.changed.pages = found.map((f) => f.page);
		return res;
	}

	// ---- forms

	widgets(id, index) {
		const rec = this._rec(id);
		const page = this._page(rec, index);
		return page.getWidgets().map((w) => {
			const type = safe(() => w.getFieldType(), "unknown");
			const o = {
				id: w.getObject().asIndirect(),
				type,
				name: safe(() => w.getName(), ""),
				label: safe(() => w.getLabel(), ""),
				value: safe(() => w.getValue(), ""),
				rect: w.getBounds(),
				readOnly: safe(() => w.isReadOnly(), false),
			};
			if (type === "text") {
				o.multiline = safe(() => w.isMultiline(), false);
				o.password = safe(() => w.isPassword(), false);
				o.maxLen = safe(() => w.getMaxLen(), 0);
				const da = safe(() => w.getDefaultAppearance(), null);
				o.fontSize = da ? da.size : 0;
			}
			if (type === "combobox" || type === "listbox") o.options = safe(() => w.getOptions(), []);
			if (type === "checkbox" || type === "radiobutton") o.checked = o.value && o.value !== "Off";
			return o;
		});
	}

	setField(id, index, objnum, value) {
		const rec = this._rec(id);
		return this._op(rec, "fill form", () => {
			const page = this._page(rec, index);
			const w = page.getWidgets().find((x) => x.getObject().asIndirect() === objnum);
			if (!w) throw new Error("Form field not found");
			const type = w.getFieldType();
			if (type === "text") w.setTextValue(String(value ?? ""));
			else if (type === "combobox" || type === "listbox") w.setChoiceValue(String(value ?? ""));
			else if (type === "checkbox" || type === "radiobutton") {
				const on = w.getValue() && w.getValue() !== "Off";
				if (value === "toggle" || !!value !== on) w.toggle();
			}
			w.update();
			page.update();
			return w.getValue();
		}, { pages: "all" }); // fields can share values across pages
	}

	resetForm(id) {
		const rec = this._rec(id);
		return this._op(rec, "reset form", () => {
			const n = rec.doc.countPages();
			for (let i = 0; i < n; i++) {
				const page = this._page(rec, i);
				for (const w of page.getWidgets()) {
					const t = w.getFieldType();
					try {
						if (t === "text") w.setTextValue("");
						else if ((t === "checkbox" || t === "radiobutton") && w.getValue() && w.getValue() !== "Off") w.toggle();
						w.update();
					} catch { /* ignore */ }
				}
				page.update();
			}
			return true;
		});
	}

	// ---- editing existing page text

	/**
	 * Replace one line of existing text. The old glyphs are truly removed
	 * (redaction, no black box) and the new text is written in the same
	 * spot, in the original embedded font when it has every glyph needed,
	 * otherwise in the closest standard font.
	 */
	editLine(id, index, target, newText, opts = {}) {
		const rec = this._rec(id);
		const lines = this._lines(rec, index, true);
		const line = matchLine(lines, target);
		if (!line) throw new Error("Couldn't find that line any more. Try again.");
		return this._op(rec, "edit text", () => {
			const page = this._page(rec, index);
			// 1) remove the old glyphs
			const red = page.createAnnotation("Redact");
			red.setRect(line.bbox);
			red.setQuadPoints(line.quads.map((q) => shrinkQuad(q, 0.12)));
			red.applyRedaction(0, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
			// 2) write the replacement
			if (newText && newText.trim()) {
				const size = opts.size || line.size;
				const color = opts.color || line.color;
				let font = null;
				const wantOriginal = !opts.family || opts.family === "original";
				const bold = opts.bold ?? line.bold, italic = opts.italic ?? line.italic;
				const styleChanged = (opts.bold != null && opts.bold !== line.bold) || (opts.italic != null && opts.italic !== line.italic);
				if (wantOriginal && !styleChanged && fontCovers(line._font, newText)) font = line._font;
				if (!font && wantOriginal) {
					// the embedded font is a subset: use the full installed font
					const face = this.fonts.match(line.font, { bold, italic });
					if (face) {
						try {
							const f = this._sysFont(face);
							if (fontCovers(f, newText)) font = f;
						} catch { /* ignore */ }
					}
				}
				if (!font) font = this._fontFor(wantOriginal ? line.family : opts.family, bold, italic);
				const [dx, dy] = normDir(line.dir);
				const tm = [dx * size, dy * size, dy * size, -dx * size, line.origin[0], line.origin[1]];
				this._drawText(rec, page, [{ font, text: newText, tm, color }]);
			}
			return { font: line._font ? stripSubset(line._font.getName()) : "" };
		}, { pages: [index] });
	}

	/** Remove a line of text entirely (true deletion). */
	deleteLine(id, index, target) {
		return this.editLine(id, index, target, "");
	}

	// ---- content stream writing

	_fontRef(rec, font) {
		const key = font;
		const cached = rec.fontRefs.get(key);
		if (cached) {
			try {
				if (cached.resolve().get("Type").asName() === "Font") return cached;
			} catch { /* stale after undo */ }
		}
		const ref = rec.doc.addFont(font);
		rec.fontRefs.set(key, ref);
		return ref;
	}

	_resources(rec, pageObj) {
		let res = pageObj.get("Resources");
		if (!res.isDictionary()) {
			const inh = pageObj.getInheritable("Resources");
			res = rec.doc.newDictionary();
			if (inh.isDictionary()) inh.forEach((v, k) => res.put(k, v));
			pageObj.put("Resources", res);
		}
		const sub = (key) => {
			let d = res.get(key);
			if (!d.isDictionary()) {
				d = rec.doc.newDictionary();
				res.put(key, d);
			}
			return d;
		};
		return { res, sub };
	}

	_uniqueName(dict, prefix) {
		for (let i = 0; ; i++) {
			const name = prefix + i;
			if (dict.get(name).isNull()) return name;
		}
	}

	/**
	 * Append (or prepend) a content stream to a page. `body` receives
	 * a helper and returns operators drawn in page (fitz, y-down) space.
	 */
	_appendContent(rec, page, body, { under = false } = {}) {
		const doc = rec.doc;
		const pobj = page.getObject();
		const { sub } = this._resources(rec, pageObjResolved(pobj));
		const fonts = sub("Font");
		const gs = sub("ExtGState");
		const xo = sub("XObject");
		const helper = {
			font: (font) => {
				const name = this._uniqueName(fonts, "FPDF_F");
				fonts.put(name, this._fontRef(rec, font));
				return name;
			},
			alpha: (a) => {
				const name = this._uniqueName(gs, "FPDF_GS");
				const d = doc.newDictionary();
				d.put("Type", doc.newName("ExtGState"));
				d.put("ca", a);
				d.put("CA", a);
				gs.put(name, d);
				return name;
			},
			image: (img) => {
				const name = this._uniqueName(xo, "FPDF_Im");
				xo.put(name, doc.addImage(img));
				return name;
			},
		};
		const inv = M.invert(page.getTransform());
		const ops = `q ${mat(inv)} cm\n${body(helper)}\nQ\n`;
		const contents = pobj.get("Contents");
		const old = [];
		if (contents.isArray()) contents.forEach((v) => old.push(v));
		else if (!contents.isNull()) old.push(contents);
		const isWrapped = old.length >= 2 && safe(() => old[0].resolve().get("FPDFWrap").asBoolean(), false);
		const arr = doc.newArray();
		if (under) {
			arr.push(doc.addStream(ops, {}));
			for (const o of old) arr.push(o);
		} else if (isWrapped) {
			for (const o of old) arr.push(o);
			arr.push(doc.addStream(ops, {}));
		} else {
			arr.push(doc.addStream("q\n", { FPDFWrap: true }));
			for (const o of old) arr.push(o);
			arr.push(doc.addStream("Q\n" + ops, {}));
		}
		pobj.put("Contents", arr);
	}

	_drawText(rec, page, runs, { under = false } = {}) {
		this._appendContent(rec, page, (h) => {
			let out = "";
			for (const run of runs) {
				const fname = h.font(run.font);
				const [r, g, b] = rgbOf(run.color);
				const gsName = run.opacity != null && run.opacity < 1 ? h.alpha(run.opacity) : null;
				const { tj } = encodeText(run.font, run.text);
				out += "q " + (gsName ? `/${gsName} gs ` : "") + `${num(r)} ${num(g)} ${num(b)} rg BT /${fname} 1 Tf ${mat(run.tm)} Tm ${tj} TJ ET Q\n`;
			}
			return out;
		}, { under });
	}

	/** Write new permanent text onto a page (not an annotation). */
	addPageText(id, index, spec) {
		const rec = this._rec(id);
		return this._op(rec, "add text", () => {
			const page = this._page(rec, index);
			const font = this._fontFor(spec.family || "helv", spec.bold, spec.italic);
			const size = spec.size || 12;
			const lines = String(spec.text).split(/\r?\n/);
			const lh = size * (spec.lineHeight || 1.2);
			const runs = lines.map((t, i) => ({
				font, text: t, color: spec.color || [0, 0, 0], opacity: spec.opacity,
				tm: [size, 0, 0, -size, spec.x, spec.y + size * 0.8 + i * lh],
			}));
			this._drawText(rec, page, runs);
			return true;
		}, { pages: [index] });
	}

	measureText(family, bold, italic, text, size) {
		const font = this._fontFor(family, bold, italic);
		return encodeText(font, text).width * size;
	}

	// ---- watermark / header & footer / page numbers

	_pageList(rec, pages) {
		const n = rec.doc.countPages();
		if (!pages || pages === "all") return [...Array(n).keys()];
		if (typeof pages === "string") return parseRanges(pages, n);
		return pages.filter((i) => i >= 0 && i < n);
	}

	watermark(id, opts) {
		const rec = this._rec(id);
		const list = this._pageList(rec, opts.pages);
		const res = this._op(rec, "watermark", () => {
			const font = this._fontFor(opts.family || "helv", opts.bold ?? true, opts.italic ?? false);
			const text = String(opts.text || "CONFIDENTIAL");
			const { width } = encodeText(font, text);
			const angle = ((opts.angle ?? 45) * Math.PI) / 180;
			for (const i of list) {
				const page = this._page(rec, i);
				const b = page.getBounds();
				const pw = b[2] - b[0], ph = b[3] - b[1];
				let size = opts.size || 0;
				if (!size) {
					const diag = Math.abs(Math.cos(angle)) * pw + Math.abs(Math.sin(angle)) * ph;
					size = Math.max(8, (diag * 0.7) / Math.max(width, 0.01));
					size = Math.min(size, ph * 0.5);
				}
				const tw = width * size;
				const cx = b[0] + pw / 2, cy = b[1] + ph / 2;
				const dx = Math.cos(angle), dy = -Math.sin(angle);
				// start point so the text is centred on (cx, cy)
				const ox = cx - dx * tw / 2 + dy * size * 0.35;
				const oy = cy - dy * tw / 2 - dx * size * 0.35;
				const tm = [dx * size, dy * size, dy * size, -dx * size, ox, oy];
				this._drawText(rec, page, [{ font, text, tm, color: opts.color || [0.5, 0.5, 0.5], opacity: opts.opacity ?? 0.3 }], { under: !!opts.under });
			}
			return list.length;
		});
		res.changed.pages = list;
		return res;
	}

	/**
	 * Headers, footers, page numbers and Bates numbers.
	 * opts: { header: [l,c,r], footer: [l,c,r], size, color, margin, family, start, pages }
	 * tokens: {page} {pages} {date} {file} {bates}
	 */
	headerFooter(id, opts) {
		const rec = this._rec(id);
		const list = this._pageList(rec, opts.pages);
		const total = rec.doc.countPages();
		const res = this._op(rec, "header & footer", () => {
			const font = this._fontFor(opts.family || "helv", !!opts.bold, false);
			const size = opts.size || 10;
			const margin = opts.margin ?? 28;
			const date = new Date().toLocaleDateString(opts.locale || "en-GB");
			const start = opts.start ?? 1;
			const bdigits = opts.batesDigits || 6;
			const bprefix = opts.batesPrefix || "";
			list.forEach((i, k) => {
				const page = this._page(rec, i);
				const b = page.getBounds();
				const sub = (s) => String(s || "")
					.replaceAll("{page}", String(start + i))
					.replaceAll("{pages}", String(total + start - 1))
					.replaceAll("{date}", date)
					.replaceAll("{file}", rec.name)
					.replaceAll("{bates}", bprefix + String((opts.batesStart ?? 1) + k).padStart(bdigits, "0"));
				const runs = [];
				const place = (texts, y) => {
					(texts || []).forEach((t, slot) => {
						const s = sub(t);
						if (!s) return;
						const w = encodeText(font, s).width * size;
						const x = slot === 0 ? b[0] + margin : slot === 1 ? (b[0] + b[2]) / 2 - w / 2 : b[2] - margin - w;
						runs.push({ font, text: s, tm: [size, 0, 0, -size, x, y], color: opts.color || [0, 0, 0] });
					});
				};
				place(opts.header, b[1] + margin + size * 0.8);
				place(opts.footer, b[3] - margin);
				if (runs.length) this._drawText(rec, page, runs);
			});
			return list.length;
		});
		res.changed.pages = list;
		return res;
	}

	// ---- page operations

	rotatePages(id, pages, delta) {
		const rec = this._rec(id);
		const list = this._pageList(rec, pages);
		return this._op(rec, "rotate", () => {
			for (const i of list) {
				const o = this._page(rec, i).getObject();
				const cur = safe(() => o.getInheritable("Rotate").asNumber(), 0) || 0;
				o.put("Rotate", (((cur + delta) % 360) + 360) % 360);
			}
			return list.length;
		}, { pages: list, structural: true });
	}

	deletePages(id, pages) {
		const rec = this._rec(id);
		const list = [...new Set(this._pageList(rec, pages))].sort((a, b) => b - a);
		if (list.length >= rec.doc.countPages()) throw new Error("Can't delete every page. A PDF needs at least one.");
		return this._op(rec, "delete pages", () => {
			for (const i of list) rec.doc.deletePage(i);
			return list.length;
		}, { structural: true });
	}

	/** order: array of current page indices in the new order (may repeat or omit). */
	reorderPages(id, order) {
		const rec = this._rec(id);
		return this._op(rec, "reorder pages", () => {
			rec.doc.rearrangePages(order);
			return order.length;
		}, { structural: true });
	}

	movePages(id, pages, to) {
		const rec = this._rec(id);
		const n = rec.doc.countPages();
		const moving = [...new Set(pages)].sort((a, b) => a - b);
		const rest = [...Array(n).keys()].filter((i) => !moving.includes(i));
		const before = [...Array(n).keys()].slice(0, to).filter((i) => !moving.includes(i)).length;
		const order = [...rest.slice(0, before), ...moving, ...rest.slice(before)];
		const res = this.reorderPages(id, order);
		res.result = { from: moving, to: before, count: moving.length };
		return res;
	}

	insertBlank(id, at, width, height, count = 1) {
		const rec = this._rec(id);
		return this._op(rec, "insert blank page", () => {
			const n = rec.doc.countPages();
			let w = width, h = height;
			if (!w || !h) {
				const ref = this._page(rec, clamp(at - 1, 0, n - 1)).getBounds();
				w = ref[2] - ref[0]; h = ref[3] - ref[1];
			}
			for (let k = 0; k < count; k++) {
				rec.doc.insertPage(clamp(at + k, 0, n + k), rec.doc.addPage([0, 0, w, h], 0, {}, ""));
			}
			return count;
		}, { structural: true });
	}

	duplicatePages(id, pages) {
		const rec = this._rec(id);
		const list = this._pageList(rec, pages).sort((a, b) => a - b);
		return this._op(rec, "duplicate pages", () => {
			let shift = 0;
			for (const i of list) {
				const src = i + shift;
				rec.doc.graftPage(src + 1, rec.doc, src);
				shift++;
			}
			return list.length;
		}, { structural: true });
	}

	/** Insert pages from another file (merge). */
	insertFile(id, at, bytes, name = "file.pdf", password = null, pageRange = null) {
		const rec = this._rec(id);
		const src = this._openSource(bytes, name, password);
		const n = src.countPages();
		const list = pageRange ? parseRanges(pageRange, n) : [...Array(n).keys()];
		const res = this._op(rec, "insert pages", () => {
			const map = rec.doc.newGraftMap();
			let pos = at < 0 ? rec.doc.countPages() : at;
			for (const i of list) map.graftPage(pos++, src, i);
			return list.length;
		}, { structural: true });
		try { src.destroy(); } catch { /* ignore */ }
		return res;
	}

	_openSource(bytes, name, password) {
		bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
		if (IMAGE_MAGIC.test(name)) {
			const info = this.imagesToPdf([{ bytes, name }]);
			const r = this.docs.get(info.id);
			this.docs.delete(info.id);
			return r.doc;
		}
		let doc = mupdf.Document.openDocument(bytes, name);
		if (doc.needsPassword()) {
			if (!password || !doc.authenticatePassword(password)) {
				const e = new Error("PASSWORD_REQUIRED:" + name);
				e.code = "PASSWORD_REQUIRED";
				throw e;
			}
		}
		const pdf = doc.asPDF();
		return pdf || this._convertToPdf(doc);
	}

	/** Combine several files into a new document. files: [{bytes,name,password?}] */
	combine(files, name = "combined.pdf") {
		const doc = new mupdf.PDFDocument();
		for (const f of files) {
			const src = this._openSource(f.bytes, f.name, f.password);
			const map = doc.newGraftMap();
			const n = src.countPages();
			for (let i = 0; i < n; i++) map.graftPage(-1, src, i);
			try { src.destroy(); } catch { /* ignore */ }
		}
		const rec = this._register(doc, { name });
		this._ready(rec);
		rec.changeCount = 1;
		return this.info(rec.id);
	}

	/** Bytes of a new PDF made from some pages of this one. */
	extractPages(id, pages) {
		const rec = this._rec(id);
		const list = this._pageList(rec, pages);
		const out = new mupdf.PDFDocument();
		const map = out.newGraftMap();
		for (const i of list) map.graftPage(-1, rec.doc, i);
		const bytes = new Uint8Array(out.saveToBuffer("garbage=compact,compress").asUint8Array());
		out.destroy();
		return bytes;
	}

	/**
	 * Split into several files.
	 * mode: { every: n } | { ranges: "1-3,4-6" } | { single: true }
	 */
	split(id, mode) {
		const rec = this._rec(id);
		const n = rec.doc.countPages();
		const groups = [];
		if (mode.ranges) {
			for (const part of String(mode.ranges).split(/[;,]/)) {
				const l = parseRanges(part, n);
				if (l.length) groups.push({ pages: l, label: part.trim() });
			}
		} else {
			const every = Math.max(1, mode.every || 1);
			for (let i = 0; i < n; i += every) {
				const l = [];
				for (let k = i; k < Math.min(n, i + every); k++) l.push(k);
				groups.push({ pages: l, label: l.length > 1 ? `${l[0] + 1}-${l[l.length - 1] + 1}` : String(l[0] + 1) });
			}
		}
		const base = rec.name.replace(/\.pdf$/i, "");
		return groups.map((g) => ({ name: `${base}_p${g.label.replace(/[^\d-]/g, "")}.pdf`, bytes: this.extractPages(id, g.pages) }));
	}

	cropPage(id, pages, rect) {
		const rec = this._rec(id);
		const list = this._pageList(rec, pages);
		return this._op(rec, "crop", () => {
			for (const i of list) {
				const page = this._page(rec, i);
				if (!rect) {
					page.getObject().delete("CropBox");
				} else {
					const b = page.getBounds();
					const r = normRect(rect);
					const box = [Math.max(b[0], r[0]), Math.max(b[1], r[1]), Math.min(b[2], r[2]), Math.min(b[3], r[3])];
					if (box[2] - box[0] < 2 || box[3] - box[1] < 2) throw new Error("Crop area is too small");
					page.setPageBox("CropBox", box);
				}
			}
			return list.length;
		}, { structural: true });
	}

	/** Change page size by scaling content (e.g. letter -> A4). */
	resizePages(id, pages, width, height) {
		const rec = this._rec(id);
		const list = this._pageList(rec, pages);
		return this._op(rec, "resize pages", () => {
			for (const i of list) {
				const page = this._page(rec, i);
				const o = page.getObject();
				const mb = o.getInheritable("MediaBox");
				const box = [0, 1, 2, 3].map((k) => mb.get(k).asNumber());
				const w0 = box[2] - box[0], h0 = box[3] - box[1];
				const s = Math.min(width / w0, height / h0);
				const tx = (width - w0 * s) / 2 - box[0] * s, ty = (height - h0 * s) / 2 - box[1] * s;
				const contents = o.get("Contents");
				const arr = rec.doc.newArray();
				arr.push(rec.doc.addStream(`q ${num(s)} 0 0 ${num(s)} ${num(tx)} ${num(ty)} cm\n`, {}));
				if (contents.isArray()) contents.forEach((v) => arr.push(v));
				else if (!contents.isNull()) arr.push(contents);
				arr.push(rec.doc.addStream("\nQ\n", {}));
				o.put("Contents", arr);
				o.put("MediaBox", [0, 0, width, height]);
				o.delete("CropBox");
				o.delete("TrimBox");
				o.delete("BleedBox");
				o.delete("ArtBox");
			}
			return list.length;
		}, { structural: true });
	}

	// ---- images

	insertImageContent(id, index, rect, bytes) {
		const rec = this._rec(id);
		return this._op(rec, "insert image", () => {
			const page = this._page(rec, index);
			const img = new mupdf.Image(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
			const r = normRect(rect);
			this._appendContent(rec, page, (h) => {
				const name = h.image(img);
				// image space is y-up; flip into y-down page space
				return `q ${num(r[2] - r[0])} 0 0 ${num(-(r[3] - r[1]))} ${num(r[0])} ${num(r[3])} cm /${name} Do Q`;
			});
			return true;
		}, { pages: [index] });
	}

	imageSize(bytes) {
		const img = new mupdf.Image(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
		return { width: img.getWidth(), height: img.getHeight() };
	}

	// ---- document level

	setMetadata(id, meta) {
		const rec = this._rec(id);
		return this._op(rec, "metadata", () => {
			for (const [k, v] of Object.entries(meta)) {
				if (["Title", "Author", "Subject", "Keywords", "Creator", "Producer"].includes(k)) {
					rec.doc.setMetaData("info:" + k, String(v ?? ""));
				}
			}
			return true;
		}, { pages: [] });
	}

	/** Burn annotations and form fields into the page content. */
	flatten(id) {
		const rec = this._rec(id);
		return this._op(rec, "flatten", () => {
			rec.doc.bake(true, true);
			return true;
		});
	}

	undo(id) {
		const rec = this._rec(id);
		if (rec.journalOn && rec.doc.canUndo()) {
			rec.doc.undo();
			rec.changeCount--;
			rec.version++;
			rec.stextCache.clear();
		}
		return { state: this._state(rec), changed: { pages: "all", structural: true } };
	}

	redo(id) {
		const rec = this._rec(id);
		if (rec.journalOn && rec.doc.canRedo()) {
			rec.doc.redo();
			rec.changeCount++;
			rec.version++;
			rec.stextCache.clear();
		}
		return { state: this._state(rec), changed: { pages: "all", structural: true } };
	}

	/**
	 * Produce the bytes of the saved file.
	 * opts.security: "keep" | "remove" | "set"
	 * opts.userPassword, opts.ownerPassword, opts.permissions {print,copy,edit,annotate,form,assemble}
	 * opts.optimize: bool (garbage collect, dedupe, subset fonts, object streams)
	 * opts.sanitize: bool (strip metadata, JavaScript, hidden junk)
	 */
	saveBytes(id, opts = {}) {
		const rec = this._rec(id);
		const doc = rec.doc;
		const security = opts.security || "keep";
		const heavy = opts.optimize || opts.sanitize || security !== "keep";
		let bytes;
		if (!heavy) {
			bytes = doc.saveToBuffer("garbage=compact,compress").asUint8Array();
			return new Uint8Array(bytes);
		}
		// work on a disposable copy so the live document (and undo) stays intact
		const plain = doc.saveToBuffer("encrypt=none,garbage=compact").asUint8Array();
		const tmp = new mupdf.PDFDocument(new Uint8Array(plain));
		if (opts.sanitize) {
			for (const k of ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"]) {
				try { tmp.setMetaData("info:" + k, ""); } catch { /* ignore */ }
			}
			try {
				const root = tmp.getTrailer().get("Root");
				root.delete("Metadata");
				root.delete("OpenAction");
				root.delete("AA");
				const names = root.get("Names");
				if (names.isDictionary()) names.delete("JavaScript");
			} catch { /* ignore */ }
		}
		if (opts.optimize) { try { tmp.subsetFonts(); } catch { /* not fatal */ } }
		const parts = [];
		parts.push(opts.optimize ? "garbage=deduplicate,compress,compress-fonts,compress-images,objstms=yes" : "garbage=compact,compress");
		if (opts.sanitize) parts.push("sanitize");
		let encrypt = security;
		if (security === "keep" && rec.wasEncrypted) encrypt = rec.password ? "reuse" : "none";
		if (encrypt === "set" || encrypt === "reuse") {
			const user = encrypt === "set" ? (opts.userPassword || "") : rec.password;
			const owner = encrypt === "set" ? (opts.ownerPassword || opts.userPassword || randomPassword()) : rec.password;
			if (!user && !owner) throw new Error("Enter a password");
			parts.push("encrypt=aes-256");
			if (user) parts.push("user-password=" + user.replace(/,/g, ""));
			parts.push("owner-password=" + owner.replace(/,/g, ""));
			parts.push("permissions=" + permissionBits(opts.permissions));
		} else {
			parts.push("encrypt=none");
		}
		bytes = new Uint8Array(tmp.saveToBuffer(parts.join(",")).asUint8Array());
		tmp.destroy();
		return bytes;
	}

	markSaved(id, path, name, opts = {}) {
		const rec = this._rec(id);
		rec.savedAt = rec.changeCount;
		if (path) rec.path = path;
		if (name) rec.name = name;
		if (opts.security === "remove") { rec.wasEncrypted = false; rec.password = null; }
		if (opts.security === "set") { rec.wasEncrypted = true; rec.password = opts.userPassword || opts.ownerPassword; }
		rec.convertedFrom = null;
		return this._state(rec);
	}
}

// ------------------------------------------------------------------ utils

function safe(fn, fallback) {
	try {
		const v = fn();
		return v === undefined ? fallback : v;
	} catch {
		return fallback;
	}
}

function pageObjResolved(o) { return o; }

function quadsBounds(quads) {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const q of quads) {
		for (let i = 0; i < 8; i += 2) {
			x0 = Math.min(x0, q[i]); x1 = Math.max(x1, q[i]);
			y0 = Math.min(y0, q[i + 1]); y1 = Math.max(y1, q[i + 1]);
		}
	}
	return [x0, y0, x1, y1];
}

/** Pull each quad corner a little toward the centre so neighbours aren't caught. */
function shrinkQuad(q, f) {
	const cx = (q[0] + q[2] + q[4] + q[6]) / 4;
	const cy = (q[1] + q[3] + q[5] + q[7]) / 4;
	return q.map((v, i) => (i % 2 ? v + (cy - v) * f : v + (cx - v) * f * 0.5));
}

function normDir(d) {
	const [x, y] = d || [1, 0];
	const l = Math.hypot(x, y) || 1;
	return [x / l, y / l];
}

function matchLine(lines, t) {
	let best = null, bestScore = Infinity;
	for (const l of lines) {
		const d = Math.abs(l.bbox[0] - t.bbox[0]) + Math.abs(l.bbox[1] - t.bbox[1]) + Math.abs(l.bbox[2] - t.bbox[2]) + Math.abs(l.bbox[3] - t.bbox[3]);
		const score = d + (t.text && l.text !== t.text ? 50 : 0);
		if (score < bestScore) { bestScore = score; best = l; }
	}
	return bestScore < 60 ? best : null;
}

function fontCovers(font, text) {
	if (!font) return false;
	try {
		const name = font.getName();
		if (!name) return false;
		for (const ch of text) {
			if (ch === " ") continue;
			if (font.encodeCharacter(ch.codePointAt(0)) <= 0) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Encode text for an Identity-H CID font (what PDFDocument.addFont makes).
 * Returns a TJ array; glyphs the font lacks (usually spaces in subsets)
 * become positioning gaps instead.
 */
function encodeText(font, text) {
	let tj = "[";
	let hex = "";
	let width = 0;
	let open = false;
	const SPACE = 0.278;
	for (const ch of String(text)) {
		const cp = ch.codePointAt(0);
		let gid = 0;
		try { gid = font.encodeCharacter(cp); } catch { gid = 0; }
		if (gid > 0) {
			const g = gid.toString(16).padStart(4, "0");
			if (!open) { tj += "<"; open = true; }
			tj += g;
			hex += g;
			try { width += font.advanceGlyph(gid, 0); } catch { width += 0.5; }
		} else {
			if (open) { tj += ">"; open = false; }
			const adv = ch === "\t" ? SPACE * 4 : SPACE;
			tj += ` ${num(-adv * 1000)} `;
			width += adv;
		}
	}
	if (open) tj += ">";
	tj += "]";
	return { tj, hex, width };
}

function parseRanges(spec, n) {
	const out = [];
	const s = String(spec || "").trim().toLowerCase();
	if (!s || s === "all") return [...Array(n).keys()];
	for (let part of s.split(/[,;\s]+/)) {
		if (!part) continue;
		if (part === "odd" || part === "even") {
			for (let i = part === "odd" ? 0 : 1; i < n; i += 2) out.push(i);
			continue;
		}
		part = part.replace(/end|last/g, String(n));
		const m = part.match(/^(\d+)?\s*-\s*(\d+)?$/);
		if (m) {
			const a = m[1] ? parseInt(m[1], 10) : 1;
			const b = m[2] ? parseInt(m[2], 10) : n;
			const step = a <= b ? 1 : -1;
			for (let i = a; step > 0 ? i <= b : i >= b; i += step) if (i >= 1 && i <= n) out.push(i - 1);
		} else if (/^\d+$/.test(part)) {
			const i = parseInt(part, 10);
			if (i >= 1 && i <= n) out.push(i - 1);
		}
	}
	return out;
}

function permissionBits(p = {}) {
	const allow = { print: true, copy: true, edit: true, annotate: true, form: true, assemble: true, ...p };
	let bits = -3904; // reserved bits set
	if (allow.print) bits |= (1 << 2) | (1 << 11);
	if (allow.edit) bits |= 1 << 3;
	if (allow.copy) bits |= (1 << 4) | (1 << 9);
	if (allow.annotate) bits |= 1 << 5;
	if (allow.form) bits |= 1 << 8;
	if (allow.assemble) bits |= 1 << 10;
	return bits;
}

function randomPassword() {
	const a = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	let s = "";
	for (let i = 0; i < 24; i++) s += a[Math.floor(Math.random() * a.length)];
	return s;
}

export { parseRanges, encodeText, permissionBits };
