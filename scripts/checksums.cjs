// Write dist/SHA256SUMS for the release files (the updater verifies against it).
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const dist = path.resolve(__dirname, "..", "dist");
const version = require("../package.json").version;
const files = [`fuck-pdf-${version}-setup.exe`, `fuck-pdf-${version}-portable.exe`];
const lines = [];
for (const f of files) {
	const p = path.join(dist, f);
	if (!fs.existsSync(p)) continue;
	const h = crypto.createHash("sha256");
	h.update(fs.readFileSync(p));
	lines.push(`${h.digest("hex")}  ${f}`);
}
const updater = path.resolve(__dirname, "..", "dist-updater", "fuck-pdf-updater.exe");
if (fs.existsSync(updater)) {
	fs.copyFileSync(updater, path.join(dist, "fuck-pdf-updater.exe"));
	lines.push(`${crypto.createHash("sha256").update(fs.readFileSync(updater)).digest("hex")}  fuck-pdf-updater.exe`);
}
fs.writeFileSync(path.join(dist, "SHA256SUMS"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
