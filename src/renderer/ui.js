// fuck pdf - small UI kit: elements, toasts, menus, modals.
// SPDX-License-Identifier: AGPL-3.0-or-later

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

/** el("div.cls#id", {attrs, on:{click}}, children...) */
export function el(spec, props = {}, ...kids) {
	if (props === null || typeof props !== "object" || props instanceof Node || Array.isArray(props)) {
		kids.unshift(props);
		props = {};
	}
	const m = spec.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
	const node = document.createElement((m && m[1]) || "div");
	if (m && m[2]) {
		for (const part of m[2].match(/[.#][\w-]+/g)) {
			if (part[0] === ".") node.classList.add(part.slice(1));
			else node.id = part.slice(1);
		}
	}
	for (const [k, v] of Object.entries(props)) {
		if (v == null || v === false) continue;
		if (k === "on") for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
		else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
		else if (k === "text") node.textContent = v;
		else if (k === "html") node.innerHTML = v;
		else if (k in node && typeof v !== "string") node[k] = v;
		else node.setAttribute(k, v === true ? "" : v);
	}
	for (const k of kids.flat(Infinity)) {
		if (k == null || k === false) continue;
		node.append(k instanceof Node ? k : document.createTextNode(String(k)));
	}
	return node;
}

export const SVGNS = "http://www.w3.org/2000/svg";
export function svg(tag, attrs = {}) {
	const n = document.createElementNS(SVGNS, tag);
	for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
	return n;
}

// ------------------------------------------------------------------ colors
export const PALETTE = ["#000000", "#ffffff", "#e01b24", "#ff7800", "#ffd400", "#2ec27e", "#1c71d8", "#9141ac"];
export function hex2rgb(h) {
	h = h.replace("#", "");
	if (h.length === 3) h = h.split("").map((c) => c + c).join("");
	return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}
export function rgb2hex(c) {
	if (!c || !c.length) return null;
	if (c.length === 1) c = [c[0], c[0], c[0]];
	if (c.length === 4) c = [(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])];
	return "#" + c.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------ toasts
export function toast(msg, { error = false, ms = 3200, action = null } = {}) {
	const t = el("div.toast" + (error ? ".err" : ""), {}, msg);
	if (action) t.append(el("button.ta", { on: { click: () => { action.fn(); t.remove(); } } }, action.label));
	document.getElementById("toasts").append(t);
	setTimeout(() => t.remove(), error ? Math.max(ms, 6000) : ms);
	return t;
}

let busyDepth = 0, busyNode = null;
export async function busy(label, fn) {
	const timer = setTimeout(() => {
		if (!busyNode) {
			busyNode = el("div.busy-cover", {}, el("pre", {}, label + " ..."));
			document.body.append(busyNode);
		}
	}, 250);
	busyDepth++;
	try {
		return await fn();
	} finally {
		clearTimeout(timer);
		if (--busyDepth === 0 && busyNode) { busyNode.remove(); busyNode = null; }
	}
}

// ------------------------------------------------------------------- menus
let openMenus = [];
export function closeMenus() {
	for (const m of openMenus) m.remove();
	openMenus = [];
	document.querySelectorAll("#menubar > button.open").forEach((b) => b.classList.remove("open"));
}

/**
 * items: [{label, key, action, disabled, checked, sub:[...]}, "-"]
 */
export function popupMenu(items, x, y, { level = 0 } = {}) {
	if (level === 0) closeMenus();
	else openMenus.splice(level).forEach((m) => m.remove());
	const menu = el("div.menu");
	for (const it of items) {
		if (it === "-" || it == null) { menu.append(el("div.sep")); continue; }
		const dis = typeof it.disabled === "function" ? it.disabled() : it.disabled;
		const label = (it.checked ? "[x] " : it.checked === false ? "[ ] " : "") + it.label;
		const row = el("div.mi" + (dis ? ".disabled" : "") + (it.sub ? ".sub" : ""), {}, el("span", {}, label), it.key ? el("span.k", {}, it.key) : null);
		if (it.sub) {
			row.addEventListener("mouseenter", () => {
				const r = row.getBoundingClientRect();
				popupMenu(typeof it.sub === "function" ? it.sub() : it.sub, r.right - 2, r.top - 4, { level: level + 1 });
			});
		} else {
			row.addEventListener("mouseenter", () => openMenus.splice(level + 1).forEach((m) => m.remove()));
			row.addEventListener("click", (e) => {
				e.stopPropagation();
				closeMenus();
				if (it.action) it.action();
			});
		}
		menu.append(row);
	}
	document.getElementById("menu-layer").append(menu);
	openMenus.push(menu);
	const r = menu.getBoundingClientRect();
	const W = window.innerWidth, H = window.innerHeight;
	menu.style.left = Math.max(0, Math.min(x, W - r.width - 4)) + "px";
	menu.style.top = Math.max(0, Math.min(y, H - r.height - 4)) + "px";
	return menu;
}

document.addEventListener("mousedown", (e) => {
	if (!e.target.closest(".menu") && !e.target.closest("#menubar")) closeMenus();
}, true);

// ------------------------------------------------------------------ modals
const modalStack = [];
export function modalOpen() { return modalStack.length > 0; }

/**
 * modal({title, body, buttons:[{label, value, primary, danger, left}], width, init(root)})
 * resolves with {value, form} where form is a map of named inputs.
 */
export function modal({ title, body, buttons = [{ label: "ok", value: true, primary: true }], width, init, cancelValue = null }) {
	return new Promise((resolve) => {
		const bodyNode = typeof body === "string" ? el("div", { html: body }) : body;
		const close = (value) => {
			back.remove();
			modalStack.splice(modalStack.indexOf(back), 1);
			document.removeEventListener("keydown", onKey, true);
			resolve({ value, form: readForm(bodyNode) });
		};
		const box = el("div.modal", { style: width ? { width: width + "px" } : {} },
			el("header", {}, el("span", {}, "// " + title), el("button", { title: "close", on: { click: () => close(cancelValue) } }, "x")),
			el("div.mb", {}, bodyNode),
			buttons.length ? el("footer", {}, buttons.map((b) => el("button" + (b.primary ? ".primary" : "") + (b.danger ? ".danger" : "") + (b.left ? ".left" : ""), {
				on: { click: async () => {
					if (b.validate) { const ok = await b.validate(readForm(bodyNode), bodyNode); if (!ok) return; }
					close(b.value);
				} },
			}, b.label))) : null,
		);
		const back = el("div.backdrop", { on: { mousedown: (e) => { if (e.target === back) back.dataset.down = "1"; }, mouseup: (e) => { if (e.target === back && back.dataset.down) close(cancelValue); delete back.dataset.down; } } }, box);
		const onKey = (e) => {
			if (modalStack[modalStack.length - 1] !== back) return;
			if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(cancelValue); }
			if (e.key === "Enter" && !e.shiftKey && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "BUTTON") {
				const primary = buttons.find((b) => b.primary);
				if (primary) {
					e.preventDefault();
					e.stopPropagation();
					box.querySelector("footer button.primary")?.click();
				}
			}
		};
		document.addEventListener("keydown", onKey, true);
		document.getElementById("modal-layer").append(back);
		modalStack.push(back);
		if (init) init(bodyNode, close);
		setTimeout(() => {
			const f = bodyNode.querySelector("[autofocus]") || bodyNode.querySelector("input:not([type=checkbox]):not([type=radio]), select, textarea");
			if (f) { f.focus(); if (f.select && f.type !== "number") f.select(); }
		}, 20);
	});
}

export function readForm(root) {
	const out = {};
	if (!root || !root.querySelectorAll) return out;
	for (const n of root.querySelectorAll("[name]")) {
		if (n.type === "checkbox") out[n.name] = n.checked;
		else if (n.type === "radio") { if (n.checked) out[n.name] = n.value; }
		else if (n.type === "number" || n.type === "range") out[n.name] = n.value === "" ? null : Number(n.value);
		else out[n.name] = n.value;
	}
	return out;
}

export async function confirmBox(title, text, { ok = "ok", cancel = "cancel", danger = false } = {}) {
	const r = await modal({
		title,
		body: el("div.f-help", { style: { margin: 0 } }, text),
		buttons: [{ label: cancel, value: false }, { label: ok, value: true, primary: true, danger }],
		cancelValue: false,
	});
	return r.value === true;
}

export async function promptBox(title, label, value = "", { help = "", type = "text", multiline = false } = {}) {
	const input = multiline
		? el("textarea", { name: "v", rows: 5, style: { width: "100%" } }, value)
		: el("input", { name: "v", type, value, autofocus: true, spellcheck: false });
	const r = await modal({
		title,
		body: el("div", {}, help ? el("div.f-help", {}, help) : null, el("div.f-row", {}, el("label", {}, label), input)),
		buttons: [{ label: "cancel", value: false }, { label: "ok", value: true, primary: true }],
	});
	return r.value ? r.form.v : null;
}

/** form row helper */
export function row(label, input, help) {
	return el("div", {}, el("div.f-row", {}, el("label", {}, label), input), help ? el("div.f-help", {}, help) : null);
}

export function fmtBytes(n) {
	if (n < 1024) return n + " B";
	if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
	return (n / 1024 / 1024).toFixed(2) + " MB";
}

export function debounce(fn, ms) {
	let t = null;
	return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
