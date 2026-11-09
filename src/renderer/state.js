// fuck pdf - shared renderer state + engine bridge
// SPDX-License-Identifier: AGPL-3.0-or-later
import { toast } from "./ui.js";

export const api = window.fpdf;

export const S = {
	docs: [],
	active: null,
	tool: "select",
	night: false,
	settings: { recent: [], signatures: [], prefs: {} },
	tp: {
		colors: {
			highlight: "#ffd400", underline: "#1c71d8", strikeout: "#e01b24", squiggly: "#2ec27e",
			draw: "#e01b24", rect: "#e01b24", ellipse: "#1c71d8", line: "#000000", arrow: "#e01b24",
			addtext: "#000000", note: "#ffd400", stamp: "#e01b24",
		},
		width: 2,
		opacity: 1,
		hlOpacity: 0.45,
		fill: null,
		fontSize: 14,
		family: "helv",
		stampName: "Approved",
		stampText: "",
		edit: { family: "original", bold: null, italic: null, size: null, color: null },
	},
	activeSig: 0,
	pendingImage: null,
	systemFonts: null,
};

export const cur = () => S.docs.find((d) => d.id === S.active) || null;

// --------------------------------------------------------------- event bus
const handlers = {};
export const bus = {
	on(ev, fn) { (handlers[ev] ||= []).push(fn); },
	emit(ev, ...a) { for (const fn of handlers[ev] || []) { try { fn(...a); } catch (e) { console.error(e); } } },
};

// ------------------------------------------------------------ engine calls
export async function E(method, ...args) {
	return api.engine(method, ...args);
}

/** Call a mutating engine method and propagate the result to the UI. */
export async function op(doc, method, ...args) {
	try {
		const res = await api.engine(method, doc.id, ...args);
		applyResult(doc, res);
		return res;
	} catch (e) {
		toast(cleanErr(e), { error: true });
		throw e;
	}
}

export function applyResult(doc, res) {
	if (!res) return;
	if (res.state) Object.assign(doc.info, res.state);
	const ch = res.changed || { pages: "all" };
	if (ch.structural || ch.pages === "all") {
		doc.globalV++;
	} else if (Array.isArray(ch.pages)) {
		for (const i of ch.pages) doc.pageV[i] = (doc.pageV[i] || 0) + 1;
	}
	bus.emit("doc-changed", doc, ch);
}

export function cleanErr(e) {
	let m = String((e && e.message) || e);
	m = m.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "");
	return m;
}

export function newDocState(info) {
	return {
		id: info.id,
		info,
		zoom: 1,
		fit: "width",
		scrollTop: 0,
		scrollLeft: 0,
		current: 0,
		pageV: {},
		globalV: 1,
		cache: new Map(), // page -> {annots, widgets, lines, v}
		selection: null,
		selectedAnnot: null,
		selectedPages: new Set(),
		search: { query: "", matchCase: false, flat: [], index: -1, results: [] },
	};
}

export function pageVersion(doc, i) {
	return doc.globalV * 100000 + (doc.pageV[i] || 0);
}

export function savePrefs() {
	api.setSettings({ prefs: { ...S.settings.prefs, tp: S.tp, night: S.night } });
}
