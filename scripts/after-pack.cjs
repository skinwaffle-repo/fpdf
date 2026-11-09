// electron-builder afterPack hook: icon + version info for the app exe (no wine needed).
"use strict";
const path = require("node:path");
const { stamp } = require("./stamp-exe.cjs");

exports.default = async function afterPack(ctx) {
	if (ctx.electronPlatformName !== "win32") return;
	const info = ctx.packager.appInfo;
	const exe = path.join(ctx.appOutDir, `${info.productFilename}.exe`);
	await stamp(exe, {
		icon: path.join(ctx.packager.info.projectDir, "build", "icon.ico"),
		version: info.version,
		description: "fuck pdf - free pdf viewer and editor",
		original: `${info.productFilename}.exe`,
	});
	console.log("  * stamped icon + version info into", path.basename(exe));
};
