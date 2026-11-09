// electron-builder afterPack hook: stamp icon + version info into the Windows exe
// in pure JS (resedit), so building on Linux doesn't need wine.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(ctx) {
	if (ctx.electronPlatformName !== "win32") return;
	const ResEdit = await import("resedit");
	const R = ResEdit.default || ResEdit;
	const pkg = ctx.packager.appInfo;
	const exe = path.join(ctx.appOutDir, `${pkg.productFilename}.exe`);
	const iconFile = path.join(ctx.packager.info.projectDir, "build", "icon.ico");
	const data = fs.readFileSync(exe);
	const exeObj = R.NtExecutable.from(data, { ignoreCert: true });
	const res = R.NtExecutableResource.from(exeObj);
	const ico = R.Data.IconFile.from(fs.readFileSync(iconFile));
	R.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, ico.icons.map((i) => i.data));
	const vi = R.Resource.VersionInfo.fromEntries(res.entries)[0] || R.Resource.VersionInfo.createEmpty();
	const v = pkg.version.split(".").map((n) => parseInt(n, 10) || 0);
	while (v.length < 4) v.push(0);
	vi.setFileVersion(...v, 1033);
	vi.setProductVersion(...v, 1033);
	vi.setStringValues({ lang: 1033, codepage: 1200 }, {
		FileDescription: "fuck pdf - free pdf viewer and editor",
		ProductName: "fuck pdf",
		CompanyName: "fuck pdf contributors",
		LegalCopyright: "AGPL-3.0-or-later",
		OriginalFilename: `${pkg.productFilename}.exe`,
		InternalName: "fuck pdf",
		FileVersion: pkg.version,
		ProductVersion: pkg.version,
	});
	vi.outputToResourceEntries(res.entries);
	res.outputResource(exeObj);
	fs.writeFileSync(exe, Buffer.from(exeObj.generate()));
	console.log("  * stamped icon + version info into", path.basename(exe));
};
