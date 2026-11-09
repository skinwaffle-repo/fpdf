// fuck pdf - system font index
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reads the `name` table of every TTF/OTF/TTC in the given folders so that
// edited text can be written in the same font the PDF originally used
// (embedded fonts are usually subsets and lack most glyphs).

import fs from "node:fs";
import path from "node:path";

const EXT = /\.(ttf|otf|ttc|otc)$/i;

export function norm(s) {
	return String(s || "").replace(/^[A-Z]{6}\+/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stripSuffix(s) {
	return s.replace(/(psmt|mt|ps|std|pro)$/, "");
}

function readAt(fd, pos, len) {
	const b = Buffer.alloc(len);
	const n = fs.readSync(fd, b, 0, len, pos);
	return n === len ? b : b.subarray(0, n);
}

function decodeName(buf, platform, encoding) {
	if (platform === 3 || platform === 0) {
		let s = "";
		for (let i = 0; i + 1 < buf.length; i += 2) s += String.fromCharCode(buf.readUInt16BE(i));
		return s;
	}
	return buf.toString("latin1");
}

function parseFace(fd, offset) {
	const head = readAt(fd, offset, 12);
	if (head.length < 12) return null;
	const numTables = head.readUInt16BE(4);
	const dir = readAt(fd, offset + 12, numTables * 16);
	let nameOff = -1, nameLen = 0;
	for (let i = 0; i < numTables; i++) {
		const tag = dir.toString("latin1", i * 16, i * 16 + 4);
		if (tag === "name") {
			nameOff = dir.readUInt32BE(i * 16 + 8);
			nameLen = dir.readUInt32BE(i * 16 + 12);
		}
	}
	if (nameOff < 0 || nameLen > 2_000_000) return null;
	const t = readAt(fd, nameOff, nameLen);
	const count = t.readUInt16BE(2);
	const strOff = t.readUInt16BE(4);
	const best = {};
	for (let i = 0; i < count; i++) {
		const r = 6 + i * 12;
		if (r + 12 > t.length) break;
		const platform = t.readUInt16BE(r), encoding = t.readUInt16BE(r + 2), lang = t.readUInt16BE(r + 4);
		const id = t.readUInt16BE(r + 6), len = t.readUInt16BE(r + 8), off = t.readUInt16BE(r + 10);
		if (![1, 2, 4, 6, 16, 17].includes(id)) continue;
		// prefer Windows English, then any Windows, then Mac
		const score = platform === 3 ? (lang === 0x409 ? 3 : 2) : platform === 1 ? 1 : 0;
		if (best[id] && best[id].score >= score) continue;
		const s = t.subarray(strOff + off, strOff + off + len);
		best[id] = { score, value: decodeName(s, platform, encoding).replace(/\0/g, "").trim() };
	}
	const get = (id) => (best[id] ? best[id].value : "");
	const family = get(16) || get(1);
	const sub = get(17) || get(2) || "Regular";
	return { family, sub, full: get(4) || `${family} ${sub}`, ps: get(6) };
}

export class FontIndex {
	constructor(dirs = []) {
		this.dirs = dirs;
		this.faces = null;
	}

	setDirs(dirs) {
		this.dirs = dirs;
		this.faces = null;
	}

	build() {
		if (this.faces) return this.faces;
		const faces = [];
		const seen = new Set();
		const walk = (dir, depth) => {
			let entries = [];
			try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
			for (const e of entries) {
				const p = path.join(dir, e.name);
				if (e.isDirectory() && depth < 4) walk(p, depth + 1);
				else if (EXT.test(e.name)) {
					const key = p.toLowerCase();
					if (seen.has(key)) continue;
					seen.add(key);
					this._addFile(p, faces);
				}
			}
		};
		for (const d of this.dirs) walk(d, 0);
		for (const f of faces) {
			f.k = {
				ps: norm(f.ps),
				full: norm(f.full),
				fam: norm(f.family),
				famsub: norm(f.family + (/^(regular|normal|book|roman)$/i.test(f.sub) ? "" : f.sub)),
			};
			const s = f.sub.toLowerCase();
			f.bold = /bold|black|heavy|semibold|demi/.test(s);
			f.italic = /italic|oblique/.test(s);
		}
		faces.sort((a, b) => a.full.localeCompare(b.full));
		faces.forEach((f, i) => (f.key = "sys:" + i));
		this.faces = faces;
		return faces;
	}

	_addFile(file, faces) {
		let fd;
		try {
			fd = fs.openSync(file, "r");
			const tag = readAt(fd, 0, 12);
			if (tag.toString("latin1", 0, 4) === "ttcf") {
				const n = Math.min(tag.readUInt32BE(8), 64);
				const offs = readAt(fd, 12, n * 4);
				for (let i = 0; i < n; i++) {
					const face = parseFace(fd, offs.readUInt32BE(i * 4));
					if (face && face.family) faces.push({ ...face, file, index: i });
				}
			} else {
				const face = parseFace(fd, 0);
				if (face && face.family) faces.push({ ...face, file, index: 0 });
			}
		} catch {
			/* unreadable font, skip */
		} finally {
			if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
		}
	}

	list() {
		return this.build().map((f) => ({ key: f.key, name: f.full, family: f.family, sub: f.sub }));
	}

	byKey(key) {
		return this.build().find((f) => f.key === key) || null;
	}

	/** Find the installed font that best matches a PDF font name. */
	match(pdfName, { bold = false, italic = false } = {}) {
		const faces = this.build();
		if (!faces.length || !pdfName) return null;
		const raw = String(pdfName).replace(/^[A-Z]{6}\+/, "");
		const n = norm(raw);
		const ns = stripSuffix(n);
		let f = faces.find((x) => x.k.ps === n) ||
			faces.find((x) => x.k.full === n || x.k.famsub === n) ||
			faces.find((x) => stripSuffix(x.k.ps) === ns || x.k.full === ns || x.k.famsub === ns);
		if (f) return f;
		// family + style, e.g. "Calibri,Bold" or "Calibri-BoldItalic"
		const fam = norm(raw.split(/[-,]/)[0]);
		const cands = faces.filter((x) => x.k.fam === fam || stripSuffix(x.k.fam) === stripSuffix(fam));
		if (!cands.length) return null;
		return cands.find((x) => x.bold === bold && x.italic === italic) ||
			cands.find((x) => x.bold === bold) || cands[0];
	}

	read(face) {
		return new Uint8Array(fs.readFileSync(face.file));
	}
}

export function defaultFontDirs() {
	const dirs = [];
	const env = process.env;
	if (process.platform === "win32") {
		dirs.push(path.join(env.WINDIR || "C:\\Windows", "Fonts"));
		if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts"));
	} else if (process.platform === "darwin") {
		dirs.push("/System/Library/Fonts", "/Library/Fonts");
		if (env.HOME) dirs.push(path.join(env.HOME, "Library", "Fonts"));
	} else {
		dirs.push("/usr/share/fonts", "/usr/local/share/fonts");
		if (env.HOME) dirs.push(path.join(env.HOME, ".fonts"), path.join(env.HOME, ".local", "share", "fonts"));
	}
	return dirs;
}
