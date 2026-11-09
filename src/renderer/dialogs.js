// fuck pdf - dialogs. each returns plain options (or null when cancelled).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { el, modal, row, hex2rgb, rgb2hex, PALETTE, toast } from "./ui.js";
import { FINGER, BANNER } from "./ascii.js";
import { S, api } from "./state.js";

const PAGE_SIZES = {
	"A4 (210 x 297 mm)": [595.276, 841.89],
	"Letter (8.5 x 11 in)": [612, 792],
	"Legal (8.5 x 14 in)": [612, 1008],
	"A3 (297 x 420 mm)": [841.89, 1190.55],
	"A5 (148 x 210 mm)": [419.53, 595.276],
	"B5 (176 x 250 mm)": [498.9, 708.66],
};

function colorPicker(name, value = "#000000") {
	const input = el("input", { type: "color", name, value });
	const sw = PALETTE.map((c) => el("button.sw", { type: "button", style: { background: c }, title: c, on: { click: () => { input.value = c; } } }));
	return el("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, input, el("div.swatches", { style: { flex: 1, margin: 0 } }, sw));
}

function select(name, options, value) {
	return el("select", { name }, options.map(([v, l]) => el("option", { value: v, selected: v === value }, l)));
}

function fontOptions(includeOriginal = false) {
	const base = [["helv", "Helvetica / Arial"], ["times", "Times"], ["cour", "Courier"]];
	if (includeOriginal) base.unshift(["original", "same as original"]);
	const sys = (S.systemFonts || []).map((f) => [f.key, f.name]);
	return [...base, ...sys];
}

// ------------------------------------------------------------------ password
export async function passwordDialog(name, wrong) {
	const r = await modal({
		title: "password",
		body: el("div", {},
			el("div.f-help", {}, `${name} is encrypted.${wrong ? "\nthat password didn't work. try again." : ""}`),
			row("password", el("input", { type: "password", name: "pw", autofocus: true }))),
		buttons: [{ label: "cancel", value: false }, { label: "open", value: true, primary: true }],
	});
	return r.value ? r.form.pw : null;
}

// ----------------------------------------------------------- save options
export async function saveOptionsDialog(doc, { title = "save as / optimize / protect" } = {}) {
	const enc = doc.info.encryption && doc.info.encryption !== "None";
	const pwRows = el("div", { style: { display: "none" } },
		row("open password", el("input", { type: "password", name: "userPassword", placeholder: "needed to open (optional)" })),
		row("owner password", el("input", { type: "password", name: "ownerPassword", placeholder: "needed to change permissions" })),
		el("div.f-help", {}, "allow:"),
		el("div.f-checks", {}, ["print", "copy", "edit", "annotate", "form", "assemble"].map((k) =>
			el("label.chk", {}, el("input", { type: "checkbox", name: "perm_" + k, checked: true }), k))),
	);
	const sec = select("security", [["keep", enc ? "keep current password" : "no password"], ["set", "set new password (AES-256)"], ...(enc ? [["remove", "remove password + restrictions"]] : [])], "keep");
	sec.addEventListener("change", () => { pwRows.style.display = sec.value === "set" ? "" : "none"; });
	const body = el("div", {},
		row("security", sec),
		pwRows,
		el("div.f-sep"),
		el("label.chk", {}, el("input", { type: "checkbox", name: "optimize" }), "optimize (compress, dedupe, subset fonts)"),
		el("br"),
		el("label.chk", {}, el("input", { type: "checkbox", name: "sanitize" }), "sanitize (strip metadata, javascript, auto-actions)"),
		el("br"),
		el("label.chk", {}, el("input", { type: "checkbox", name: "flatten" }), "flatten annotations + form fields into the page"),
		el("div.f-help", { style: { marginTop: "10px" } }, "the document you're editing isn't changed by these options; they apply to the saved file only (except flatten)."),
	);
	const r = await modal({
		title, body,
		buttons: [{ label: "cancel", value: false }, {
			label: "save...", value: true, primary: true,
			validate: (f) => {
				if (f.security === "set" && !f.userPassword && !f.ownerPassword) { toast("enter at least one password", { error: true }); return false; }
				return true;
			},
		}],
	});
	if (!r.value) return null;
	const f = r.form;
	const permissions = {};
	for (const k of ["print", "copy", "edit", "annotate", "form", "assemble"]) permissions[k] = f["perm_" + k];
	return { security: f.security, userPassword: f.userPassword, ownerPassword: f.ownerPassword, permissions, optimize: f.optimize, sanitize: f.sanitize, flatten: f.flatten };
}

export async function protectDialog(doc) {
	const pwRows = el("div", {},
		row("open password", el("input", { type: "password", name: "userPassword", autofocus: true, placeholder: "required to open the file" })),
		row("repeat", el("input", { type: "password", name: "userPassword2" })),
		row("owner password", el("input", { type: "password", name: "ownerPassword", placeholder: "optional, for permissions" })),
		el("div.f-help", {}, "allow people with the open password to:"),
		el("div.f-checks", {}, ["print", "copy", "edit", "annotate", "form", "assemble"].map((k) =>
			el("label.chk", {}, el("input", { type: "checkbox", name: "perm_" + k, checked: true }), k))),
		el("div.f-help", { style: { marginTop: "10px" } }, "encrypted with AES-256. no backdoor, so don't forget it."),
	);
	const r = await modal({
		title: "protect with password",
		body: pwRows,
		buttons: [{ label: "cancel", value: false }, {
			label: "encrypt + save...", value: true, primary: true,
			validate: (f) => {
				if (!f.userPassword && !f.ownerPassword) { toast("enter a password", { error: true }); return false; }
				if (f.userPassword !== f.userPassword2) { toast("passwords don't match", { error: true }); return false; }
				return true;
			},
		}],
	});
	if (!r.value) return null;
	const f = r.form;
	const permissions = {};
	for (const k of ["print", "copy", "edit", "annotate", "form", "assemble"]) permissions[k] = f["perm_" + k];
	return { security: "set", userPassword: f.userPassword, ownerPassword: f.ownerPassword, permissions };
}

// ----------------------------------------------------------------- watermark
export async function watermarkDialog() {
	const body = el("div", {},
		row("text", el("input", { type: "text", name: "text", value: "CONFIDENTIAL", autofocus: true })),
		row("font", select("family", fontOptions(), "helv")),
		row("size", el("input", { type: "number", name: "size", value: "", placeholder: "auto (fills the page)", min: 4, max: 400 })),
		row("colour", colorPicker("color", "#888888")),
		row("opacity", el("input", { type: "range", name: "opacity", min: 5, max: 100, value: 30 })),
		row("angle", el("input", { type: "number", name: "angle", value: 45, min: -180, max: 180 })),
		row("pages", el("input", { type: "text", name: "pages", value: "all", placeholder: "all, 1-3, 5, odd, even" })),
		row("layer", select("layer", [["over", "on top of content"], ["under", "behind content"]], "over")),
		el("div.f-help", {}, "written into the page content (not an annotation), so it prints and can't just be clicked away."),
	);
	const r = await modal({ title: "watermark", body, buttons: [{ label: "cancel", value: false }, { label: "apply", value: true, primary: true }] });
	if (!r.value) return null;
	const f = r.form;
	return { text: f.text, family: f.family, size: f.size || 0, color: hex2rgb(f.color), opacity: f.opacity / 100, angle: f.angle ?? 45, pages: f.pages, under: f.layer === "under", bold: true };
}

// -------------------------------------------------------------- header/footer
export async function headerFooterDialog(doc) {
	const inputs = {};
	const mk = (n) => (inputs[n] = el("input", { type: "text", name: n, spellcheck: false }));
	const presets = [
		["page numbers", { fc: "{page}" }],
		["page X of Y", { fr: "page {page} of {pages}" }],
		["bates", { fr: "{bates}" }],
		["file + date", { hl: "{file}", hr: "{date}" }],
		["clear", {}],
	];
	const body = el("div", {},
		el("div.presets", {}, presets.map(([l, p]) => el("button", {
			type: "button",
			on: { click: () => { for (const k of ["hl", "hc", "hr", "fl", "fc", "fr"]) inputs[k].value = p[k] || ""; } },
		}, l))),
		el("div.f-help", {}, "tokens: {page} {pages} {date} {file} {bates}"),
		el("div.f-help", {}, "header      left / centre / right"),
		el("div.f-grid3", {}, mk("hl"), mk("hc"), mk("hr")),
		el("div.f-help", { style: { marginTop: "8px" } }, "footer      left / centre / right"),
		el("div.f-grid3", {}, mk("fl"), mk("fc"), mk("fr")),
		el("div.f-sep"),
		row("font", select("family", fontOptions(), "helv")),
		row("size", el("input", { type: "number", name: "size", value: 10, min: 4, max: 72 })),
		row("colour", colorPicker("color", "#000000")),
		row("margin (pt)", el("input", { type: "number", name: "margin", value: 28, min: 0, max: 200 })),
		row("first number", el("input", { type: "number", name: "start", value: 1 })),
		row("pages", el("input", { type: "text", name: "pages", value: "all" })),
		el("div.f-sep"),
		row("bates prefix", el("input", { type: "text", name: "batesPrefix", value: "" })),
		row("bates start", el("input", { type: "number", name: "batesStart", value: 1, min: 0 })),
		row("bates digits", el("input", { type: "number", name: "batesDigits", value: 6, min: 1, max: 12 })),
	);
	inputs.fc.value = "{page}";
	const r = await modal({ title: "header, footer, page numbers, bates", body, width: 620, buttons: [{ label: "cancel", value: false }, { label: "apply", value: true, primary: true }] });
	if (!r.value) return null;
	const f = r.form;
	return {
		header: [f.hl, f.hc, f.hr], footer: [f.fl, f.fc, f.fr],
		family: f.family, size: f.size || 10, color: hex2rgb(f.color), margin: f.margin ?? 28,
		start: f.start ?? 1, pages: f.pages,
		batesPrefix: f.batesPrefix, batesStart: f.batesStart ?? 1, batesDigits: f.batesDigits || 6,
	};
}

// ----------------------------------------------------------------- pages
export async function insertBlankDialog(doc, current) {
	const body = el("div", {},
		row("how many", el("input", { type: "number", name: "count", value: 1, min: 1, max: 500, autofocus: true })),
		row("size", select("size", [["same", "same as current page"], ...Object.keys(PAGE_SIZES).map((k) => [k, k])], "same")),
		row("orientation", select("orient", [["portrait", "portrait"], ["landscape", "landscape"]], "portrait")),
		row("where", select("where", [["after", `after page ${current + 1}`], ["before", `before page ${current + 1}`], ["end", "at the end"], ["start", "at the start"]], "after")),
	);
	const r = await modal({ title: "insert blank pages", body, buttons: [{ label: "cancel", value: false }, { label: "insert", value: true, primary: true }] });
	if (!r.value) return null;
	const f = r.form;
	let w = 0, h = 0;
	if (f.size !== "same") [w, h] = PAGE_SIZES[f.size];
	else { const p = doc.info.pages[current]; w = p.w; h = p.h; }
	if ((f.orient === "landscape") !== (w > h)) [w, h] = [h, w];
	const n = doc.info.pages.length;
	const at = { after: current + 1, before: current, end: n, start: 0 }[f.where];
	return { count: Math.max(1, f.count || 1), w, h, at };
}

export async function insertFileDialog(doc, current, name, pageCount) {
	const body = el("div", {},
		el("div.f-help", {}, `${name}${pageCount ? ` (${pageCount} pages)` : ""}`),
		row("pages", el("input", { type: "text", name: "range", value: "all", placeholder: "all, 1-3, 7" })),
		row("where", select("where", [["after", `after page ${current + 1}`], ["before", `before page ${current + 1}`], ["end", "at the end"], ["start", "at the start"]], "end")),
	);
	const r = await modal({ title: "insert pages from file", body, buttons: [{ label: "cancel", value: false }, { label: "insert", value: true, primary: true }] });
	if (!r.value) return null;
	const n = doc.info.pages.length;
	return { range: r.form.range === "all" ? null : r.form.range, at: { after: current + 1, before: current, end: n, start: 0 }[r.form.where] };
}

export async function rangeDialog(title, help, value, okLabel = "ok") {
	const r = await modal({
		title,
		body: el("div", {}, el("div.f-help", {}, help), row("pages", el("input", { type: "text", name: "range", value, autofocus: true, placeholder: "e.g. 1-3, 7, 10-end, odd" }))),
		buttons: [{ label: "cancel", value: false }, { label: okLabel, value: true, primary: true }],
	});
	return r.value ? r.form.range : null;
}

export async function splitDialog(doc) {
	const n = doc.info.pages.length;
	const body = el("div", {},
		row("split", select("mode", [["every", "every N pages"], ["ranges", "custom ranges"]], "every")),
		row("N", el("input", { type: "number", name: "every", value: 1, min: 1, max: n })),
		row("ranges", el("input", { type: "text", name: "ranges", placeholder: "1-3; 4-10; 11-end" })),
		el("div.f-help", {}, `${n} pages. each part is saved as its own pdf in a folder you pick.`),
	);
	const r = await modal({ title: "split document", body, buttons: [{ label: "cancel", value: false }, { label: "choose folder + split", value: true, primary: true }] });
	if (!r.value) return null;
	return r.form.mode === "ranges" ? { ranges: r.form.ranges } : { every: r.form.every || 1 };
}

export async function resizeDialog(doc) {
	const body = el("div", {},
		row("new size", select("size", Object.keys(PAGE_SIZES).map((k) => [k, k]), "A4 (210 x 297 mm)")),
		row("orientation", select("orient", [["auto", "match each page"], ["portrait", "portrait"], ["landscape", "landscape"]], "auto")),
		row("pages", el("input", { type: "text", name: "pages", value: "all" })),
		el("div.f-help", {}, "content is scaled to fit and centred."),
	);
	const r = await modal({ title: "resize pages", body, buttons: [{ label: "cancel", value: false }, { label: "resize", value: true, primary: true }] });
	if (!r.value) return null;
	return { size: PAGE_SIZES[r.form.size], orient: r.form.orient, pages: r.form.pages };
}

export async function exportImagesDialog(doc) {
	const body = el("div", {},
		row("pages", el("input", { type: "text", name: "pages", value: "all" })),
		row("format", select("format", [["png", "PNG"], ["jpg", "JPEG"]], "png")),
		row("resolution", select("dpi", [["72", "72 dpi (screen)"], ["150", "150 dpi"], ["200", "200 dpi"], ["300", "300 dpi (print)"], ["600", "600 dpi"]], "150")),
	);
	const r = await modal({ title: "export pages as images", body, buttons: [{ label: "cancel", value: false }, { label: "choose folder + export", value: true, primary: true }] });
	if (!r.value) return null;
	return { pages: r.form.pages, format: r.form.format, dpi: Number(r.form.dpi) };
}

export async function metadataDialog(doc) {
	const m = doc.info.meta || {};
	const fields = ["Title", "Author", "Subject", "Keywords", "Creator", "Producer"];
	const body = el("div", {},
		fields.map((k) => row(k.toLowerCase(), el("input", { type: "text", name: k, value: m[k] || "" }))),
		el("div.kv", { style: { marginTop: "10px" } },
			el("span", {}, "created"), el("span", {}, m.CreationDate || "-"),
			el("span", {}, "modified"), el("span", {}, m.ModDate || "-"),
			el("span", {}, "format"), el("span", {}, doc.info.format || "-"),
			el("span", {}, "security"), el("span", {}, doc.info.encryption || "none"),
			el("span", {}, "pages"), el("span", {}, String(doc.info.pages.length)),
			el("span", {}, "file"), el("span", { title: doc.info.path || "" }, doc.info.path || "(not saved yet)"),
		),
	);
	const r = await modal({ title: "document properties", body, width: 560, buttons: [{ label: "cancel", value: false }, { label: "apply", value: true, primary: true }] });
	return r.value ? r.form : null;
}

export async function searchRedactDialog() {
	const body = el("div", {},
		row("find", el("input", { type: "text", name: "q", autofocus: true, placeholder: "name, number, email..." })),
		el("label.chk", {}, el("input", { type: "checkbox", name: "matchCase" }), "match case"),
		el("div.f-help", { style: { marginTop: "10px" } }, "every match is marked for redaction first so you can review it.\nthen 'apply redactions' removes the text for real (not just a black box)."),
	);
	const r = await modal({ title: "search + redact", body, buttons: [{ label: "cancel", value: false }, { label: "mark matches", value: true, primary: true }] });
	return r.value && r.form.q ? { q: r.form.q, matchCase: r.form.matchCase } : null;
}

// ----------------------------------------------------------------- file lists
export async function fileListDialog({ title, help, files, addKind = "open", okLabel = "ok", extra = null }) {
	let list = [...files];
	const box = el("div.file-list");
	const draw = () => {
		box.replaceChildren(...(list.length ? list.map((f, k) => el("div.fl", {},
			el("span", { title: f }, `${k + 1}. ${f.split(/[\\/]/).pop()}`),
			el("button", { type: "button", title: "up", disabled: k === 0, on: { click: () => { [list[k - 1], list[k]] = [list[k], list[k - 1]]; draw(); } } }, "^"),
			el("button", { type: "button", title: "down", disabled: k === list.length - 1, on: { click: () => { [list[k + 1], list[k]] = [list[k], list[k + 1]]; draw(); } } }, "v"),
			el("button", { type: "button", title: "remove", on: { click: () => { list.splice(k, 1); draw(); } } }, "x"),
		)) : [el("div.empty-note", {}, "no files yet")]));
	};
	draw();
	const add = el("button.btn", { type: "button", on: { click: async () => { const more = await api.openDialog({ multi: true, kind: addKind, title: "add files" }); list.push(...more); draw(); } } }, "+ add files");
	const body = el("div", {}, help ? el("div.f-help", {}, help) : null, box, add, extra);
	const r = await modal({ title, body, width: 560, buttons: [{ label: "cancel", value: false }, { label: okLabel, value: true, primary: true }] });
	if (!r.value || !list.length) return null;
	return { files: list, form: r.form };
}

// ----------------------------------------------------------------- signature
export async function signatureDialog() {
	const W = 520, H = 180;
	const canvas = el("canvas.sig-pad", { width: W * 2, height: H * 2, style: { width: W + "px", height: H + "px" } });
	const ctx = canvas.getContext("2d");
	ctx.scale(2, 2);
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	let inkColor = "#0b1f8a";
	let width = 2.6;
	let strokes = 0;
	let drawing = false, last = null;
	const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
	canvas.addEventListener("pointerdown", (e) => { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); strokes++; });
	canvas.addEventListener("pointermove", (e) => {
		if (!drawing) return;
		const p = pos(e);
		const pressure = e.pressure && e.pressure !== 0.5 ? e.pressure : 0.5;
		ctx.strokeStyle = inkColor;
		ctx.lineWidth = width * (0.6 + pressure * 0.8);
		ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(...p); ctx.stroke();
		last = p;
	});
	canvas.addEventListener("pointerup", () => { drawing = false; });

	const typed = el("input", { type: "text", placeholder: "type your name", style: { width: "100%", fontSize: "18px" } });
	const fontSel = el("select", {},
		[["'Segoe Script', 'Brush Script MT', 'Lucida Handwriting', cursive", "script"], ["'Lucida Handwriting', 'Segoe Print', cursive", "handwriting"], ["'Times New Roman', serif", "serif italic"], ["'Courier New', monospace", "typewriter"]].map(([v, l]) => el("option", { value: v }, l)));
	const typedPreview = el("canvas.sig-pad", { width: W * 2, height: H * 2, style: { width: W + "px", height: H + "px" } });
	const renderTyped = () => {
		const c = typedPreview.getContext("2d");
		c.setTransform(2, 0, 0, 2, 0, 0);
		c.clearRect(0, 0, W, H);
		c.fillStyle = inkColor;
		const isSerif = fontSel.value.includes("Times");
		let size = 64;
		c.font = `${isSerif ? "italic " : ""}${size}px ${fontSel.value}`;
		while (c.measureText(typed.value).width > W - 30 && size > 12) { size -= 2; c.font = `${isSerif ? "italic " : ""}${size}px ${fontSel.value}`; }
		c.textBaseline = "middle";
		c.textAlign = "center";
		c.fillText(typed.value, W / 2, H / 2);
	};
	typed.addEventListener("input", renderTyped);
	fontSel.addEventListener("change", renderTyped);

	let imageData = null;
	const imgPreview = el("div.f-help", {}, "pick a png/jpg of your signature (transparent png works best).");
	const pickImg = el("button.btn", { type: "button", on: { click: async () => {
		const [p] = await api.openDialog({ kind: "images" });
		if (!p) return;
		const { bytes } = await api.readFile(p);
		imageData = await bytesToDataURL(bytes, p);
		imgPreview.replaceChildren(el("img", { src: imageData, style: { maxWidth: "100%", maxHeight: "160px", background: "#fff" } }));
	} } }, "choose image...");

	const panes = {
		draw: el("div", {}, canvas, el("div.pp-btns", {}, el("button", { type: "button", on: { click: () => { ctx.clearRect(0, 0, W, H); strokes = 0; } } }, "clear"))),
		type: el("div", { style: { display: "none" } }, typed, el("div", { style: { margin: "8px 0" } }, fontSel), typedPreview),
		image: el("div", { style: { display: "none" } }, pickImg, imgPreview),
	};
	let mode = "draw";
	const seg = el("div.seg", {}, ["draw", "type", "image"].map((m) => el("button" + (m === "draw" ? ".on" : ""), {
		type: "button",
		on: { click: (e) => {
			mode = m;
			seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === e.currentTarget));
			for (const [k, p] of Object.entries(panes)) p.style.display = k === m ? "" : "none";
			if (m === "type") setTimeout(() => typed.focus(), 10);
		} },
	}, m)));
	const colors = el("div.pp-btns", {}, el("span.dim", {}, "ink:"), ["#0b1f8a", "#000000", "#b00000"].map((c) => el("button.sw", {
		type: "button", style: { background: c, width: "26px" },
		on: { click: () => { inkColor = c; renderTyped(); } },
	})));
	const r = await modal({
		title: "new signature",
		body: el("div", {}, seg, panes.draw, panes.type, panes.image, colors, el("div.f-help", { style: { marginTop: "8px" } }, "stored locally on this computer only.")),
		width: 580,
		buttons: [{ label: "cancel", value: false }, { label: "save signature", value: true, primary: true }],
	});
	if (!r.value) return null;
	if (mode === "draw") return strokes ? trimCanvas(canvas) : null;
	if (mode === "type") return typed.value.trim() ? trimCanvas(typedPreview) : null;
	return imageData;
}

function trimCanvas(c) {
	const ctx = c.getContext("2d");
	const { width, height } = c;
	const data = ctx.getImageData(0, 0, width, height).data;
	let x0 = width, y0 = height, x1 = 0, y1 = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (data[(y * width + x) * 4 + 3] > 8) {
				if (x < x0) x0 = x; if (x > x1) x1 = x;
				if (y < y0) y0 = y; if (y > y1) y1 = y;
			}
		}
	}
	if (x1 <= x0 || y1 <= y0) return null;
	const pad = 6;
	x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(width, x1 + pad); y1 = Math.min(height, y1 + pad);
	const out = document.createElement("canvas");
	out.width = x1 - x0; out.height = y1 - y0;
	out.getContext("2d").drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
	return out.toDataURL("image/png");
}

export function bytesToDataURL(bytes, name = "") {
	const type = /\.jpe?g$/i.test(name) ? "image/jpeg" : /\.gif$/i.test(name) ? "image/gif" : /\.webp$/i.test(name) ? "image/webp" : /\.bmp$/i.test(name) ? "image/bmp" : "image/png";
	return new Promise((resolve) => {
		const fr = new FileReader();
		fr.onload = () => resolve(fr.result);
		fr.readAsDataURL(new Blob([bytes], { type }));
	});
}

export function dataURLToBytes(url) {
	const b64 = url.split(",")[1];
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export function imageDims(url) {
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
		img.onerror = () => resolve({ w: 300, h: 100 });
		img.src = url;
	});
}

// ------------------------------------------------------------------- about
export async function aboutDialog() {
	const info = await api.appInfo();
	const body = el("div.about", {},
		el("div", { style: { display: "flex", gap: "28px", alignItems: "center" } },
			el("pre", { style: { fontSize: "10px" } }, FINGER),
			el("div", {},
				el("pre", { style: { fontWeight: 700, fontSize: "11px" } }, BANNER),
				el("p", {}, `version ${info.version}`),
				el("p.dim", { style: { whiteSpace: "pre-line" } },
					"a free pdf viewer + editor.\nno subscription. no account. no telemetry. no paywalled buttons.\n\n" +
					"free software under the GNU AGPL v3 (or later).\nrendering + editing engine: MuPDF by Artifex (AGPL).\napp shell: Electron " + info.electron + "."),
			),
		),
	);
	await modal({ title: "about fuck pdf", body, width: 760, buttons: [{ label: "close", value: true, primary: true }] });
}

export async function shortcutsDialog() {
	const keys = [
		["ctrl+o", "open"], ["ctrl+s", "save"], ["ctrl+shift+s", "save as"], ["ctrl+p", "print"], ["ctrl+w", "close tab"],
		["ctrl+z / ctrl+y", "undo / redo"], ["ctrl+f", "find"], ["ctrl+g", "go to page"], ["ctrl+c", "copy selected text"],
		["ctrl + / ctrl -", "zoom"], ["ctrl+0", "100%"], ["ctrl+1 / ctrl+2", "fit width / fit page"], ["ctrl+wheel", "zoom at cursor"],
		["ctrl+tab", "next tab"], ["delete", "delete selected annotation"], ["esc", "cancel / back to select"],
		["v", "select"], ["h / space+drag", "pan"], ["e", "edit text"], ["t", "add text"], ["l", "highlight"], ["u", "underline"],
		["k", "strike out"], ["d", "draw"], ["r", "box"], ["o", "ellipse"], ["a", "arrow"], ["n", "note"], ["i", "image"], ["s", "sign"],
		["w", "whiteout"], ["x", "redact"], ["c", "crop"], ["ctrl+shift+n", "night mode"], ["f11", "full screen"],
	];
	const body = el("div.kv", { style: { gridTemplateColumns: "150px 1fr" } }, keys.flatMap(([k, v]) => [el("span", {}, k), el("span", {}, v)]));
	await modal({ title: "keyboard", body, width: 520, buttons: [{ label: "close", value: true, primary: true }] });
}
