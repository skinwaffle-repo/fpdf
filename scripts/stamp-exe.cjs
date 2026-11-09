// Stamp an icon + version info into a Windows exe, in pure JS (no wine needed).
"use strict";
const fs = require("node:fs");

async function stamp(exePath, { icon, version, description, product = "fuck pdf", original }) {
	const ResEdit = await import("resedit");
	const R = ResEdit.default || ResEdit;
	const exe = R.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
	const res = R.NtExecutableResource.from(exe);
	const ico = R.Data.IconFile.from(fs.readFileSync(icon));
	R.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, ico.icons.map((i) => i.data));
	const vi = R.Resource.VersionInfo.fromEntries(res.entries)[0] || R.Resource.VersionInfo.createEmpty();
	const v = version.split(".").map((n) => parseInt(n, 10) || 0);
	while (v.length < 4) v.push(0);
	vi.setFileVersion(...v, 1033);
	vi.setProductVersion(...v, 1033);
	vi.setStringValues({ lang: 1033, codepage: 1200 }, {
		FileDescription: description,
		ProductName: product,
		CompanyName: "fuck pdf contributors",
		LegalCopyright: "AGPL-3.0-or-later",
		OriginalFilename: original,
		InternalName: original.replace(/\.exe$/i, ""),
		FileVersion: version,
		ProductVersion: version,
	});
	vi.outputToResourceEntries(res.entries);
	res.outputResource(exe);
	fs.writeFileSync(exePath, Buffer.from(exe.generate()));
}

module.exports = { stamp };
