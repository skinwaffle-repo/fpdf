// fuck pdf - application controller
// Copyright (C) fuck pdf contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { $, $$, el, toast, busy, popupMenu, closeMenus, modal, modalOpen, confirmBox, promptBox, hex2rgb, rgb2hex, PALETTE, fmtBytes, debounce } from "./ui.js";
import { S, cur, E, op, bus, api, applyResult, cleanErr, newDocState, pageVersion, savePrefs, annotName } from "./state.js";
import * as V from "./viewer.js";
import * as D from "./dialogs.js";
import { BANNER, drawFinger } from "./ascii.js";

// =================================================================== tools
const TOOLDEFS = [
	[["select", "I", "select", "v"], ["hand", "<+>", "pan", "h"]],
	[["edittext", "T~", "edit text", "e"], ["addtext", "T+", "add text", "t"], ["image", "[^]", "image", "i"], ["whiteout", "[#]", "whiteout", "w"]],
	[["highlight", "=h=", "highlight", "l"], ["underline", "_u_", "underline", "u"], ["strikeout", "-k-", "strike", "k"], ["note", "[!]", "note", "n"]],
	[["draw", "~~~", "draw", "d"], ["rect", "[ ]", "box", "r"], ["ellipse", "( )", "ellipse", "o"], ["line", " / ", "line", null], ["arrow", "-->", "arrow", "a"]],
	[["sign", "x__", "sign", "s"], ["stamp", "{!}", "stamp", "m"], ["redact", "███", "redact", "x"], ["crop", "+-+", "crop", "c"]],
];
const TOOL_KEYS = Object.fromEntries(TOOLDEFS.flat().filter((t) => t[3]).map((t) => [t[3], t[0]]));
const TOOL_NAMES = Object.fromEntries(TOOLDEFS.flat().map((t) => [t[0], t[2]]));
const MARKUP = new Set(["highlight", "underline", "strikeout", "squiggly"]);

function buildToolbar() {
	const tb = $("#toolbar");
	tb.replaceChildren();
	const act = (ic, lb, fn, title, needsDoc = true) => el("button.tbtn" + (needsDoc ? ".needs-doc" : ""), { title, on: { click: fn } }, el("span.ic", {}, ic), el("span.lb", {}, lb));
	tb.append(el("div.tgroup", {},
		act("./", "open", () => A.open(), "open (ctrl+o)", false),
		act("[s]", "save", () => A.save(), "save (ctrl+s)"),
		act("[p]", "print", () => A.print(), "print (ctrl+p)"),
	));
	tb.append(el("div.tgroup", {},
		el("button.tbtn.needs-doc#tb-undo", { title: "undo (ctrl+z)", on: { click: () => A.undo() } }, el("span.ic", {}, "<~"), el("span.lb", {}, "undo")),
		el("button.tbtn.needs-doc#tb-redo", { title: "redo (ctrl+y)", on: { click: () => A.redo() } }, el("span.ic", {}, "~>"), el("span.lb", {}, "redo")),
	));
	for (const group of TOOLDEFS) {
		tb.append(el("div.tgroup", {}, group.map(([id, ic, lb, key]) => el("button.tbtn.needs-doc", {
			"data-tool": id,
			title: lb + (key ? ` (${key})` : ""),
			on: { click: () => pickTool(id) },
		}, el("span.ic", {}, ic), el("span.lb", {}, lb)))));
	}
	tb.append(el("div.tgroup", {},
		act("+/-", "pages", (e) => pagesMenu(e.currentTarget), "page tools"),
		act("~#~", "mark", () => A.watermark(), "watermark"),
		act("1/n", "numbers", () => A.headerFooter(), "header, footer, page numbers, bates"),
		act("(*)", "lock", () => A.protect(), "protect with password"),
	));
	markTool();
}

function pagesMenu(btn) {
	const r = btn.getBoundingClientRect();
	popupMenu(MENUS.pages(), r.left, r.bottom);
}

function pickTool(id) {
	const doc = cur();
	// a markup tool with text already selected: just apply it
	if (doc && MARKUP.has(id) && doc.selection && doc.selection.quads.length) {
		V.markupSelection(id);
		return;
	}
	if (id === "image") S.pendingImage = null;
	setTool(id);
	if (id === "sign" && !S.settings.signatures.length) newSignature();
}

function setTool(id) {
	V.setTool(id);
	markTool();
	renderProps();
}

function markTool() {
	$$("#toolbar [data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === S.tool));
}

// =================================================================== menus
const MENUS = {
	file: () => [
		{ label: "new blank pdf", key: "ctrl+n", action: () => A.newBlank() },
		{ label: "open...", key: "ctrl+o", action: () => A.open() },
		{ label: "open recent", sub: () => S.settings.recent.length ? S.settings.recent.map((p) => ({ label: shortPath(p), action: () => A.openPaths([p]) })) : [{ label: "(nothing yet)", disabled: true }] },
		"-",
		{ label: "combine files into one pdf...", action: () => A.combine() },
		{ label: "images to pdf...", action: () => A.imagesToPdf() },
		"-",
		{ label: "save", key: "ctrl+s", action: () => A.save(), disabled: noDoc },
		{ label: "save as...", key: "ctrl+shift+s", action: () => A.saveAs(), disabled: noDoc },
		{ label: "save with options (optimize, sanitize)...", action: () => A.saveWithOptions(), disabled: noDoc },
		{ label: "protect with password...", action: () => A.protect(), disabled: noDoc },
		{ label: "remove password + restrictions...", action: () => A.removeSecurity(), disabled: () => !cur() || !isEncrypted(cur()) },
		"-",
		{ label: "export", disabled: noDoc, sub: [
			{ label: "pages as images (png/jpg)...", action: () => A.exportImages() },
			{ label: "all text (.txt)...", action: () => A.exportText() },
			{ label: "some pages as a new pdf...", action: () => A.extract() },
		] },
		{ label: "split into files...", action: () => A.split(), disabled: noDoc },
		"-",
		{ label: "print...", key: "ctrl+p", action: () => A.print(), disabled: noDoc },
		{ label: "document properties...", key: "ctrl+d", action: () => A.properties(), disabled: noDoc },
		{ label: "show in folder", action: () => cur() && cur().info.path && api.showInFolder(cur().info.path), disabled: () => !cur() || !cur().info.path },
		"-",
		{ label: "close tab", key: "ctrl+w", action: () => A.closeTab(), disabled: noDoc },
		{ label: "quit", key: "alt+f4", action: () => api.quit() },
	],
	edit: () => [
		{ label: "undo", key: "ctrl+z", action: () => A.undo(), disabled: () => !cur() || !cur().info.canUndo },
		{ label: "redo", key: "ctrl+y", action: () => A.redo(), disabled: () => !cur() || !cur().info.canRedo },
		"-",
		{ label: "copy text", key: "ctrl+c", action: () => V.copySelection(), disabled: () => !cur() || !cur().selection },
		{ label: "select all text on page", key: "ctrl+a", action: () => selectAllPage(), disabled: noDoc },
		"-",
		{ label: "find...", key: "ctrl+f", action: () => openFind(), disabled: noDoc },
		{ label: "go to page...", key: "ctrl+g", action: () => A.goTo(), disabled: noDoc },
		"-",
		{ label: "delete selected annotation", key: "del", action: () => V.deleteSelectedAnnot(), disabled: () => !cur() || !cur().selectedAnnot },
	],
	view: () => [
		{ label: "zoom in", key: "ctrl +", action: () => V.zoomStep(1), disabled: noDoc },
		{ label: "zoom out", key: "ctrl -", action: () => V.zoomStep(-1), disabled: noDoc },
		{ label: "actual size", key: "ctrl+0", action: () => V.setZoom(1), disabled: noDoc },
		{ label: "fit width", key: "ctrl+1", action: () => V.setZoom(0, { fit: "width" }), disabled: noDoc },
		{ label: "fit page", key: "ctrl+2", action: () => V.setZoom(0, { fit: "page" }), disabled: noDoc },
		"-",
		{ label: "first page", key: "home", action: () => V.goToPage(0), disabled: noDoc },
		{ label: "last page", key: "end", action: () => cur() && V.goToPage(cur().info.pages.length - 1), disabled: noDoc },
		"-",
		{ label: "night mode (invert pages)", key: "ctrl+shift+n", checked: S.night, action: () => A.night() },
		{ label: "sidebar", key: "f4", checked: !document.body.classList.contains("hide-side"), action: () => togglePanel("hide-side") },
		{ label: "properties panel", key: "f6", checked: !document.body.classList.contains("hide-props"), action: () => togglePanel("hide-props") },
		{ label: "full screen", key: "f11", action: () => api.fullscreen() },
	],
	pages: () => [
		{ label: "rotate right", key: "ctrl+r", action: () => A.rotate(90), disabled: noDoc },
		{ label: "rotate left", key: "ctrl+shift+r", action: () => A.rotate(-90), disabled: noDoc },
		{ label: "rotate all pages", sub: [{ label: "right", action: () => A.rotate(90, "all") }, { label: "left", action: () => A.rotate(-90, "all") }, { label: "180", action: () => A.rotate(180, "all") }], disabled: noDoc },
		"-",
		{ label: "insert blank pages...", action: () => A.insertBlank(), disabled: noDoc },
		{ label: "insert pages from file...", action: () => A.insertFile(), disabled: noDoc },
		{ label: "duplicate page", action: () => A.duplicate(), disabled: noDoc },
		{ label: "delete pages...", action: () => A.deletePages(), disabled: noDoc },
		"-",
		{ label: "extract pages to new pdf...", action: () => A.extract(), disabled: noDoc },
		{ label: "split into files...", action: () => A.split(), disabled: noDoc },
		{ label: "reverse page order", action: () => A.reverse(), disabled: noDoc },
		{ label: "resize pages (A4, letter...)...", action: () => A.resize(), disabled: noDoc },
		{ label: "crop (drag a box)", action: () => setTool("crop"), disabled: noDoc },
		{ label: "remove crop from all pages", action: () => A.removeCrop(), disabled: noDoc },
		"-",
		{ label: "header / footer / page numbers / bates...", action: () => A.headerFooter(), disabled: noDoc },
		{ label: "watermark...", action: () => A.watermark(), disabled: noDoc },
	],
	tools: () => [
		...TOOLDEFS.flat().map(([id, , lb, key]) => ({ label: lb, key: key || "", action: () => pickTool(id), disabled: noDoc })),
		"-",
		{ label: "apply redactions (burn in)", action: () => A.applyRedactions(), disabled: noDoc },
		{ label: "search + redact...", action: () => A.searchRedact(), disabled: noDoc },
		"-",
		{ label: "new signature...", action: () => newSignature() },
		{ label: "reset form fields", action: () => A.resetForm(), disabled: noDoc },
		{ label: "flatten annotations + forms", action: () => A.flatten(), disabled: noDoc },
	],
	help: () => [
		{ label: "keyboard shortcuts", key: "f1", action: () => D.shortcutsDialog() },
		{ label: "about fuck pdf", action: () => D.aboutDialog() },
		{ label: "license (GNU AGPL v3)", action: () => api.openExternal("https://www.gnu.org/licenses/agpl-3.0.html") },
		"-",
		{ label: "developer tools", key: "ctrl+shift+i", action: () => api.devtools() },
	],
};
const noDoc = () => !cur();

function buildMenubar() {
	const mb = $("#menubar");
	mb.replaceChildren();
	for (const name of Object.keys(MENUS)) {
		const b = el("button", {}, name);
		const open = () => {
			const r = b.getBoundingClientRect();
			popupMenu(MENUS[name](), r.left, r.bottom);
			b.classList.add("open");
		};
		b.addEventListener("mousedown", (e) => {
			e.preventDefault();
			if (b.classList.contains("open")) { closeMenus(); return; }
			open();
		});
		b.addEventListener("mouseenter", () => {
			if ($("#menubar > button.open") && !b.classList.contains("open")) open();
		});
		mb.append(b);
	}
}

// =================================================================== docs
function shortPath(p) {
	const parts = p.split(/[\\/]/);
	return parts.length > 3 ? "..." + parts.slice(-3).join("/") : p;
}
function isEncrypted(doc) {
	return doc.info.encryption && doc.info.encryption !== "None";
}

async function addDoc(info) {
	const doc = newDocState(info);
	S.docs.push(doc);
	activate(doc.id);
	return doc;
}

function activate(id) {
	const prev = cur();
	if (prev && prev.id !== id) {
		prev.scrollTop = V.viewerEl().scrollTop;
		prev.scrollLeft = V.viewerEl().scrollLeft;
	}
	S.active = id;
	const doc = cur();
	document.body.classList.toggle("no-doc", !doc);
	V.showDoc(doc);
	renderTabs();
	buildThumbs();
	renderOutline();
	refreshNotes();
	renderSearchSide();
	updateStatus();
	renderProps();
	if (!doc) renderWelcome();
	document.title = doc ? `${doc.info.name} - fuck pdf` : "fuck pdf";
}

function renderTabs() {
	const t = $("#tabs");
	t.replaceChildren(...S.docs.map((d) => {
		const tab = el("div.tab" + (d.id === S.active ? ".active" : ""), {
			title: d.info.path || d.info.name,
			on: {
				mousedown: (e) => { if (e.button === 1) { e.preventDefault(); A.closeTab(d); } else if (e.button === 0) activate(d.id); },
			},
		},
		el("span.tname", {}, (d.info.dirty ? "* " : "") + d.info.name),
		el("button.tclose", { title: "close (ctrl+w)", on: { mousedown: (e) => { e.stopPropagation(); A.closeTab(d); } } }, "x"));
		return tab;
	}));
	const doc = cur();
	if (doc) document.title = `${doc.info.dirty ? "* " : ""}${doc.info.name} - fuck pdf`;
}

async function openInfoOrPassword(file, name) {
	let pw = null, wrong = false;
	for (;;) {
		const info = await api.openFile(file, pw);
		if (!info.needsPassword) return info;
		pw = await D.passwordDialog(name, wrong || info.wrongPassword);
		if (pw == null) return null;
		wrong = true;
	}
}

async function refreshInfo(doc) {
	const old = doc.info.pages || [];
	const info = await E("info", doc.id);
	const same = old.length === info.pages.length && old.every((p, i) => {
		const q = info.pages[i];
		return Math.abs(p.w - q.w) < 0.01 && Math.abs(p.h - q.h) < 0.01 && p.bounds[0] === q.bounds[0] && p.bounds[1] === q.bounds[1];
	});
	doc.info = { ...doc.info, ...info };
	doc.cache.clear();
	if (!same) doc.selectedAnnot = null;
	if (doc.current >= info.pages.length) doc.current = Math.max(0, info.pages.length - 1);
	for (const k of [...doc.selectedPages]) if (k >= info.pages.length) doc.selectedPages.delete(k);
	if (doc === cur()) {
		if (same) {
			// same geometry (undo of an annotation, rotation of nothing...): repaint in place, no flicker
			V.invalidateAll();
			refreshThumbs(doc, "all");
		} else {
			V.buildViews(doc);
			V.scheduleRender();
			buildThumbs();
		}
		renderOutline();
		updateStatus();
	}
}

// =================================================================== actions
const A = {
	async open() {
		const files = await api.openDialog({ multi: true, kind: "open", title: "open" });
		if (files.length) await A.openPaths(files);
	},

	async openPaths(files) {
		for (const f of files) {
			const existing = S.docs.find((d) => d.info.path && d.info.path.toLowerCase() === f.toLowerCase());
			if (existing) { activate(existing.id); continue; }
			const name = f.split(/[\\/]/).pop();
			try {
				const info = await busy("opening " + name, () => openInfoOrPassword(f, name));
				if (info) await addDoc(info);
			} catch (e) {
				toast(`couldn't open ${name}\n${cleanErr(e)}`, { error: true });
			}
		}
		S.settings = await api.getSettings();
		if (!cur()) renderWelcome();
	},

	async newBlank() {
		const info = await E("newBlank", 595.276, 841.89, 1);
		await addDoc(info);
	},

	async combine() {
		const start = await api.openDialog({ multi: true, kind: "open", title: "files to combine" });
		if (!start.length) return;
		const r = await D.fileListDialog({ title: "combine files", help: "order = order in the final pdf. pdfs, images, epubs... anything that opens.", files: start, okLabel: "combine" });
		if (!r) return;
		await busy("combining", async () => {
			const files = [];
			for (const p of r.files) {
				const { name, bytes } = await api.readFile(p);
				files.push({ name, bytes });
			}
			try {
				const info = await E("combine", files, "combined.pdf");
				await addDoc(info);
				toast(`combined ${r.files.length} files into ${info.pages.length} pages`);
			} catch (e) {
				toast(/PASSWORD_REQUIRED/.test(e.message) ? "one of the files is password protected. open it, remove the password, then combine." : cleanErr(e), { error: true });
			}
		});
	},

	async imagesToPdf() {
		const start = await api.openDialog({ multi: true, kind: "images", title: "images" });
		if (!start.length) return;
		const extra = el("div", {}, el("div.f-row", {}, el("label", {}, "page size"),
			el("select", { name: "pageSize" }, el("option", { value: "image" }, "same as each image"), el("option", { value: "a4" }, "A4, image fitted with margin"))));
		const r = await D.fileListDialog({ title: "images to pdf", help: "one image per page, in this order.", files: start, addKind: "images", okLabel: "create pdf", extra });
		if (!r) return;
		await busy("converting", async () => {
			const images = [];
			for (const p of r.files) images.push(await api.readFile(p));
			const info = await E("imagesToPdf", images, "images.pdf", { pageSize: r.form.pageSize });
			await addDoc(info);
		});
	},

	async save(doc = cur(), opts = {}) {
		if (!doc) return false;
		let file = doc.info.path;
		if (opts.as || !file || doc.info.convertedFrom) {
			file = await api.saveDialog({ title: opts.title || "save as", defaultPath: suggestPath(doc, opts.suffix), kind: "pdf" });
			if (!file) return false;
		}
		const saveOpts = { ...opts };
		delete saveOpts.as; delete saveOpts.title; delete saveOpts.suffix;
		try {
			if (saveOpts.flatten) await op(doc, "flatten");
			const r = await busy("saving", () => api.saveDoc(doc.id, file, saveOpts));
			if (r.state) Object.assign(doc.info, r.state);
			doc.info.path = r.path;
			doc.info.name = r.name;
			doc.info.convertedFrom = null;
			if (saveOpts.security === "set") doc.info.encryption = "AES-256";
			if (saveOpts.security === "remove") doc.info.encryption = "None";
			S.settings = await api.getSettings();
			renderTabs();
			updateStatus();
			toast(`saved ${r.name}  (${fmtBytes(r.size)})`, { action: { label: "show", fn: () => api.showInFolder(r.path) } });
			return true;
		} catch (e) {
			toast("save failed: " + cleanErr(e), { error: true });
			return false;
		}
	},
	saveAs() { return A.save(cur(), { as: true }); },
	async saveWithOptions() {
		const doc = cur();
		if (!doc) return;
		const opts = await D.saveOptionsDialog(doc);
		if (opts) await A.save(doc, { ...opts, as: true, suffix: opts.optimize ? "_small" : "" });
	},
	async protect() {
		const doc = cur();
		if (!doc) return;
		const opts = await D.protectDialog(doc);
		if (opts) await A.save(doc, { ...opts, as: true, title: "save encrypted copy as", suffix: "_protected" });
	},
	async removeSecurity() {
		const doc = cur();
		if (!doc) return;
		if (await confirmBox("remove security", "save a copy with no password and no restrictions?", { ok: "save copy..." })) {
			await A.save(doc, { security: "remove", as: true, suffix: "_unlocked" });
		}
	},

	async exportImages() {
		const doc = cur();
		const o = await D.exportImagesDialog(doc);
		if (!o) return;
		const folder = await api.pickFolder({ title: "export images to" });
		if (!folder) return;
		const pages = parseRange(o.pages, doc.info.pages.length);
		const base = doc.info.name.replace(/\.pdf$/i, "");
		await busy(`exporting ${pages.length} images`, async () => {
			const files = [];
			for (const i of pages) {
				const bytes = await E("renderPNG", doc.id, i, o.dpi, o.format, 92);
				files.push({ name: `${base}_p${String(i + 1).padStart(3, "0")}.${o.format}`, bytes });
				if (files.length >= 10) { await api.writeMany(folder, files.splice(0)); }
			}
			if (files.length) await api.writeMany(folder, files);
		});
		toast(`exported ${pages.length} images`, { action: { label: "open folder", fn: () => api.showInFolder(folder) } });
	},

	async exportText() {
		const doc = cur();
		const file = await api.saveDialog({ title: "export text", defaultPath: suggestPath(doc, "", ".txt"), kind: "txt" });
		if (!file) return;
		const text = await busy("extracting text", () => E("extractText", doc.id));
		await api.writeFile(file, new TextEncoder().encode(text));
		toast("text exported");
	},

	async extract() {
		const doc = cur();
		const def = doc.selectedPages.size ? rangeString([...doc.selectedPages]) : String(doc.current + 1);
		const range = await D.rangeDialog("extract pages", "pages to copy into a new pdf.", def, "extract...");
		if (!range) return;
		const pages = parseRange(range, doc.info.pages.length);
		if (!pages.length) return toast("no valid pages in that range", { error: true });
		const file = await api.saveDialog({ title: "save extracted pages", defaultPath: suggestPath(doc, "_pages"), kind: "pdf" });
		if (!file) return;
		const bytes = await busy("extracting", () => E("extractPages", doc.id, pages));
		await api.writeFile(file, bytes);
		toast(`saved ${pages.length} pages`, { action: { label: "open it", fn: () => A.openPaths([file]) } });
	},

	async split() {
		const doc = cur();
		const mode = await D.splitDialog(doc);
		if (!mode) return;
		const folder = await api.pickFolder({ title: "save parts to" });
		if (!folder) return;
		const parts = await busy("splitting", () => E("split", doc.id, mode));
		await api.writeMany(folder, parts);
		toast(`split into ${parts.length} files`, { action: { label: "open folder", fn: () => api.showInFolder(folder) } });
	},

	async print() {
		const doc = cur();
		if (!doc) return;
		await busy("preparing pages for the printer", () => api.print(doc.id, {})).catch((e) => toast(cleanErr(e), { error: true }));
	},

	async properties() {
		const doc = cur();
		const meta = await D.metadataDialog(doc);
		if (!meta) return;
		await op(doc, "setMetadata", meta);
		await refreshInfo(doc);
	},

	async closeTab(doc = cur()) {
		if (!doc) return;
		if (doc.info.dirty) {
			const r = await modal({
				title: "unsaved changes",
				body: el("div.f-help", { style: { margin: 0 } }, `${doc.info.name} has changes that aren't saved.`),
				buttons: [{ label: "cancel", value: null }, { label: "discard", value: "discard", danger: true }, { label: "save", value: "save", primary: true }],
			});
			if (!r.value) return;
			if (r.value === "save" && !(await A.save(doc))) return;
		}
		await E("close", doc.id).catch(() => {});
		const idx = S.docs.indexOf(doc);
		S.docs.splice(idx, 1);
		if (S.active === doc.id) {
			const next = S.docs[Math.min(idx, S.docs.length - 1)];
			activate(next ? next.id : null);
		} else renderTabs();
	},

	async undo() {
		const doc = cur();
		if (!doc || !doc.info.canUndo) return;
		applyResult(doc, await E("undo", doc.id));
	},
	async redo() {
		const doc = cur();
		if (!doc || !doc.info.canRedo) return;
		applyResult(doc, await E("redo", doc.id));
	},

	async goTo() {
		const doc = cur();
		const v = await promptBox("go to page", "page", String(doc.current + 1));
		if (v == null) return;
		const n = parseInt(v, 10);
		if (n >= 1 && n <= doc.info.pages.length) V.goToPage(n - 1);
	},

	targetPages(scope) {
		const doc = cur();
		if (scope === "all") return "all";
		if (doc.selectedPages.size > 1 || (doc.selectedPages.size === 1 && !doc.selectedPages.has(doc.current))) return [...doc.selectedPages].sort((a, b) => a - b);
		return [doc.current];
	},
	async rotate(delta, scope) {
		const doc = cur();
		if (!doc) return;
		await op(doc, "rotatePages", A.targetPages(scope), delta);
	},
	async rotatePage(i, delta) {
		await op(cur(), "rotatePages", [i], delta);
	},
	async insertBlank() {
		const doc = cur();
		const o = await D.insertBlankDialog(doc, doc.current);
		if (!o) return;
		await op(doc, "insertBlank", o.at, o.w, o.h, o.count);
		V.goToPage(o.at);
	},
	async insertBlankAt(at) {
		const doc = cur();
		await op(doc, "insertBlank", at, 0, 0, 1);
	},
	async insertFile(at = null, files = null) {
		const doc = cur();
		if (!files) {
			files = await api.openDialog({ multi: true, kind: "open", title: "insert pages from" });
			if (!files.length) return;
		}
		let where = at, range = null;
		if (at == null && files.length === 1) {
			const name = files[0].split(/[\\/]/).pop();
			const o = await D.insertFileDialog(doc, doc.current, name, null);
			if (!o) return;
			where = o.at; range = o.range;
		} else if (at == null) where = doc.info.pages.length;
		await busy("inserting", async () => {
			let pos = where;
			for (const f of files) {
				const { name, bytes } = await api.readFile(f);
				const before = doc.info.pages.length;
				let pw = null;
				for (;;) {
					try {
						await op(doc, "insertFile", pos, bytes, name, pw, range);
						break;
					} catch (e) {
						if (!/PASSWORD_REQUIRED/.test(e.message)) return;
						pw = await D.passwordDialog(name, pw != null);
						if (pw == null) return;
					}
				}
				await refreshInfo(doc);
				pos += doc.info.pages.length - before;
			}
		});
		V.goToPage(where);
	},
	async duplicate() {
		const doc = cur();
		await op(doc, "duplicatePages", A.targetPages());
	},
	async deletePages() {
		const doc = cur();
		const def = doc.selectedPages.size ? rangeString([...doc.selectedPages]) : String(doc.current + 1);
		const range = await D.rangeDialog("delete pages", "these pages will be removed (ctrl+z brings them back).", def, "delete");
		if (!range) return;
		await A.deletePagesList(parseRange(range, doc.info.pages.length));
	},
	async deletePagesList(list) {
		const doc = cur();
		if (!list.length) return;
		if (list.length >= doc.info.pages.length) return toast("can't delete every page", { error: true });
		doc.selectedPages.clear();
		await op(doc, "deletePages", list);
		toast(`deleted ${list.length} page${list.length > 1 ? "s" : ""}`, { action: { label: "undo", fn: () => A.undo() } });
	},
	async reverse() {
		const doc = cur();
		const n = doc.info.pages.length;
		await op(doc, "reorderPages", [...Array(n).keys()].reverse());
	},
	async resize() {
		const doc = cur();
		const o = await D.resizeDialog(doc);
		if (!o) return;
		const pages = parseRange(o.pages, doc.info.pages.length);
		let [w, h] = o.size;
		if (o.orient === "auto") {
			const port = pages.filter((i) => doc.info.pages[i].h >= doc.info.pages[i].w);
			const land = pages.filter((i) => doc.info.pages[i].h < doc.info.pages[i].w);
			if (port.length) await op(doc, "resizePages", port, Math.min(w, h), Math.max(w, h));
			if (land.length) await op(doc, "resizePages", land, Math.max(w, h), Math.min(w, h));
		} else {
			if ((o.orient === "landscape") !== (w > h)) [w, h] = [h, w];
			await op(doc, "resizePages", pages, w, h);
		}
	},
	async removeCrop() {
		await op(cur(), "cropPage", "all", null);
	},
	async movePages(list, to) {
		const doc = cur();
		const res = await op(doc, "movePages", list, to);
		const r = res.result;
		doc.selectedPages = new Set(r.from.map((_, k) => r.to + k));
		doc.current = r.to;
	},
	async headerFooter() {
		const doc = cur();
		if (!doc) return;
		const o = await D.headerFooterDialog(doc);
		if (!o) return;
		await busy("stamping pages", () => op(doc, "headerFooter", o));
	},
	async watermark() {
		const doc = cur();
		if (!doc) return;
		const o = await D.watermarkDialog();
		if (!o) return;
		await busy("watermarking", () => op(doc, "watermark", o));
	},
	async applyRedactions() {
		const doc = cur();
		if (!doc) return;
		if (!(await confirmBox("apply redactions", "permanently remove all text, images and graphics under every redaction mark?\nthis can be undone until you close the file, but the saved file won't contain the content.", { ok: "burn it", danger: true }))) return;
		const r = await busy("redacting", () => op(doc, "applyRedactions"));
		toast(r.result ? `applied ${r.result} redaction${r.result > 1 ? "s" : ""}. save to make it stick.` : "no redaction marks found. draw some with the redact tool (x) first.");
	},
	async searchRedact() {
		const doc = cur();
		const o = await D.searchRedactDialog();
		if (!o) return;
		const r = await op(doc, "markRedactions", o.q, { matchCase: o.matchCase });
		if (!r.result) return toast("no matches");
		if (await confirmBox("search + redact", `marked ${r.result} match${r.result > 1 ? "es" : ""}. apply them now?\n(or review first and use 'apply redactions' later)`, { ok: "apply now", cancel: "review first" })) {
			await op(doc, "applyRedactions");
			toast("redacted. save to make it stick.");
		}
	},
	async resetForm() {
		await op(cur(), "resetForm");
	},
	async flatten() {
		const doc = cur();
		if (await confirmBox("flatten", "burn every annotation and form field into the page content?\nthey stop being editable, but look the same everywhere.", { ok: "flatten" })) {
			await op(doc, "flatten");
		}
	},
	night() {
		S.night = !S.night;
		document.body.classList.toggle("night", S.night);
		savePrefs();
	},
};

bus.on("action", (name, ...args) => A[name] && A[name](...args));
bus.on("set-tool", (t) => setTool(t));
bus.on("find", (q) => openFind(q));

function suggestPath(doc, suffix = "", ext = ".pdf") {
	const name = doc.info.name.replace(/\.[^.]+$/, "") + suffix + ext;
	if (doc.info.path) return doc.info.path.replace(/[^\\/]+$/, name);
	return name;
}

function parseRange(spec, n) {
	const out = [];
	const s = String(spec || "").trim().toLowerCase();
	if (!s || s === "all") return [...Array(n).keys()];
	for (let part of s.split(/[,;\s]+/)) {
		if (!part) continue;
		if (part === "odd" || part === "even") { for (let i = part === "odd" ? 0 : 1; i < n; i += 2) out.push(i); continue; }
		part = part.replace(/end|last/g, String(n));
		const m = part.match(/^(\d+)?-(\d+)?$/);
		if (m) {
			const a = m[1] ? +m[1] : 1, b = m[2] ? +m[2] : n;
			for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= n) out.push(i - 1);
		} else if (/^\d+$/.test(part) && +part >= 1 && +part <= n) out.push(+part - 1);
	}
	return [...new Set(out)];
}

function rangeString(list) {
	list = [...new Set(list)].sort((a, b) => a - b);
	const parts = [];
	for (let k = 0; k < list.length;) {
		let j = k;
		while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
		parts.push(j > k ? `${list[k] + 1}-${list[j] + 1}` : String(list[k] + 1));
		k = j + 1;
	}
	return parts.join(", ");
}

// =================================================================== signatures / images
async function newSignature() {
	const url = await D.signatureDialog();
	if (!url) return null;
	S.settings.signatures = [url, ...S.settings.signatures].slice(0, 12);
	S.activeSig = 0;
	await api.setSettings({ signatures: S.settings.signatures });
	renderProps();
	toast("signature saved. click on the page to place it.");
	if (cur()) setTool("sign");
	return url;
}

bus.currentSignature = async () => {
	let url = S.settings.signatures[S.activeSig] || S.settings.signatures[0];
	if (!url) url = await newSignature();
	if (!url) return null;
	const dims = await D.imageDims(url);
	return { bytes: D.dataURLToBytes(url), w: dims.w, h: dims.h };
};

bus.pickImage = async () => {
	const [p] = await api.openDialog({ kind: "images", title: "choose image" });
	if (!p) return null;
	const { name, bytes } = await api.readFile(p);
	try {
		const { width, height } = await E("imageSize", bytes);
		return { name, bytes, w: width, h: height };
	} catch (e) {
		toast("that image format isn't supported: " + cleanErr(e), { error: true });
		return null;
	}
};

// =================================================================== sidebar: thumbnails
let thumbObserver = null;
const thumbQueue = [];
let thumbPumping = false;
const THUMB_W = 132;

function buildThumbs() {
	const host = $("#side-pages");
	if (thumbObserver) thumbObserver.disconnect();
	host.replaceChildren();
	const doc = cur();
	if (!doc) return;
	const wrap = el("div.thumbs");
	thumbObserver = new IntersectionObserver((entries) => {
		for (const e of entries) {
			if (e.isIntersecting) queueThumb(doc, +e.target.dataset.i);
		}
	}, { root: host, rootMargin: "300px" });
	doc.info.pages.forEach((p, i) => {
		const h = Math.round((THUMB_W * p.h) / p.w);
		const canvas = el("canvas", { style: { width: THUMB_W + "px", height: h + "px" } });
		const t = el("div.thumb", { "data-i": i, draggable: true }, canvas, el("span.tl", {}, p.label || String(i + 1)));
		t.addEventListener("click", (e) => thumbClick(doc, i, e));
		t.addEventListener("contextmenu", (e) => thumbMenu(doc, i, e));
		t.addEventListener("dragstart", (e) => {
			if (!doc.selectedPages.has(i)) { doc.selectedPages = new Set([i]); markThumbs(); }
			e.dataTransfer.setData("application/x-fpdf-pages", JSON.stringify([...doc.selectedPages]));
			e.dataTransfer.effectAllowed = "move";
		});
		t.addEventListener("dragover", (e) => {
			const internal = e.dataTransfer.types.includes("application/x-fpdf-pages");
			const files = e.dataTransfer.types.includes("Files");
			if (!internal && !files) return;
			e.preventDefault();
			e.stopPropagation();
			const r = t.getBoundingClientRect();
			const after = e.clientY > r.top + r.height / 2;
			clearDropMarks();
			t.classList.add(after ? "drop-after" : "drop-before");
		});
		t.addEventListener("dragleave", () => t.classList.remove("drop-before", "drop-after"));
		t.addEventListener("drop", async (e) => {
			e.preventDefault();
			e.stopPropagation();
			const after = t.classList.contains("drop-after");
			clearDropMarks();
			hideDrop();
			const to = i + (after ? 1 : 0);
			const data = e.dataTransfer.getData("application/x-fpdf-pages");
			if (data) {
				const list = JSON.parse(data);
				await A.movePages(list, to);
			} else if (e.dataTransfer.files.length) {
				const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
				if (paths.length) await A.insertFile(to, paths);
			}
		});
		wrap.append(t);
		t._canvas = canvas;
		thumbObserver.observe(t);
	});
	host.append(wrap);
	markThumbs();
}

function clearDropMarks() { $$(".thumb.drop-before, .thumb.drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after")); }

function queueThumb(doc, i) {
	if (!thumbQueue.some((q) => q.doc === doc && q.i === i)) thumbQueue.push({ doc, i });
	pumpThumbs();
}

async function pumpThumbs() {
	if (thumbPumping) return;
	thumbPumping = true;
	try {
		while (thumbQueue.length) {
			const { doc, i } = thumbQueue.shift();
			if (doc !== cur()) continue;
			const t = $(`#side-pages .thumb[data-i="${i}"]`);
			if (!t) continue;
			const v = pageVersion(doc, i);
			if (t._v === v) continue;
			const p = doc.info.pages[i];
			const scale = (THUMB_W * (window.devicePixelRatio || 1)) / p.w;
			try {
				const res = await E("render", doc.id, i, scale, { annots: true });
				if (doc !== cur() || !t.isConnected) continue;
				const c = t._canvas;
				c.width = res.width;
				c.height = res.height;
				c.getContext("2d").putImageData(new ImageData(res.data, res.width, res.height), 0, 0);
				t._v = v;
			} catch { /* ignore */ }
		}
	} finally {
		thumbPumping = false;
	}
}

function refreshThumbs(doc, pages) {
	if (doc !== cur()) return;
	const host = $("#side-pages");
	const list = pages === "all" ? doc.info.pages.map((_, i) => i) : pages;
	for (const i of list) {
		const t = $(`.thumb[data-i="${i}"]`, host);
		if (!t) continue;
		const r = t.getBoundingClientRect(), hr = host.getBoundingClientRect();
		if (r.bottom > hr.top - 300 && r.top < hr.bottom + 300) queueThumb(doc, i);
	}
}

function markThumbs() {
	const doc = cur();
	if (!doc) return;
	$$("#side-pages .thumb").forEach((t) => {
		const i = +t.dataset.i;
		t.classList.toggle("current", i === doc.current);
		t.classList.toggle("selected", doc.selectedPages.has(i));
	});
}

function thumbClick(doc, i, e) {
	if (e.ctrlKey || e.metaKey) {
		if (doc.selectedPages.has(i)) doc.selectedPages.delete(i); else doc.selectedPages.add(i);
	} else if (e.shiftKey) {
		const anchor = doc.anchorPage ?? doc.current;
		doc.selectedPages = new Set();
		for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) doc.selectedPages.add(k);
	} else {
		doc.selectedPages = new Set([i]);
		doc.anchorPage = i;
		V.goToPage(i);
	}
	markThumbs();
	$("#side-pages").focus();
}

function thumbMenu(doc, i, e) {
	e.preventDefault();
	if (!doc.selectedPages.has(i)) { doc.selectedPages = new Set([i]); markThumbs(); }
	const sel = [...doc.selectedPages].sort((a, b) => a - b);
	const n = sel.length;
	const lbl = n > 1 ? `${n} pages` : `page ${i + 1}`;
	popupMenu([
		{ label: `rotate right (${lbl})`, action: () => op(doc, "rotatePages", sel, 90) },
		{ label: `rotate left (${lbl})`, action: () => op(doc, "rotatePages", sel, -90) },
		{ label: `duplicate (${lbl})`, action: () => op(doc, "duplicatePages", sel) },
		{ label: `delete (${lbl})`, action: () => A.deletePagesList(sel) },
		"-",
		{ label: "insert blank before", action: () => A.insertBlankAt(sel[0]) },
		{ label: "insert blank after", action: () => A.insertBlankAt(sel[n - 1] + 1) },
		{ label: "insert file after...", action: async () => {
			const files = await api.openDialog({ multi: true, kind: "open" });
			if (files.length) A.insertFile(sel[n - 1] + 1, files);
		} },
		"-",
		{ label: `extract ${lbl} to new pdf...`, action: async () => {
			const file = await api.saveDialog({ defaultPath: suggestPath(doc, "_p" + (sel[0] + 1)), kind: "pdf" });
			if (!file) return;
			await api.writeFile(file, await E("extractPages", doc.id, sel));
			toast("saved " + lbl, { action: { label: "open it", fn: () => A.openPaths([file]) } });
		} },
		{ label: "move to start", action: () => A.movePages(sel, 0) },
		{ label: "move to end", action: () => A.movePages(sel, doc.info.pages.length) },
		"-",
		{ label: "select all pages", key: "ctrl+a", action: () => { doc.selectedPages = new Set(doc.info.pages.map((_, k) => k)); markThumbs(); } },
	], e.clientX, e.clientY);
}

$("#side-pages").tabIndex = 0;
$("#side-pages").addEventListener("keydown", (e) => {
	const doc = cur();
	if (!doc) return;
	if (e.key === "Delete" && doc.selectedPages.size) { e.preventDefault(); A.deletePagesList([...doc.selectedPages]); }
	if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); doc.selectedPages = new Set(doc.info.pages.map((_, k) => k)); markThumbs(); }
});

// =================================================================== sidebar: outline, notes, search
function renderOutline() {
	const host = $("#side-outline");
	const doc = cur();
	host.replaceChildren();
	if (!doc) return;
	const items = doc.info.outline || [];
	if (!items.length) { host.append(el("div.empty-note", {}, "no bookmarks in this file.")); return; }
	const walk = (list) => el("div", {}, list.map((it) => el("div", {},
		el("div.ol-item", { title: it.title, on: { click: () => it.page >= 0 ? V.goToPage(it.page) : it.uri && api.openExternal(it.uri) } }, it.title),
		it.down && it.down.length ? el("div.ol-children", {}, walk(it.down)) : null)));
	host.append(el("div.outline", {}, walk(items)));
}

const refreshNotes = debounce(async () => {
	const host = $("#side-notes");
	const doc = cur();
	if (!doc || host.classList.contains("hidden")) { host.replaceChildren(); return; }
	let list = [];
	try { list = await E("allAnnotations", doc.id); } catch { list = []; }
	if (doc !== cur()) return;
	host.replaceChildren();
	if (!list.length) { host.append(el("div.empty-note", {}, "no annotations yet.\nhighlights, notes, drawings, stamps etc. show up here.")); return; }
	for (const a of list) {
		const c = rgb2hex(a.color) || rgb2hex(a.interior) || "#000";
		host.append(el("div.note-item", { on: { click: async () => {
			V.goToPage(a.page, { y: a.rect[1] });
			await V.pageData(doc, a.page);
			V.selectAnnot(doc, a.page, a);
		} } },
		el("div.nt", {}, el("span", {}, el("span.swatch-dot", { style: { background: c } }), annotName(a)), el("span", {}, "p." + (a.page + 1))),
		a.contents ? el("div.nc", {}, a.contents.slice(0, 200)) : null));
	}
}, 250);

$$(".side-tabs button").forEach((b) => b.addEventListener("click", () => {
	$$(".side-tabs button").forEach((x) => x.classList.toggle("on", x === b));
	for (const k of ["pages", "outline", "notes", "search"]) $("#side-" + k).classList.toggle("hidden", k !== b.dataset.side);
	if (b.dataset.side === "notes") refreshNotes();
	if (b.dataset.side === "search") setTimeout(() => $("#side-search-input").focus(), 10);
}));

// ---- search (shared by the sidebar and the find bar)
async function runSearch(q, matchCase) {
	const doc = cur();
	if (!doc) return;
	const s = doc.search;
	s.query = q;
	s.matchCase = matchCase;
	if (!q) {
		s.results = []; s.flat = []; s.index = -1;
	} else {
		const r = await E("search", doc.id, q, { matchCase });
		s.results = r.results;
		s.flat = r.results.flatMap((p) => p.hits.map((quads) => ({ page: p.page, quads })));
		s.index = s.flat.length ? Math.max(0, s.flat.findIndex((h) => h.page >= doc.current)) : -1;
	}
	V.showSearch(doc);
	updateFindCount();
	renderSearchSide();
}

function renderSearchSide() {
	const host = $("#side-search-results");
	const doc = cur();
	host.replaceChildren();
	if (!doc) return;
	const s = doc.search;
	if (!s.query) return;
	if (!s.flat.length) { host.append(el("div.empty-note", {}, "no matches.")); return; }
	host.append(el("div.empty-note", { style: { padding: "8px 10px" } }, `${s.flat.length} matches on ${s.results.length} pages`));
	let k = 0;
	for (const p of s.results) {
		host.append(el("div.sr-page", {}, "page " + (p.page + 1)));
		for (let h = 0; h < p.hits.length; h++, k++) {
			const idx = k;
			host.append(el("div.sr-hit" + (idx === s.index ? ".on" : ""), { on: { click: () => { s.index = idx; V.showSearch(doc); updateFindCount(); renderSearchSide(); } } }, `${s.query}  #${h + 1}`));
		}
		if (k > 2000) break;
	}
}

const sideSearch = debounce(() => runSearch($("#side-search-input").value, $("#side-search-case").checked), 250);
$("#side-search-input").addEventListener("input", sideSearch);
$("#side-search-case").addEventListener("change", sideSearch);

function openFind(q = null) {
	if (!cur()) return;
	$("#findbar").classList.remove("hidden");
	const inp = $("#find-input");
	if (q != null) inp.value = q;
	else if (cur().selection && cur().selection.text.trim().length < 80) inp.value = cur().selection.text.trim();
	inp.focus();
	inp.select();
	if (inp.value && inp.value !== cur().search.query) runSearch(inp.value, $("#find-case").checked);
}
function closeFind() {
	$("#findbar").classList.add("hidden");
	const doc = cur();
	if (doc) { doc.search = { query: "", matchCase: false, flat: [], index: -1, results: [] }; V.redrawOverlays(); renderSearchSide(); }
	V.viewerEl().focus();
}
function findStep(dir) {
	const doc = cur();
	if (!doc || !doc.search.flat.length) return;
	const s = doc.search;
	s.index = (s.index + dir + s.flat.length) % s.flat.length;
	V.showSearch(doc);
	updateFindCount();
	renderSearchSide();
}
function updateFindCount() {
	const doc = cur();
	const s = doc ? doc.search : null;
	$("#find-count").textContent = s && s.flat.length ? `${s.index + 1}/${s.flat.length}` : s && s.query ? "0/0" : "";
}
const findInput = debounce(() => runSearch($("#find-input").value, $("#find-case").checked), 220);
$("#find-input").addEventListener("input", findInput);
$("#find-case").addEventListener("change", findInput);
$("#find-input").addEventListener("keydown", (e) => {
	e.stopPropagation();
	if (e.key === "Enter") {
		e.preventDefault();
		const doc = cur();
		if (doc && doc.search.query !== $("#find-input").value) runSearch($("#find-input").value, $("#find-case").checked);
		else findStep(e.shiftKey ? -1 : 1);
	}
	if (e.key === "Escape") closeFind();
});
$("#find-next").addEventListener("click", () => findStep(1));
$("#find-prev").addEventListener("click", () => findStep(-1));
$("#find-close").addEventListener("click", closeFind);
$("#find-redact").addEventListener("click", async () => {
	const doc = cur();
	if (!doc || !doc.search.query) return;
	const r = await op(doc, "markRedactions", doc.search.query, { matchCase: doc.search.matchCase });
	toast(`marked ${r.result} matches for redaction. use 'apply redactions' to burn them in.`);
	renderProps();
});

async function selectAllPage() {
	const doc = cur();
	if (!doc) return;
	const r = await E("selectAll", doc.id, doc.current);
	doc.selection = { page: doc.current, quads: r.quads, text: r.text };
	V.redrawOverlays();
	renderProps();
}

// =================================================================== properties panel
function sec(title, hint, ...kids) {
	return el("div.pp-sec", {}, el("h3", {}, el("span", {}, title), hint ? el("span.dim", {}, hint) : null), ...kids);
}
function prow(label, ...kids) { return el("div.pp-row", {}, el("label", {}, label), ...kids); }

function swatches(value, onPick, { allowNone = false } = {}) {
	const custom = el("input", { type: "color", value: value || "#000000", on: { change: (e) => onPick(e.target.value) } });
	const list = PALETTE.map((c) => el("button.sw" + (value && c.toLowerCase() === value.toLowerCase() ? ".on" : ""), { title: c, style: { background: c }, on: { click: () => onPick(c) } }));
	if (allowNone) list.unshift(el("button.sw.none" + (!value ? ".on" : ""), { title: "none", on: { click: () => onPick(null) } }));
	return el("div", {}, el("div.swatches", { style: { gridTemplateColumns: `repeat(${list.length}, 1fr)` } }, list), el("div.pp-row", {}, el("label", {}, "custom"), custom));
}

function slider(label, min, max, step, value, onInput, fmt = (v) => v) {
	const val = el("span.val", {}, fmt(value));
	const r = el("input", { type: "range", min, max, step, value, on: { input: (e) => { val.textContent = fmt(+e.target.value); onInput(+e.target.value, false); }, change: (e) => onInput(+e.target.value, true) } });
	return prow(label, r, val);
}

function tpChanged() { savePrefs(); renderProps(); }

function toolSection() {
	const t = S.tool;
	const doc = cur();
	const C = S.tp.colors;
	const title = "// " + (TOOL_NAMES[t] || t);
	switch (t) {
		case "select": {
			const kids = [el("div.pp-text", {}, "drag over text to select it.\nclick an annotation to move / resize it.\ndouble-click text boxes + notes to edit.\nclick form fields to fill them.")];
			if (doc && doc.selection && doc.selection.text) {
				kids.push(el("div.pp-btns", {},
					el("button", { on: { click: () => V.copySelection() } }, "copy"),
					el("button", { on: { click: () => V.markupSelection("highlight") } }, "highlight"),
					el("button", { on: { click: () => V.markupSelection("underline") } }, "underline"),
					el("button", { on: { click: () => V.markupSelection("strikeout") } }, "strike"),
					el("button", { on: { click: () => V.markupSelection("redact") } }, "redact")));
			}
			return sec(title, "v", ...kids);
		}
		case "hand": return sec(title, "h", el("div.pp-text", {}, "drag to move around.\ntip: hold space or the middle mouse button with any tool."));
		case "highlight": case "underline": case "strikeout":
			return sec(title, "", el("div.pp-text", {}, "drag across text."),
				swatches(C[t], (c) => { C[t] = c; tpChanged(); }),
				t === "highlight" ? slider("opacity", 0.1, 1, 0.05, S.tp.hlOpacity, (v, done) => { S.tp.hlOpacity = v; if (done) savePrefs(); }, (v) => Math.round(v * 100) + "%") : null);
		case "draw": case "rect": case "ellipse": case "line": case "arrow":
			return sec(title, "",
				swatches(C[t], (c) => { C[t] = c; tpChanged(); }),
				slider("width", 0.5, 20, 0.5, S.tp.width, (v, done) => { S.tp.width = v; if (done) savePrefs(); }, (v) => v + "pt"),
				slider("opacity", 0.1, 1, 0.05, S.tp.opacity, (v, done) => { S.tp.opacity = v; if (done) savePrefs(); }, (v) => Math.round(v * 100) + "%"),
				t === "rect" || t === "ellipse" ? el("div", {}, el("div.pp-text", { style: { marginTop: "8px" } }, "fill"), swatches(S.tp.fill, (c) => { S.tp.fill = c; tpChanged(); }, { allowNone: true })) : null,
				el("div.pp-text", { style: { marginTop: "6px" } }, t === "line" || t === "arrow" ? "shift = snap to 45 deg" : t === "draw" ? "" : "shift = square / circle"));
		case "addtext":
			return sec(title, "t", el("div.pp-text", {}, "click on the page and type.\nctrl+enter or click away to finish."),
				swatches(C.addtext, (c) => { C.addtext = c; tpChanged(); }),
				prow("font", el("select", { on: { change: (e) => { S.tp.family = e.target.value; savePrefs(); } } },
					[["helv", "Helvetica"], ["times", "Times"], ["cour", "Courier"]].map(([v, l]) => el("option", { value: v, selected: S.tp.family === v }, l)))),
				prow("size", el("input", { type: "number", min: 4, max: 200, value: S.tp.fontSize, on: { change: (e) => { S.tp.fontSize = Math.max(4, +e.target.value || 12); savePrefs(); } } })));
		case "edittext": {
			const ed = S.tp.edit;
			const fonts = [["original", "same as original"], ["helv", "Helvetica / Arial"], ["times", "Times"], ["cour", "Courier"], ...(S.systemFonts || []).map((f) => [f.key, f.name])];
			const tri = (v, a, b) => el("select", { on: { change: (e) => { const x = e.target.value; ed[a] = x === "keep" ? null : x === "yes"; savePrefs(); } } },
				[["keep", "keep"], ["yes", b], ["no", "no " + b]].map(([k, l]) => el("option", { value: k, selected: (v == null && k === "keep") || (v === true && k === "yes") || (v === false && k === "no") }, l)));
			return sec(title, "e",
				el("div.pp-text", {}, "click a line of existing text, type, press enter.\nempty + enter deletes the line.\nthe original font is reused (the full installed copy if the embedded one is a subset)."),
				prow("font", el("select", { on: { change: (e) => { ed.family = e.target.value; savePrefs(); } } }, fonts.map(([v, l]) => el("option", { value: v, selected: ed.family === v }, l)))),
				prow("size", el("input", { type: "number", min: 2, max: 300, placeholder: "keep", value: ed.size || "", on: { change: (e) => { ed.size = +e.target.value || null; savePrefs(); } } })),
				prow("bold", tri(ed.bold, "bold", "bold")),
				prow("italic", tri(ed.italic, "italic", "italic")),
				prow("colour", el("label.chk", {}, el("input", { type: "checkbox", checked: !ed.color, on: { change: (e) => { ed.color = e.target.checked ? null : "#000000"; tpChanged(); } } }), "keep")),
				ed.color ? swatches(ed.color, (c) => { ed.color = c; tpChanged(); }) : null,
				S.systemFonts ? null : el("div.pp-text", { style: { marginTop: "6px" } }, "(loading installed fonts...)"));
		}
		case "note":
			return sec(title, "n", el("div.pp-text", {}, "click to drop a sticky note."), swatches(C.note, (c) => { C.note = c; tpChanged(); }));
		case "image":
			return sec(title, "i", el("div.pp-text", {}, "click (or drag a box) where the image goes.\nyou'll pick the file then."),
				el("div.pp-btns", {}, el("button", { on: { click: async () => { S.pendingImage = await bus.pickImage(); renderProps(); } } }, S.pendingImage ? "change image" : "choose image now")),
				S.pendingImage ? el("div.pp-text", {}, "ready: " + S.pendingImage.name) : null);
		case "sign": {
			const list = S.settings.signatures;
			return sec(title, "s",
				el("div.pp-text", {}, list.length ? "pick one, then click (or drag a box) on the page." : "no signatures yet."),
				el("div.sig-list", {}, list.map((url, k) => el("div.sig-item" + (k === S.activeSig ? ".on" : ""), { on: { click: () => { S.activeSig = k; renderProps(); } } },
					el("img", { src: url }),
					el("button.sx", { title: "forget", on: { click: async (e) => {
						e.stopPropagation();
						S.settings.signatures.splice(k, 1);
						S.activeSig = 0;
						await api.setSettings({ signatures: S.settings.signatures });
						renderProps();
					} } }, "x")))),
				el("div.pp-btns", {}, el("button.primary", { on: { click: () => newSignature() } }, "+ new signature")),
				el("div.pp-text", { style: { marginTop: "8px" } }, "this is a visible signature (an image), like most free 'fill & sign' tools. not a certificate-based digital signature."));
		}
		case "stamp": {
			const names = ["Approved", "NotApproved", "Draft", "Final", "Confidential", "ForComment", "Experimental", "Expired", "Sold", "TopSecret", "AsIs", "Departmental"];
			return sec(title, "m",
				el("div.stamp-list", {}, names.map((n) => el("button" + (!S.tp.stampText && S.tp.stampName === n ? ".on" : ""), { on: { click: () => { S.tp.stampName = n; S.tp.stampText = ""; tpChanged(); } } }, n.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase()))),
				el("div.pp-text", { style: { marginTop: "10px" } }, "or your own text:"),
				prow("text", el("input", { type: "text", value: S.tp.stampText, placeholder: "e.g. PAID", on: { input: (e) => { S.tp.stampText = e.target.value; savePrefs(); } } })),
				swatches(C.stamp, (c) => { C.stamp = c; tpChanged(); }));
		}
		case "whiteout":
			return sec(title, "w", el("div.pp-text", {}, "drag a box to paint over stuff with white.\nthe content is still underneath. to really remove it use redact."));
		case "redact":
			return sec(title, "x", el("div.pp-text", {}, "drag boxes over anything sensitive (or select text and right-click > redact).\nmarks do nothing until you apply them."),
				el("div.pp-btns", {},
					el("button.primary", { on: { click: () => A.applyRedactions() } }, "apply redactions"),
					el("button", { on: { click: () => A.searchRedact() } }, "search + redact...")));
		case "crop":
			return sec(title, "c", el("div.pp-text", {}, "drag the area to keep."), el("div.pp-btns", {}, el("button", { on: { click: () => A.removeCrop() } }, "remove crop (all pages)")));
		default:
			return sec(title, "");
	}
}

function annotSection() {
	const a = V.selectedAnnotData();
	const doc = cur();
	if (!a || !doc) return null;
	const upd = (props) => op(doc, "updateAnnot", a.page, a.id, props).then(() => V.pageData(doc, a.page)).then(() => { V.drawOverlay(a.page); renderProps(); });
	const isWhiteout = a.type === "Square" && a.contents === "whiteout";
	const colorable = !isWhiteout && !(a.type === "Stamp" && !a.contents) && a.type !== "Redact";
	const cur0 = a.type === "FreeText" ? rgb2hex(a.textColor) : rgb2hex(a.color);
	const contents = el("textarea", { placeholder: "comment", value: a.contents || "" });
	return sec("// selected " + annotName(a), "p." + (a.page + 1),
		colorable ? swatches(cur0, (c) => upd({ color: hex2rgb(c) })) : null,
		a.width != null && !isWhiteout ? slider("width", 0.5, 20, 0.5, a.width || 1, (v, done) => done && upd({ width: v }), (v) => v + "pt") : null,
		a.type !== "Redact" ? slider("opacity", 0.1, 1, 0.05, a.opacity ?? 1, (v, done) => done && upd({ opacity: v }), (v) => Math.round(v * 100) + "%") : null,
		a.type === "FreeText" ? prow("size", el("input", { type: "number", min: 4, max: 200, value: Math.round(a.fontSize || 12), on: { change: (e) => upd({ size: +e.target.value || 12 }) } })) : null,
		a.type === "Square" || a.type === "Circle" ? el("div", {}, el("div.pp-text", {}, "fill"), swatches(rgb2hex(a.interior), (c) => upd({ fill: c ? hex2rgb(c) : [] }), { allowNone: !isWhiteout })) : null,
		a.type !== "FreeText" ? el("div", {}, contents, el("div.pp-btns", {}, el("button", { on: { click: () => upd({ contents: contents.value }) } }, "save comment"))) : null,
		el("div.pp-btns", {}, el("button.danger.btn", { on: { click: () => V.deleteSelectedAnnot() } }, "delete")),
	);
}

function docSection() {
	const doc = cur();
	if (!doc) return null;
	const p = doc.info.pages[doc.current];
	const mm = (pt) => Math.round((pt * 25.4) / 72);
	return sec("// document", "",
		el("div.kv", {},
			el("span", {}, "pages"), el("span", {}, String(doc.info.pages.length)),
			el("span", {}, "page size"), el("span", {}, p ? `${mm(p.w)} x ${mm(p.h)} mm` : "-"),
			el("span", {}, "security"), el("span", {}, isEncrypted(doc) ? doc.info.encryption : "none"),
			el("span", {}, "forms"), el("span", {}, doc.info.hasForms ? "yes, click to fill" : "no"),
			el("span", {}, "status"), el("span", {}, doc.info.dirty ? "unsaved changes" : "saved"),
		),
		el("div.pp-btns", {},
			el("button", { on: { click: () => A.saveWithOptions() } }, "optimize..."),
			el("button", { on: { click: () => A.protect() } }, "password..."),
			doc.info.hasForms ? el("button", { on: { click: () => A.flatten() } }, "flatten") : null,
			el("button", { on: { click: () => A.properties() } }, "properties...")));
}

function renderProps() {
	const host = $("#props");
	const doc = cur();
	if (!doc) {
		host.replaceChildren(sec("// nothing open", "", el("div.pp-text", {}, "open a pdf (ctrl+o) or drop one anywhere.\n\neverything here is free.\nedit text, sign, redact, merge, split, compress, encrypt, fill forms.\nno trial. no watermark. no account.")));
		return;
	}
	host.replaceChildren(toolSection(), annotSection() || "", docSection());
}

// =================================================================== status bar
function updateStatus() {
	const doc = cur();
	if (!doc) {
		$("#sb-page").value = "0";
		$("#sb-count").textContent = "/ 0";
		$("#sb-zoom").value = "-";
		$("#sb-msg").textContent = "ready. fuck subscriptions.";
		$("#sb-state").textContent = "";
		return;
	}
	if (document.activeElement !== $("#sb-page")) $("#sb-page").value = String(doc.current + 1);
	$("#sb-count").textContent = "/ " + doc.info.pages.length;
	if (document.activeElement !== $("#sb-zoom")) $("#sb-zoom").value = Math.round(doc.zoom * 100) + "%";
	$("#sb-fitw").classList.toggle("on", doc.fit === "width");
	$("#sb-fitp").classList.toggle("on", doc.fit === "page");
	$("#sb-msg").textContent = doc.info.path || doc.info.name + (doc.info.convertedFrom ? `  (converted from ${doc.info.convertedFrom})` : "  (not saved yet)");
	$("#sb-state").textContent = (isEncrypted(doc) ? "[locked] " : "") + (doc.info.dirty ? "* unsaved" : "saved");
	$("#tb-undo").disabled = !doc.info.canUndo;
	$("#tb-redo").disabled = !doc.info.canRedo;
}

$("#sb-prev").addEventListener("click", () => { const d = cur(); if (d) V.goToPage(Math.max(0, d.current - 1)); });
$("#sb-next").addEventListener("click", () => { const d = cur(); if (d) V.goToPage(Math.min(d.info.pages.length - 1, d.current + 1)); });
$("#sb-page").addEventListener("keydown", (e) => {
	e.stopPropagation();
	if (e.key === "Enter") { const n = parseInt(e.target.value, 10); const d = cur(); if (d && n >= 1 && n <= d.info.pages.length) V.goToPage(n - 1); e.target.blur(); }
});
$("#sb-page").addEventListener("blur", updateStatus);
$("#sb-zoom").addEventListener("keydown", (e) => {
	e.stopPropagation();
	if (e.key === "Enter") { const z = parseFloat(e.target.value); if (z > 0) V.setZoom(z / 100); e.target.blur(); }
});
$("#sb-zoom").addEventListener("blur", updateStatus);
$("#sb-zoom-in").addEventListener("click", () => V.zoomStep(1));
$("#sb-zoom-out").addEventListener("click", () => V.zoomStep(-1));
$("#sb-fitw").addEventListener("click", () => V.setZoom(0, { fit: "width" }));
$("#sb-fitp").addEventListener("click", () => V.setZoom(0, { fit: "page" }));

// =================================================================== welcome
function renderWelcome() {
	const recent = (S.settings.recent || []).slice(0, 8);
	const btn = (label, key, fn) => el("button", { on: { click: fn } }, label, key ? el("span.k", {}, key) : null);
	$("#welcome").replaceChildren(el("div.wl", {},
		drawFinger(Math.min(460, Math.max(260, window.innerHeight - 380))),
		el("div", {},
			el("pre.banner", {}, BANNER),
			el("div.tag", {}, "the pdf editor that doesn't want your credit card.\nedit text. sign. redact. merge. split. compress. encrypt. fill forms.\nall of it. free. forever. open source (AGPL)."),
			el("div.acts", {},
				btn("open a file", "ctrl+o", () => A.open()),
				btn("new blank pdf", "ctrl+n", () => A.newBlank()),
				btn("combine files", "", () => A.combine()),
				btn("images to pdf", "", () => A.imagesToPdf()),
			),
			recent.length ? el("div.recent", {}, el("h4", {}, "recent"), recent.map((p) => el("div", { title: p, on: { click: () => A.openPaths([p]) } }, shortPath(p)))) : null,
			el("div.tag", { style: { marginTop: "22px", marginBottom: 0 } }, "or just drop files anywhere."),
		)));
}

// =================================================================== bus wiring
bus.on("doc-changed", async (doc, ch) => {
	if (ch.structural) {
		await refreshInfo(doc);
	} else if (doc === cur()) {
		refreshThumbs(doc, ch.pages || []);
	}
	if (doc === cur()) {
		renderTabs();
		updateStatus();
		renderProps();
		refreshNotes();
		if (doc.search.query) runSearch(doc.search.query, doc.search.matchCase);
	}
});
bus.on("current-page", (doc) => {
	updateStatus();
	markThumbs();
	const t = $(`#side-pages .thumb[data-i="${doc.current}"]`);
	const host = $("#side-pages");
	if (t && !host.matches(":hover")) {
		const r = t.getBoundingClientRect(), hr = host.getBoundingClientRect();
		if (r.top < hr.top || r.bottom > hr.bottom) host.scrollTop += r.top - hr.top - hr.height / 3;
	}
	if (S.tool !== "select") return;
	renderPropsSoon();
});
const renderPropsSoon = debounce(renderProps, 150);
bus.on("zoom", () => updateStatus());
bus.on("annot-selected", () => renderProps());
bus.on("selection", () => renderProps());

// =================================================================== keyboard
function typing(e) {
	const t = e.target;
	return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

let spaceTool = null;
document.addEventListener("keydown", (e) => {
	if (modalOpen()) return;
	const ctrl = e.ctrlKey || e.metaKey;
	const k = e.key.toLowerCase();
	const doc = cur();
	if (ctrl) {
		const map = {
			o: () => A.open(), n: () => (e.shiftKey ? A.night() : A.newBlank()), p: () => A.print(), w: () => A.closeTab(), f: () => openFind(), g: () => A.goTo(), d: () => A.properties(),
			s: () => (e.shiftKey ? A.saveAs() : A.save()),
			z: () => (e.shiftKey ? A.redo() : A.undo()), y: () => A.redo(),
			"=": () => V.zoomStep(1), "+": () => V.zoomStep(1), "-": () => V.zoomStep(-1), "0": () => V.setZoom(1),
			"1": () => V.setZoom(0, { fit: "width" }), "2": () => V.setZoom(0, { fit: "page" }),
			r: () => A.rotate(e.shiftKey ? -90 : 90),
			i: () => e.shiftKey && api.devtools(),
		};
		if (k === "tab") {
			e.preventDefault();
			if (S.docs.length > 1) {
				const idx = S.docs.findIndex((d) => d.id === S.active);
				activate(S.docs[(idx + (e.shiftKey ? -1 : 1) + S.docs.length) % S.docs.length].id);
			}
			return;
		}
		if (typing(e) && !["s", "o", "p", "w", "f", "g"].includes(k)) return;
		if (k === "c") { if (doc && doc.selection) { e.preventDefault(); V.copySelection(); } return; }
		if (k === "a") { if (doc && document.activeElement !== $("#side-pages")) { e.preventDefault(); selectAllPage(); } return; }
		const fn = map[k];
		if (fn && (doc || ["o", "n"].includes(k))) { e.preventDefault(); fn(); }
		return;
	}
	if (e.key === "F1") { e.preventDefault(); D.shortcutsDialog(); return; }
	if (e.key === "F4") { e.preventDefault(); togglePanel("hide-side"); return; }
	if (e.key === "F6") { e.preventDefault(); togglePanel("hide-props"); return; }
	if (e.key === "F11") { e.preventDefault(); api.fullscreen(); return; }
	if (typing(e) || !doc) return;
	if (e.key === "Escape") {
		closeMenus();
		if (!$("#findbar").classList.contains("hidden")) { closeFind(); return; }
		if (doc.selection || doc.selectedAnnot) { V.clearSelections(); renderProps(); return; }
		if (S.tool !== "select") setTool("select");
		return;
	}
	if (e.key === "Delete" || e.key === "Backspace") {
		if (doc.selectedAnnot) { e.preventDefault(); V.deleteSelectedAnnot(); }
		return;
	}
	if (e.key === " " && !e.repeat && S.tool !== "hand") {
		e.preventDefault();
		spaceTool = S.tool;
		V.setTool("hand");
		return;
	}
	if (e.key === "Home") { e.preventDefault(); V.goToPage(0); return; }
	if (e.key === "End") { e.preventDefault(); V.goToPage(doc.info.pages.length - 1); return; }
	if ((e.key === "PageDown" || e.key === "PageUp") && document.activeElement !== V.viewerEl()) {
		e.preventDefault();
		V.goToPage(Math.max(0, Math.min(doc.info.pages.length - 1, doc.current + (e.key === "PageDown" ? 1 : -1))));
		return;
	}
	if (e.altKey || e.shiftKey) return;
	const tool = TOOL_KEYS[k];
	if (tool) { e.preventDefault(); pickTool(tool); }
});
document.addEventListener("keyup", (e) => {
	if (e.key === " " && spaceTool) {
		V.setTool(spaceTool);
		spaceTool = null;
		markTool();
	}
});

function togglePanel(cls) {
	document.body.classList.toggle(cls);
	setTimeout(() => V.onResize(), 30);
}

// =================================================================== drag + drop files
let dragDepth = 0;
function hideDrop() { dragDepth = 0; $("#drop-hint").classList.add("hidden"); }
window.addEventListener("dragenter", (e) => {
	if (!e.dataTransfer.types.includes("Files")) return;
	dragDepth++;
	$("#drop-hint").classList.remove("hidden");
});
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) hideDrop(); });
window.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); });
window.addEventListener("drop", async (e) => {
	e.preventDefault();
	hideDrop();
	const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
	if (paths.length) await A.openPaths(paths);
});

// =================================================================== boot
window.addEventListener("resize", debounce(() => V.onResize(), 60));
$("#logo").addEventListener("click", () => D.aboutDialog());

api.onOpenFiles((files) => A.openPaths(files));
api.onEngineCrash((msg) => {
	toast("the engine crashed and was restarted: " + msg + "\nopen documents had to be closed. sorry.", { error: true, ms: 10000 });
	S.docs = [];
	activate(null);
});

async function boot() {
	S.settings = await api.getSettings();
	const prefs = S.settings.prefs || {};
	if (prefs.tp) {
		S.tp = { ...S.tp, ...prefs.tp, colors: { ...S.tp.colors, ...(prefs.tp.colors || {}) }, edit: { ...S.tp.edit, ...(prefs.tp.edit || {}) } };
		if (S.tp.edit.family && S.tp.edit.family.startsWith("sys:")) S.tp.edit.family = "original"; // indices can change between runs
	}
	S.night = !!prefs.night;
	document.body.classList.toggle("night", S.night);
	buildMenubar();
	buildToolbar();
	setTool("select");
	activate(null);
	const pending = await api.pendingFiles();
	if (pending.length) await A.openPaths(pending);
	// index installed fonts in the background (used by edit text)
	setTimeout(async () => {
		try {
			S.systemFonts = await E("systemFonts");
			if (S.tool === "edittext") renderProps();
		} catch { S.systemFonts = []; }
	}, 400);
}

boot();
