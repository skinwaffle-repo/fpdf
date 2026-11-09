// fuck pdf - page viewer: layout, rendering, overlays and every tool's mouse handling.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { S, cur, E, op, bus, pageVersion, api, cleanErr } from "./state.js";
import { el, svg, toast, hex2rgb, rgb2hex, popupMenu, promptBox, modal, modalOpen } from "./ui.js";

const viewer = document.getElementById("viewer");
const pagesEl = document.getElementById("pages");

let views = [];
let viewDocId = null;
const MIN_Z = 0.1, MAX_Z = 8;
const PAD_X = 80;

// ------------------------------------------------------------------ helpers
const dpr = () => window.devicePixelRatio || 1;
const quadPts = (q) => `${q[0]},${q[1]} ${q[2]},${q[3]} ${q[6]},${q[7]} ${q[4]},${q[5]}`;
function rectOf(a, b) { return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]; }
function inRect(p, r, pad = 0) { return p[0] >= r[0] - pad && p[0] <= r[2] + pad && p[1] >= r[1] - pad && p[1] <= r[3] + pad; }
function color(tool) { return hex2rgb(S.tp.colors[tool] || "#e01b24"); }
const FONT_CSS = { helv: "Arial, Helvetica, 'Liberation Sans', sans-serif", times: "'Times New Roman', Times, 'Liberation Serif', serif", cour: "'Courier New', Courier, 'Liberation Mono', monospace" };

// --------------------------------------------------------------- building
export function showDoc(doc) {
	if (!doc) {
		pagesEl.replaceChildren();
		views = [];
		viewDocId = null;
		return;
	}
	if (viewDocId === doc.id && views.length === doc.info.pages.length) {
		layout(doc);
		return;
	}
	buildViews(doc);
	viewer.scrollTop = doc.scrollTop;
	viewer.scrollLeft = doc.scrollLeft;
	scheduleRender();
}

export function buildViews(doc) {
	const keepTop = viewDocId === doc.id ? viewer.scrollTop : doc.scrollTop;
	viewDocId = doc.id;
	pagesEl.replaceChildren();
	views = doc.info.pages.map((p, i) => {
		const canvas = el("canvas.pc");
		const ov = svg("svg", { class: "ov", viewBox: `${p.bounds[0]} ${p.bounds[1]} ${p.w} ${p.h}`, preserveAspectRatio: "none" });
		const layer = el("div.layer");
		const node = el("div.page", { "data-i": i }, canvas, ov, layer, el("span.pnum", {}, p.label || String(i + 1)));
		pagesEl.append(node);
		return { i, el: node, canvas, ov, layer, rs: 0, rv: -1 };
	});
	if (doc.fit) doc.zoom = fitZoom(doc, doc.fit);
	layout(doc);
	viewer.scrollTop = keepTop;
}

function fitZoom(doc, mode) {
	const pages = doc.info.pages;
	if (!pages.length) return 1;
	const availW = Math.max(100, viewer.clientWidth - PAD_X - 14);
	const maxW = Math.max(...pages.map((p) => p.w));
	if (mode === "width") return clampZ(availW / maxW);
	const p = pages[doc.current] || pages[0];
	const availH = Math.max(100, viewer.clientHeight - 44);
	return clampZ(Math.min(availW / p.w, availH / p.h));
}
const clampZ = (z) => Math.max(MIN_Z, Math.min(MAX_Z, z));

export function layout(doc = cur()) {
	if (!doc) return;
	for (const v of views) {
		const p = doc.info.pages[v.i];
		if (!p) continue;
		v.el.style.width = Math.round(p.w * doc.zoom) + "px";
		v.el.style.height = Math.round(p.h * doc.zoom) + "px";
	}
	bus.emit("zoom", doc);
}

export function onResize() {
	const doc = cur();
	if (!doc) return;
	if (doc.fit) {
		const z = fitZoom(doc, doc.fit);
		if (Math.abs(z - doc.zoom) > 0.002) {
			const anchor = anchorAt(doc, viewer.clientWidth / 2, 0);
			doc.zoom = z;
			layout(doc);
			restoreAnchor(anchor);
		}
	}
	scheduleRender();
}

// ------------------------------------------------------------------ zoom
function anchorAt(doc, vx, vy) {
	const y = viewer.scrollTop + vy;
	for (const v of views) {
		const top = v.el.offsetTop, h = v.el.offsetHeight;
		if (y <= top + h + 9) {
			return { i: v.i, fy: (y - top) / Math.max(1, h), fx: (viewer.scrollLeft + vx - v.el.offsetLeft) / Math.max(1, v.el.offsetWidth), vx, vy };
		}
	}
	return null;
}
function restoreAnchor(a) {
	if (!a || !views[a.i]) return;
	const v = views[a.i];
	viewer.scrollTop = v.el.offsetTop + a.fy * v.el.offsetHeight - a.vy;
	viewer.scrollLeft = v.el.offsetLeft + a.fx * v.el.offsetWidth - a.vx;
}

export function setZoom(z, { fit = null, clientX = null, clientY = null } = {}) {
	const doc = cur();
	if (!doc) return;
	const r = viewer.getBoundingClientRect();
	const vx = clientX == null ? viewer.clientWidth / 2 : clientX - r.left;
	const vy = clientY == null ? viewer.clientHeight / 2 : clientY - r.top;
	const anchor = anchorAt(doc, vx, vy);
	doc.fit = fit;
	doc.zoom = fit ? fitZoom(doc, fit) : clampZ(z);
	layout(doc);
	restoreAnchor(anchor);
	scheduleRender();
	refreshInlineEditors();
}
const STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];
export function zoomStep(dir, opts) {
	const doc = cur();
	if (!doc) return;
	const z = doc.zoom;
	const next = dir > 0 ? STEPS.find((s) => s > z + 0.001) ?? MAX_Z : [...STEPS].reverse().find((s) => s < z - 0.001) ?? MIN_Z;
	setZoom(next, opts);
}

viewer.addEventListener("wheel", (e) => {
	if (!e.ctrlKey) return;
	e.preventDefault();
	const doc = cur();
	if (!doc) return;
	const f = Math.exp(-e.deltaY * 0.0022);
	setZoom(doc.zoom * f, { clientX: e.clientX, clientY: e.clientY });
}, { passive: false });

// ------------------------------------------------------------- navigation
export function goToPage(i, { y = null, smooth = false } = {}) {
	const doc = cur();
	if (!doc || !views[i]) return;
	const v = views[i];
	let top = v.el.offsetTop - 12;
	if (y != null) {
		const p = doc.info.pages[i];
		top = v.el.offsetTop + (y - p.bounds[1]) * doc.zoom - viewer.clientHeight / 3;
	}
	viewer.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
	doc.current = i;
	bus.emit("current-page", doc);
}

export function currentPage() {
	const doc = cur();
	return doc ? doc.current : 0;
}

let scrollRaf = 0;
viewer.addEventListener("scroll", () => {
	cancelAnimationFrame(scrollRaf);
	scrollRaf = requestAnimationFrame(() => {
		const doc = cur();
		if (!doc) return;
		doc.scrollTop = viewer.scrollTop;
		doc.scrollLeft = viewer.scrollLeft;
		updateCurrent(doc);
		scheduleRender();
	});
});

function updateCurrent(doc) {
	const mid = viewer.scrollTop + viewer.clientHeight * 0.4;
	let best = 0;
	for (const v of views) {
		if (v.el.offsetTop <= mid) best = v.i;
		else break;
	}
	if (viewer.scrollTop + viewer.clientHeight >= viewer.scrollHeight - 4 && views.length) {
		// at the very bottom, the last visible page counts
		const bottom = views.filter((v) => v.el.offsetTop < viewer.scrollTop + viewer.clientHeight).pop();
		if (bottom) best = Math.max(best, bottom.i);
	}
	if (best !== doc.current) {
		doc.current = best;
		bus.emit("current-page", doc);
	}
}

function visibleRange(buffer = 1) {
	const top = viewer.scrollTop, bottom = top + viewer.clientHeight;
	let first = -1, last = -1;
	for (const v of views) {
		const t = v.el.offsetTop, b = t + v.el.offsetHeight;
		if (b >= top && t <= bottom) {
			if (first < 0) first = v.i;
			last = v.i;
		} else if (t > bottom) break;
	}
	if (first < 0) return [0, -1];
	return [Math.max(0, first - buffer), Math.min(views.length - 1, last + buffer)];
}

// --------------------------------------------------------------- rendering
let renderRaf = 0, pumping = false;
const queue = [];

export function scheduleRender() {
	cancelAnimationFrame(renderRaf);
	renderRaf = requestAnimationFrame(planRender);
}

function targetScale(doc) {
	return Math.min(doc.zoom * dpr(), 6);
}

function planRender() {
	const doc = cur();
	if (!doc || viewDocId !== doc.id) return;
	const [a, b] = visibleRange(1);
	const want = [];
	const ts = targetScale(doc);
	for (let i = a; i <= b; i++) {
		const v = views[i];
		const pv = pageVersion(doc, i);
		if (v.rs !== ts || v.rv !== pv) want.push(i);
		else ensureOverlay(doc, i);
	}
	// closest to current page first
	want.sort((x, y) => Math.abs(x - doc.current) - Math.abs(y - doc.current));
	queue.length = 0;
	queue.push(...want.map((i) => ({ doc, i })));
	// free memory far away
	for (const v of views) {
		if ((v.i < a - 4 || v.i > b + 4) && v.canvas.width > 0) {
			v.canvas.width = 0;
			v.canvas.height = 0;
			v.rs = 0;
		}
	}
	pump();
}

async function pump() {
	if (pumping) return;
	pumping = true;
	try {
		while (queue.length) {
			const { doc, i } = queue.shift();
			if (doc !== cur() || viewDocId !== doc.id) continue;
			await renderOne(doc, i);
		}
	} finally {
		pumping = false;
	}
}

async function renderOne(doc, i) {
	const v = views[i];
	if (!v) return;
	const ts = targetScale(doc);
	const pv = pageVersion(doc, i);
	if (v.rs === ts && v.rv === pv) return;
	if (!v.rs) v.el.classList.add("loading");
	let res;
	try {
		res = await E("render", doc.id, i, ts);
	} catch (e) {
		v.el.classList.remove("loading");
		console.error(e);
		return;
	}
	if (doc !== cur() || views[i] !== v) return;
	const c = v.canvas;
	if (c.width !== res.width || c.height !== res.height) {
		c.width = res.width;
		c.height = res.height;
	}
	c.getContext("2d").putImageData(new ImageData(res.data, res.width, res.height), 0, 0);
	v.rs = ts;
	v.rv = pv;
	v.el.classList.remove("loading");
	await ensureOverlay(doc, i, true);
}

// -------------------------------------------------------------- page data
export async function pageData(doc, i, { lines = false } = {}) {
	const v = pageVersion(doc, i);
	let c = doc.cache.get(i);
	if (!c || c.v !== v) {
		c = { v, annots: null, widgets: null, lines: null, p: {} };
		doc.cache.set(i, c);
	}
	if (!c.annots) c.annots = await (c.p.a ||= E("annotations", doc.id, i).catch(() => []));
	if (!c.widgets) c.widgets = doc.info.hasForms ? await (c.p.w ||= E("widgets", doc.id, i).catch(() => [])) : [];
	if (lines && !c.lines) c.lines = await (c.p.l ||= E("pageLines", doc.id, i).catch(() => []));
	return c;
}
function cached(doc, i) {
	const c = doc.cache.get(i);
	return c && c.v === pageVersion(doc, i) ? c : null;
}

async function ensureOverlay(doc, i, force = false) {
	const v = views[i];
	if (!v) return;
	const pv = pageVersion(doc, i);
	if (!force && v.ovV === pv && v.ovTool === S.tool) return;
	await pageData(doc, i, { lines: S.tool === "edittext" });
	v.ovV = pv;
	v.ovTool = S.tool;
	drawOverlay(i);
}

export function redrawOverlays() {
	const doc = cur();
	if (!doc) return;
	const [a, b] = visibleRange(1);
	for (let i = a; i <= b; i++) ensureOverlay(doc, i, true);
}

export function drawOverlay(i) {
	const doc = cur();
	const v = views[i];
	if (!doc || !v) return;
	const ov = v.ov;
	const ghost = ov.querySelector(".ghostg");
	ov.replaceChildren();
	const c = cached(doc, i);
	// form fields
	if (c && c.widgets && (S.tool === "select" || S.tool === "hand")) {
		for (const w of c.widgets) {
			if (w.readOnly) continue;
			ov.append(svg("rect", { class: "widget-box", x: w.rect[0], y: w.rect[1], width: w.rect[2] - w.rect[0], height: w.rect[3] - w.rect[1] }));
		}
	}
	// edit-text line boxes
	if (c && c.lines && S.tool === "edittext") {
		for (const l of c.lines) {
			const hot = hoverLine && hoverLine.page === i && hoverLine.line.index === l.index;
			ov.append(svg("rect", { class: "line-box", x: l.bbox[0] - 1, y: l.bbox[1] - 1, width: l.bbox[2] - l.bbox[0] + 2, height: l.bbox[3] - l.bbox[1] + 2, style: hot ? "fill:rgba(0,120,255,0.16)" : "opacity:0.45" }));
		}
	}
	// search hits
	const s = doc.search;
	if (s.flat.length) {
		s.flat.forEach((h, k) => {
			if (h.page !== i) return;
			for (const q of h.quads) ov.append(svg("polygon", { class: "hit" + (k === s.index ? " cur" : ""), points: quadPts(q) }));
		});
	}
	// text selection
	if (doc.selection && doc.selection.page === i) {
		for (const q of doc.selection.quads) ov.append(svg("polygon", { class: "selq", points: quadPts(q) }));
	}
	// selected annotation
	const sa = doc.selectedAnnot;
	if (sa && sa.page === i && c && c.annots) {
		const a = c.annots.find((x) => x.id === sa.id);
		if (a) {
			const r = a.rect;
			ov.append(svg("rect", { class: "annot-sel", x: r[0] - 2, y: r[1] - 2, width: r[2] - r[0] + 4, height: r[3] - r[1] + 4 }));
			if (RESIZABLE.has(a.type)) {
				const hs = 7 / doc.zoom;
				for (const [k, x, y] of handlePts(r)) {
					ov.append(svg("rect", { class: "handle h-" + k, "data-h": k, x: x - hs / 2, y: y - hs / 2, width: hs, height: hs }));
				}
			}
		}
	}
	ov.append(ghost || svg("g", { class: "ghostg" }));
}

const RESIZABLE = new Set(["Square", "Circle", "FreeText", "Stamp", "Ink", "Line", "Redact"]);
function handlePts(r) {
	return [["nw", r[0] - 2, r[1] - 2], ["ne", r[2] + 2, r[1] - 2], ["sw", r[0] - 2, r[3] + 2], ["se", r[2] + 2, r[3] + 2]];
}

function ghostG(i) {
	const v = views[i];
	let g = v.ov.querySelector(".ghostg");
	if (!g) { g = svg("g", { class: "ghostg" }); v.ov.append(g); }
	return g;
}
function clearGhost(i) { const v = views[i]; if (v) v.ov.querySelector(".ghostg")?.replaceChildren(); }

// ---------------------------------------------------------------- changes
bus.on("doc-changed", (doc, ch) => {
	if (doc !== cur()) return;
	if (doc.info.pages.length !== views.length || ch.structural) {
		// geometry may have changed; refresh info lazily by the app, then rebuild
		return;
	}
	scheduleRender();
});

export function invalidateAll() {
	for (const v of views) { v.rv = -1; v.ovV = -1; }
	scheduleRender();
}

// ---------------------------------------------------------------- tools
let hoverLine = null;
let drag = null;

export function setTool(t) {
	S.tool = t;
	const cls = {
		select: "tool-select", hand: "tool-hand", edittext: "tool-edittext", draw: "tool-draw",
		highlight: "tool-text-hl", underline: "tool-text-hl", strikeout: "tool-text-hl", squiggly: "tool-text-hl",
	}[t] || "tool-crosshair";
	viewer.className = cls;
	hoverLine = null;
	closeInline();
	const doc = cur();
	if (doc && t !== "select" && !["highlight", "underline", "strikeout", "squiggly"].includes(t)) {
		// keep a text selection only for tools that use it
		doc.selection = null;
	}
	redrawOverlays();
	bus.emit("tool", t);
}

function pagePoint(v, e) {
	const doc = cur();
	const p = doc.info.pages[v.i];
	const r = v.el.getBoundingClientRect();
	return [p.bounds[0] + (e.clientX - r.left) / doc.zoom, p.bounds[1] + (e.clientY - r.top) / doc.zoom];
}

function viewFromEvent(e) {
	const node = e.target.closest && e.target.closest(".page");
	if (!node) return null;
	return views[+node.dataset.i] || null;
}

pagesEl.addEventListener("pointerdown", async (e) => {
	const doc = cur();
	if (!doc || modalOpen()) return;
	if (e.target.closest(".layer > *")) return; // inline editors
	if (inline) commitInline();
	viewer.focus({ preventScroll: true });
	if (e.button === 1 || S.tool === "hand") {
		startPan(e);
		return;
	}
	if (e.button !== 0) return;
	const v = viewFromEvent(e);
	if (!v) return;
	const pt = pagePoint(v, e);
	const handler = TOOLS[S.tool] || TOOLS.select;
	e.preventDefault();
	pointerIsDown = true;
	const d = await handler.down({ doc, i: v.i, v, pt, e });
	if (!d) return;
	const dd = { ...d, v, doc, start: pt, moved: false };
	if (!pointerIsDown) {
		// the button was released while the tool was still getting ready: treat as a click
		try { dd.up && await dd.up(pt, e, false); } catch (err) { toast(cleanErr(err), { error: true }); }
		return;
	}
	drag = dd;
});
let pointerIsDown = false;
window.addEventListener("pointerup", () => { pointerIsDown = false; }, true);

window.addEventListener("pointermove", (e) => {
	const doc = cur();
	if (!doc) return;
	if (drag) {
		const pt = pagePoint(drag.v, e);
		if (!drag.moved && Math.hypot(pt[0] - drag.start[0], pt[1] - drag.start[1]) * doc.zoom > 2) drag.moved = true;
		drag.move && drag.move(pt, e);
		return;
	}
	if (panning) return;
	const v = viewFromEvent(e);
	if (!v) {
		if (hoverLine) { const p = hoverLine.page; hoverLine = null; drawOverlay(p); }
		return;
	}
	hover(doc, v, pagePoint(v, e));
});

window.addEventListener("pointerup", async (e) => {
	if (!drag) return;
	const d = drag;
	drag = null;
	const pt = pagePoint(d.v, e);
	try {
		d.up && await d.up(pt, e, d.moved);
	} catch (err) {
		toast(cleanErr(err), { error: true });
	}
});

pagesEl.addEventListener("dblclick", (e) => {
	const doc = cur();
	const v = viewFromEvent(e);
	if (!doc || !v || S.tool !== "select") return;
	const pt = pagePoint(v, e);
	const c = cached(doc, v.i);
	const a = c && hitAnnot(c, pt, doc.zoom);
	if (!a) return;
	if (a.type === "FreeText") editFreeText(doc, v.i, a);
	else if (a.type === "Text" || a.type === "Highlight" || a.type === "Square" || a.type === "Circle") editNote(doc, v.i, a);
});

pagesEl.addEventListener("contextmenu", (e) => {
	const doc = cur();
	const v = viewFromEvent(e);
	if (!doc || !v) return;
	e.preventDefault();
	const pt = pagePoint(v, e);
	const c = cached(doc, v.i);
	const a = c && hitAnnot(c, pt, doc.zoom);
	const items = [];
	if (a) {
		selectAnnot(doc, v.i, a);
		items.push({ label: "delete " + a.type.toLowerCase(), key: "del", action: () => deleteSelectedAnnot() });
		if (a.type === "FreeText") items.push({ label: "edit text", action: () => editFreeText(doc, v.i, a) });
		items.push({ label: "edit comment", action: () => editNote(doc, v.i, a) });
		items.push("-");
	}
	if (doc.selection && doc.selection.page === v.i && doc.selection.text) {
		items.push({ label: "copy", key: "ctrl+c", action: copySelection });
		items.push({ label: "highlight", action: () => markupSelection("highlight") });
		items.push({ label: "underline", action: () => markupSelection("underline") });
		items.push({ label: "strike out", action: () => markupSelection("strikeout") });
		items.push({ label: "redact", action: () => markupSelection("redact") });
		items.push({ label: `find "${doc.selection.text.trim().slice(0, 24)}"`, action: () => bus.emit("find", doc.selection.text.trim()) });
		items.push("-");
	}
	items.push({ label: "select all text on page", action: () => selectAllOnPage(doc, v.i) });
	items.push({ label: "add note here", action: () => TOOLS.note.place(doc, v.i, pt) });
	items.push("-");
	items.push({ label: "rotate page right", action: () => bus.emit("action", "rotatePage", v.i, 90) });
	items.push({ label: "rotate page left", action: () => bus.emit("action", "rotatePage", v.i, -90) });
	items.push({ label: "insert blank page after", action: () => bus.emit("action", "insertBlankAt", v.i + 1) });
	items.push({ label: "delete page", action: () => bus.emit("action", "deletePagesList", [v.i]) });
	popupMenu(items, e.clientX, e.clientY);
});

// -------------------------------------------------------------- panning
let panning = null;
function startPan(e) {
	e.preventDefault();
	panning = { x: e.clientX, y: e.clientY, top: viewer.scrollTop, left: viewer.scrollLeft };
	viewer.classList.add("panning");
	const move = (ev) => {
		viewer.scrollTop = panning.top - (ev.clientY - panning.y);
		viewer.scrollLeft = panning.left - (ev.clientX - panning.x);
	};
	const up = () => {
		panning = null;
		viewer.classList.remove("panning");
		window.removeEventListener("pointermove", move);
		window.removeEventListener("pointerup", up);
	};
	window.addEventListener("pointermove", move);
	window.addEventListener("pointerup", up);
}

// ------------------------------------------------------------ hit testing
function hitAnnot(c, pt, zoom) {
	if (!c || !c.annots) return null;
	const pad = 3 / zoom;
	for (let k = c.annots.length - 1; k >= 0; k--) {
		const a = c.annots[k];
		if (inRect(pt, a.rect, pad)) return a;
	}
	return null;
}
function hitWidget(c, pt) {
	if (!c || !c.widgets) return null;
	return c.widgets.find((w) => inRect(pt, w.rect)) || null;
}
function hitHandle(doc, i, pt) {
	const sa = doc.selectedAnnot;
	if (!sa || sa.page !== i) return null;
	const c = cached(doc, i);
	const a = c && c.annots && c.annots.find((x) => x.id === sa.id);
	if (!a || !RESIZABLE.has(a.type)) return null;
	const tol = 6 / doc.zoom;
	for (const [k, x, y] of handlePts(a.rect)) {
		if (Math.abs(pt[0] - x) <= tol && Math.abs(pt[1] - y) <= tol) return { k, a };
	}
	return null;
}

function hover(doc, v, pt) {
	const c = cached(doc, v.i);
	if (S.tool === "select") {
		const overA = !!(c && (hitAnnot(c, pt, doc.zoom) || hitHandle(doc, v.i, pt)));
		const overW = !overA && !!(c && hitWidget(c, pt));
		v.ov.classList.toggle("over-annot", overA);
		v.ov.classList.toggle("over-widget", overW);
	} else if (S.tool === "edittext") {
		if (!c || !c.lines) { ensureOverlay(doc, v.i, true); return; }
		const line = c.lines.find((l) => inRect(pt, l.bbox, 1.5)) || null;
		const prev = hoverLine;
		if ((prev && prev.line) !== line || (prev && prev.page) !== v.i) {
			hoverLine = line ? { page: v.i, line } : null;
			if (prev && prev.page !== v.i) drawOverlay(prev.page);
			drawOverlay(v.i);
		}
	}
}

// --------------------------------------------------------- selection ops
export function selectAnnot(doc, i, a) {
	doc.selectedAnnot = a ? { page: i, id: a.id } : null;
	doc.selection = null;
	drawOverlay(i);
	bus.emit("annot-selected", doc);
}

export function clearSelections() {
	const doc = cur();
	if (!doc) return;
	const pages = new Set([doc.selection && doc.selection.page, doc.selectedAnnot && doc.selectedAnnot.page]);
	doc.selection = null;
	doc.selectedAnnot = null;
	for (const p of pages) if (p != null) drawOverlay(p);
	bus.emit("annot-selected", doc);
}

export function selectedAnnotData() {
	const doc = cur();
	if (!doc || !doc.selectedAnnot) return null;
	const c = cached(doc, doc.selectedAnnot.page);
	const a = c && c.annots && c.annots.find((x) => x.id === doc.selectedAnnot.id);
	return a ? { page: doc.selectedAnnot.page, ...a } : null;
}

export async function deleteSelectedAnnot() {
	const doc = cur();
	const sa = doc && doc.selectedAnnot;
	if (!sa) return false;
	doc.selectedAnnot = null;
	await op(doc, "deleteAnnot", sa.page, sa.id);
	bus.emit("annot-selected", doc);
	return true;
}

export async function copySelection() {
	const doc = cur();
	if (!doc || !doc.selection || !doc.selection.text) return false;
	await navigator.clipboard.writeText(doc.selection.text);
	toast("copied " + doc.selection.text.length + " chars");
	return true;
}

async function selectAllOnPage(doc, i) {
	const r = await E("selectAll", doc.id, i);
	doc.selection = { page: i, quads: r.quads, text: r.text };
	doc.selectedAnnot = null;
	drawOverlay(i);
}

export async function markupSelection(type) {
	const doc = cur();
	const s = doc && doc.selection;
	if (!s || !s.quads.length) {
		toast("select some text first");
		return;
	}
	doc.selection = null;
	if (type === "redact") {
		await op(doc, "addAnnot", s.page, { type: "redact", quads: s.quads });
		redactHint();
		return;
	}
	await op(doc, "addAnnot", s.page, {
		type, quads: s.quads, color: color(type),
		opacity: type === "highlight" ? S.tp.hlOpacity : S.tp.opacity,
	});
}

let redactHinted = false;
function redactHint() {
	if (redactHinted) return;
	redactHinted = true;
	toast("marked for redaction. nothing is removed until you hit\n'apply redactions' (right panel, or tools menu).", { ms: 6000 });
}

// ---------------------------------------------------------- text select drag
function textSelectDrag(doc, i, pt, onDone) {
	let inflight = false, pendingQ = null;
	const update = async (q) => {
		if (inflight) { pendingQ = q; return; }
		inflight = true;
		try {
			const r = await E("selectText", doc.id, i, pt, q);
			doc.selection = { page: i, quads: r.quads, text: r.text };
			drawOverlay(i);
		} catch { /* ignore */ }
		inflight = false;
		if (pendingQ) { const n = pendingQ; pendingQ = null; update(n); }
	};
	if (doc.selection && doc.selection.page !== i) { const p = doc.selection.page; doc.selection = null; drawOverlay(p); }
	return {
		move: (q) => update(q),
		up: async (q, e, moved) => {
			if (!moved) {
				doc.selection = null;
				drawOverlay(i);
				return;
			}
			while (inflight) await new Promise((r) => setTimeout(r, 10));
			await update(q);
			while (inflight) await new Promise((r) => setTimeout(r, 10));
			if (onDone) await onDone();
			bus.emit("selection", doc);
		},
	};
}

// ---------------------------------------------------------- rect drag
function rectDrag(i, onUp, { square = false } = {}) {
	let start = null;
	return {
		init(pt) { start = pt; },
		move(pt, e) {
			let p = pt;
			if (square || e.shiftKey) {
				const s = Math.max(Math.abs(pt[0] - start[0]), Math.abs(pt[1] - start[1]));
				p = [start[0] + Math.sign(pt[0] - start[0]) * s, start[1] + Math.sign(pt[1] - start[1]) * s];
			}
			const r = rectOf(start, p);
			const g = ghostG(i);
			g.replaceChildren(svg("rect", { class: "ghost", x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1] }));
			this.last = r;
		},
		async up(pt, e, moved) {
			clearGhost(i);
			await onUp(moved && this.last ? this.last : null, start);
		},
	};
}

function defaultRect(pt, w, h, doc, i) {
	const b = doc.info.pages[i].bounds;
	let x = pt[0] - w / 2, y = pt[1] - h / 2;
	x = Math.max(b[0] + 2, Math.min(x, b[2] - w - 2));
	y = Math.max(b[1] + 2, Math.min(y, b[3] - h - 2));
	return [x, y, x + w, y + h];
}

function fitAspect(r, w, h) {
	const rw = r[2] - r[0], rh = r[3] - r[1];
	const s = Math.min(rw / w, rh / h);
	const nw = w * s, nh = h * s;
	return [r[0], r[1], r[0] + nw, r[1] + nh];
}

async function addAndSelect(doc, i, spec, { keepTool = true } = {}) {
	const res = await op(doc, "addAnnot", i, spec);
	if (!keepTool) bus.emit("set-tool", "select");
	await pageData(doc, i);
	const c = cached(doc, i);
	const a = c && c.annots && c.annots.find((x) => x.id === res.result);
	if (a) selectAnnot(doc, i, a);
	return res;
}

// ------------------------------------------------------------------ TOOLS
const TOOLS = {
	select: {
		async down({ doc, i, pt, e }) {
			const c = cached(doc, i) || await pageData(doc, i);
			const h = hitHandle(doc, i, pt);
			if (h) return resizeDrag(doc, i, h.a, h.k);
			const w = hitWidget(c, pt);
			if (w && !w.readOnly) { activateWidget(doc, i, w); return null; }
			const a = hitAnnot(c, pt, doc.zoom);
			if (a) {
				selectAnnot(doc, i, a);
				return moveDrag(doc, i, a, pt);
			}
			if (doc.selectedAnnot) {
				const p = doc.selectedAnnot.page;
				doc.selectedAnnot = null;
				drawOverlay(p);
				bus.emit("annot-selected", doc);
			}
			return textSelectDrag(doc, i, pt);
		},
	},
	highlight: markupTool("highlight"),
	underline: markupTool("underline"),
	strikeout: markupTool("strikeout"),
	squiggly: markupTool("squiggly"),
	draw: {
		down({ doc, i, pt }) {
			const pts = [pt];
			const col = S.tp.colors.draw;
			const g = ghostG(i);
			const path = svg("polyline", { class: "ghost-ink", stroke: col, "stroke-width": S.tp.width, "stroke-opacity": S.tp.opacity, points: `${pt[0]},${pt[1]}` });
			g.replaceChildren(path);
			return {
				move(p) {
					const last = pts[pts.length - 1];
					if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.6 / doc.zoom) return;
					pts.push(p);
					path.setAttribute("points", pts.map((q) => q.join(",")).join(" "));
				},
				async up() {
					if (pts.length < 2) { clearGhost(i); return; }
					await op(doc, "addAnnot", i, { type: "ink", strokes: [simplify(pts, 0.35)], color: hex2rgb(col), width: S.tp.width, opacity: S.tp.opacity });
					clearGhost(i);
				},
			};
		},
	},
	rect: shapeTool("rect"),
	ellipse: shapeTool("ellipse"),
	whiteout: {
		down({ doc, i, pt }) {
			const d = rectDrag(i, async (r) => {
				if (!r) return;
				await op(doc, "addAnnot", i, { type: "whiteout", rect: r });
			});
			d.init(pt);
			return d;
		},
	},
	redact: {
		down({ doc, i, pt }) {
			const d = rectDrag(i, async (r) => {
				if (!r) return;
				await op(doc, "addAnnot", i, { type: "redact", rect: r });
				redactHint();
			});
			d.init(pt);
			return d;
		},
	},
	line: lineTool("line"),
	arrow: lineTool("arrow"),
	note: {
		down({ doc, i, pt }) {
			return { up: () => TOOLS.note.place(doc, i, pt) };
		},
		async place(doc, i, pt) {
			const text = await promptBox("sticky note", "note", "", { multiline: true });
			if (text == null) return;
			await addAndSelect(doc, i, { type: "note", point: [pt[0] - 10, pt[1] - 10], contents: text, color: hex2rgb(S.tp.colors.note) });
		},
	},
	addtext: {
		down({ doc, i, pt }) {
			return { up: () => openTextEditor(doc, i, pt) };
		},
	},
	edittext: {
		async down({ doc, i, pt }) {
			const c = await pageData(doc, i, { lines: true });
			const line = c.lines.find((l) => inRect(pt, l.bbox, 1.5));
			if (!line) {
				toast("click directly on a line of text to edit it.\nto add new text use 'add text' (T).");
				return null;
			}
			openLineEditor(doc, i, line);
			return null;
		},
	},
	image: {
		down({ doc, i, pt }) {
			const d = rectDrag(i, async (r) => {
				if (!S.pendingImage) {
					const img = await bus.pickImage();
					if (!img) return;
					S.pendingImage = img;
				}
				const img = S.pendingImage;
				const pw = doc.info.pages[i].w;
				let rect;
				if (r) rect = fitAspect(r, img.w, img.h);
				else {
					const w = Math.min(img.w * 0.75, pw * 0.5);
					rect = defaultRect(pt, w, (w * img.h) / img.w, doc, i);
				}
				S.pendingImage = null;
				await addAndSelect(doc, i, { type: "image", rect, bytes: img.bytes }, { keepTool: false });
			});
			d.init(pt);
			return d;
		},
	},
	sign: {
		down({ doc, i, pt }) {
			const d = rectDrag(i, async (r) => {
				const sig = await bus.currentSignature();
				if (!sig) return;
				let rect;
				if (r) rect = fitAspect(r, sig.w, sig.h);
				else {
					const w = 150;
					rect = defaultRect(pt, w, (w * sig.h) / sig.w, doc, i);
				}
				await addAndSelect(doc, i, { type: "image", rect, bytes: sig.bytes, signature: true }, { keepTool: false });
			});
			d.init(pt);
			return d;
		},
	},
	stamp: {
		down({ doc, i, pt }) {
			const d = rectDrag(i, async (r) => {
				const custom = S.tp.stampText && S.tp.stampText.trim();
				const rect = r || defaultRect(pt, custom ? Math.max(120, custom.length * 13) : 170, 46, doc, i);
				const spec = custom
					? { type: "textstamp", rect, text: custom, color: hex2rgb(S.tp.colors.stamp) }
					: { type: "stamp", rect, name: S.tp.stampName };
				await addAndSelect(doc, i, spec);
			});
			d.init(pt);
			return d;
		},
	},
	crop: {
		down({ doc, i, pt }) {
			const d = rectDrag(i, async (r) => {
				if (!r) return;
				const res = await modal({
					title: "crop",
					body: el("div.f-help", {}, `crop to ${Math.round(r[2] - r[0])} x ${Math.round(r[3] - r[1])} pt.\nnothing is deleted; the rest of the page is just hidden (crop box). 'pages > remove crop' undoes it.`),
					buttons: [{ label: "cancel", value: null }, { label: "all pages", value: "all" }, { label: "this page", value: "one", primary: true }],
				});
				if (!res.value) return;
				await op(doc, "cropPage", res.value === "all" ? "all" : [i], r);
				bus.emit("set-tool", "select");
			});
			d.init(pt);
			return d;
		},
	},
};

function markupTool(type) {
	return {
		down({ doc, i, pt }) {
			return textSelectDrag(doc, i, pt, async () => {
				if (doc.selection && doc.selection.quads.length) await markupSelection(type);
			});
		},
	};
}

function shapeTool(type) {
	return {
		down({ doc, i, pt }) {
			const d = rectDrag(i, async (r) => {
				if (!r) r = defaultRect(pt, 80, 50, doc, i);
				await op(doc, "addAnnot", i, {
					type, rect: r, color: color(type), width: S.tp.width, opacity: S.tp.opacity,
					fill: S.tp.fill ? hex2rgb(S.tp.fill) : null,
				});
			});
			d.init(pt);
			return d;
		},
	};
}

function lineTool(type) {
	return {
		down({ doc, i, pt }) {
			let last = null;
			return {
				move(p, e) {
					if (e.shiftKey) {
						const dx = p[0] - pt[0], dy = p[1] - pt[1];
						const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
						const len = Math.hypot(dx, dy);
						p = [pt[0] + Math.cos(ang) * len, pt[1] + Math.sin(ang) * len];
					}
					last = p;
					ghostG(i).replaceChildren(svg("line", { class: "ghost", x1: pt[0], y1: pt[1], x2: p[0], y2: p[1], style: `stroke:${S.tp.colors[type]};stroke-width:${S.tp.width}px;stroke-dasharray:none` }));
				},
				async up(p, e, moved) {
					clearGhost(i);
					if (!moved || !last) return;
					await op(doc, "addAnnot", i, { type, a: pt, b: last, color: color(type), width: S.tp.width, opacity: S.tp.opacity });
				},
			};
		},
	};
}

function moveDrag(doc, i, a, start) {
	return {
		move(p) {
			const dx = p[0] - start[0], dy = p[1] - start[1];
			const r = a.rect;
			ghostG(i).replaceChildren(svg("rect", { class: "ghost", x: r[0] + dx, y: r[1] + dy, width: r[2] - r[0], height: r[3] - r[1] }));
		},
		async up(p, e, moved) {
			clearGhost(i);
			if (!moved) return;
			const dx = p[0] - start[0], dy = p[1] - start[1];
			await op(doc, "moveAnnot", i, a.id, dx, dy);
			await pageData(doc, i);
			drawOverlay(i);
			bus.emit("annot-selected", doc);
		},
	};
}

function resizeDrag(doc, i, a, k) {
	const r0 = a.rect;
	let r = r0;
	return {
		move(p, e) {
			let [x0, y0, x1, y1] = r0;
			if (k.includes("w")) x0 = p[0];
			if (k.includes("e")) x1 = p[0];
			if (k.includes("n")) y0 = p[1];
			if (k.includes("s")) y1 = p[1];
			if (e.shiftKey || a.type === "Stamp") {
				// keep aspect ratio
				const ar = (r0[2] - r0[0]) / Math.max(0.01, r0[3] - r0[1]);
				const w = Math.abs(x1 - x0), h = w / ar;
				if (k.includes("n")) y0 = y1 - h; else y1 = y0 + h;
			}
			r = rectOf([x0, y0], [x1, y1]);
			ghostG(i).replaceChildren(svg("rect", { class: "ghost", x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1] }));
		},
		async up(p, e, moved) {
			clearGhost(i);
			if (!moved || r[2] - r[0] < 2 || r[3] - r[1] < 2) return;
			await op(doc, "resizeAnnot", i, a.id, r);
			await pageData(doc, i);
			drawOverlay(i);
			bus.emit("annot-selected", doc);
		},
	};
}

/** Ramer-Douglas-Peucker to keep ink annotations light. */
function simplify(pts, eps) {
	if (pts.length < 3) return pts;
	const d = (p, a, b) => {
		const dx = b[0] - a[0], dy = b[1] - a[1];
		const l = Math.hypot(dx, dy) || 1e-9;
		return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / l;
	};
	let max = 0, idx = 0;
	for (let k = 1; k < pts.length - 1; k++) {
		const v = d(pts[k], pts[0], pts[pts.length - 1]);
		if (v > max) { max = v; idx = k; }
	}
	if (max > eps) return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)];
	return [pts[0], pts[pts.length - 1]];
}

// ------------------------------------------------------------ inline editors
let inline = null;

function closeInline() {
	if (inline) {
		inline.node.remove();
		inline = null;
	}
}

async function commitInline() {
	if (!inline) return;
	const it = inline;
	inline = null;
	it.node.remove();
	try {
		await it.commit(it.node.value);
	} catch (e) {
		toast(cleanErr(e), { error: true });
	}
}

function refreshInlineEditors() {
	if (inline && inline.place) inline.place();
}

function placeAt(node, doc, i, x, y) {
	const p = doc.info.pages[i];
	node.style.left = (x - p.bounds[0]) * doc.zoom + "px";
	node.style.top = (y - p.bounds[1]) * doc.zoom + "px";
}

function openLineEditor(doc, i, line) {
	closeInline();
	const ed = S.tp.edit;
	const fam = ed.family && !ed.family.startsWith("sys:") && ed.family !== "original" ? ed.family : line.family;
	const input = el("input.inline-edit", { type: "text", value: line.text, spellcheck: false });
	const size = ed.size || line.size;
	const v = views[i];
	const place = () => {
		placeAt(input, doc, i, line.bbox[0] - 1, line.bbox[1] - 1);
		input.style.height = (line.bbox[3] - line.bbox[1] + 2) * doc.zoom + "px";
		input.style.fontSize = size * doc.zoom + "px";
		fit();
	};
	const fit = () => {
		input.style.width = "0px";
		input.style.width = Math.max((line.bbox[2] - line.bbox[0] + 4) * doc.zoom, input.scrollWidth + 8) + "px";
	};
	input.style.fontFamily = FONT_CSS[fam] || FONT_CSS.helv;
	input.style.fontWeight = (ed.bold ?? line.bold) ? "700" : "400";
	input.style.fontStyle = (ed.italic ?? line.italic) ? "italic" : "normal";
	input.style.color = ed.color || rgb2hex(line.color) || "#000";
	input.addEventListener("input", fit);
	input.addEventListener("keydown", (e) => {
		e.stopPropagation();
		if (e.key === "Enter") { e.preventDefault(); commitInline(); }
		if (e.key === "Escape") { e.preventDefault(); closeInline(); }
	});
	input.addEventListener("blur", () => setTimeout(() => { if (inline && inline.node === input) commitInline(); }, 120));
	v.layer.append(input);
	place();
	inline = {
		node: input, place,
		commit: async (value) => {
			if (value === line.text && !ed.size && !ed.color && ed.bold == null && ed.italic == null && (!ed.family || ed.family === "original")) return;
			const opts = {};
			if (ed.family && ed.family !== "original") opts.family = ed.family;
			if (ed.bold != null) opts.bold = ed.bold;
			if (ed.italic != null) opts.italic = ed.italic;
			if (ed.size) opts.size = ed.size;
			if (ed.color) opts.color = hex2rgb(ed.color);
			const target = { bbox: line.bbox, text: line.text };
			await op(doc, "editLine", i, target, value, opts);
		},
	};
	bus.emit("line-editing", line);
	input.focus();
	input.setSelectionRange(input.value.length, input.value.length);
}

function openTextEditor(doc, i, pt, existing = null) {
	closeInline();
	const size = existing ? existing.fontSize || S.tp.fontSize : S.tp.fontSize;
	const fam = existing ? ({ Helv: "helv", TiRo: "times", Cour: "cour" }[existing.font] || "helv") : S.tp.family;
	const col = existing ? rgb2hex(existing.textColor) || "#000" : S.tp.colors.addtext;
	const ta = el("textarea.inline-edit", { spellcheck: false, rows: 1 }, existing ? existing.contents : "");
	const x = existing ? existing.rect[0] : pt[0];
	const y = existing ? existing.rect[1] : pt[1] - size * 0.7;
	const place = () => {
		placeAt(ta, doc, i, x, y);
		ta.style.fontSize = size * doc.zoom + "px";
		grow();
	};
	const grow = () => {
		ta.style.height = "0px";
		ta.style.width = "0px";
		ta.style.width = Math.max(60 * doc.zoom, ta.scrollWidth + 12) + "px";
		ta.style.height = ta.scrollHeight + 4 + "px";
	};
	ta.style.fontFamily = FONT_CSS[fam];
	ta.style.color = col;
	ta.style.whiteSpace = "pre";
	ta.addEventListener("input", grow);
	ta.addEventListener("keydown", (e) => {
		e.stopPropagation();
		if (e.key === "Escape") { e.preventDefault(); closeInline(); }
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitInline(); }
	});
	ta.addEventListener("blur", () => setTimeout(() => { if (inline && inline.node === ta) commitInline(); }, 120));
	views[i].layer.append(ta);
	place();
	inline = {
		node: ta, place,
		commit: async (value) => {
			const text = value.replace(/\s+$/, "");
			// measure the text the way it will be drawn
			const ctx = document.createElement("canvas").getContext("2d");
			ctx.font = `${size}px ${FONT_CSS[fam]}`;
			const lines = text.split("\n");
			const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) * 1.06 + size * 0.6 + 4;
			const h = lines.length * size * 1.2 + size * 0.5 + 2;
			if (existing) {
				if (!text) { await op(doc, "deleteAnnot", i, existing.id); return; }
				await op(doc, "updateAnnot", i, existing.id, { contents: text, rect: [x, y, x + Math.max(w, existing.rect[2] - existing.rect[0]), y + h] });
				return;
			}
			if (!text) return;
			await addAndSelect(doc, i, { type: "text", rect: [x, y, x + w, y + h], text, size, family: fam, color: hex2rgb(col) });
		},
	};
	ta.focus();
	if (existing) ta.select();
}

function editFreeText(doc, i, a) {
	openTextEditor(doc, i, null, a);
}

async function editNote(doc, i, a) {
	const text = await promptBox("comment", "text", a.contents || "", { multiline: true });
	if (text == null) return;
	await op(doc, "updateAnnot", i, a.id, { contents: text });
	bus.emit("annot-selected", doc);
}

// ------------------------------------------------------------------ forms
async function activateWidget(doc, i, w) {
	if (w.type === "checkbox" || w.type === "radiobutton") {
		await op(doc, "setField", i, w.id, "toggle");
		return;
	}
	if (w.type === "combobox" || w.type === "listbox") {
		const v = views[i];
		const r = v.el.getBoundingClientRect();
		const p = doc.info.pages[i];
		popupMenu((w.options || []).map((o) => ({ label: o, checked: o === w.value ? true : undefined, action: () => op(doc, "setField", i, w.id, o) })),
			r.left + (w.rect[0] - p.bounds[0]) * doc.zoom, r.top + (w.rect[3] - p.bounds[1]) * doc.zoom);
		return;
	}
	if (w.type !== "text") {
		toast(w.type + " fields aren't interactive here. use 'sign' to place a signature.");
		return;
	}
	closeInline();
	const node = w.multiline ? el("textarea.field-input", { spellcheck: false }, w.value || "") : el("input.field-input", { type: w.password ? "password" : "text", value: w.value || "", spellcheck: false });
	if (w.maxLen > 0) node.maxLength = w.maxLen;
	const place = () => {
		placeAt(node, doc, i, w.rect[0], w.rect[1]);
		node.style.width = (w.rect[2] - w.rect[0]) * doc.zoom + "px";
		node.style.height = (w.rect[3] - w.rect[1]) * doc.zoom + "px";
		const fs = w.fontSize > 0 ? w.fontSize : Math.min(12, (w.rect[3] - w.rect[1]) * 0.7);
		node.style.fontSize = fs * doc.zoom + "px";
		node.style.fontFamily = FONT_CSS.helv;
	};
	node.addEventListener("keydown", (e) => {
		e.stopPropagation();
		if (e.key === "Escape") { e.preventDefault(); closeInline(); }
		if (e.key === "Enter" && !w.multiline) { e.preventDefault(); commitInline(); }
		if (e.key === "Tab") { e.preventDefault(); commitInline().then(() => nextField(doc, i, w, e.shiftKey ? -1 : 1)); }
	});
	node.addEventListener("blur", () => setTimeout(() => { if (inline && inline.node === node) commitInline(); }, 120));
	views[i].layer.append(node);
	place();
	inline = {
		node, place,
		commit: async (value) => {
			if (value === (w.value || "")) return;
			await op(doc, "setField", i, w.id, value);
		},
	};
	node.focus();
	node.select && node.select();
}

async function nextField(doc, i, w, dir) {
	const c = await pageData(doc, i);
	const list = c.widgets.filter((x) => x.type === "text" && !x.readOnly);
	const k = list.findIndex((x) => x.id === w.id);
	const n = list[k + dir];
	if (n) activateWidget(doc, i, n);
}

// ------------------------------------------------------------- search hits
export function showSearch(doc) {
	redrawOverlays();
	const s = doc.search;
	const h = s.flat[s.index];
	if (h) {
		const q = h.quads[0];
		const v = views[h.page];
		if (!v) return;
		const p = doc.info.pages[h.page];
		const y = v.el.offsetTop + (q[1] - p.bounds[1]) * doc.zoom;
		const x = v.el.offsetLeft + (q[0] - p.bounds[0]) * doc.zoom;
		if (y < viewer.scrollTop + 40 || y > viewer.scrollTop + viewer.clientHeight - 60) viewer.scrollTop = y - viewer.clientHeight / 3;
		if (x < viewer.scrollLeft || x > viewer.scrollLeft + viewer.clientWidth - 40) viewer.scrollLeft = x - viewer.clientWidth / 3;
	}
}

export function viewerEl() { return viewer; }
export function isEditingInline() { return !!inline; }
