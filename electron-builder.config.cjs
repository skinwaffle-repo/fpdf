// electron-builder config. A JS file (not package.json) so icon file names
// can carry the version: Windows caches icons by path, and a new path is the
// only reliable way to make shortcuts and .pdf files show a new icon.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

// FPDF_VERSION lets the test suite build a "newer" copy without touching package.json
const version = process.env.FPDF_VERSION || require("./package.json").version;
const gen = path.join(__dirname, "build", "gen");
fs.rmSync(gen, { recursive: true, force: true });
fs.mkdirSync(gen, { recursive: true });
const appIcon = `fuck-pdf-${version}.ico`;
const docIcon = `fuck-pdf-doc-${version}.ico`;
fs.copyFileSync(path.join(__dirname, "build", "icon.ico"), path.join(gen, appIcon));
fs.copyFileSync(path.join(__dirname, "build", "pdf-file.ico"), path.join(gen, docIcon));

module.exports = {
	appId: "org.fuckpdf.app",
	productName: "fuck pdf",
	copyright: "AGPL-3.0-or-later",
	asar: false,
	directories: { output: "dist", buildResources: "build" },
	files: ["src/**/*", "build/icon.ico", "build/icon.png", "package.json", "LICENSE", "!**/*.br", "!**/*.d.ts", "!node_modules/mupdf/README.md"],
	extraResources: [
		{ from: "dist-updater", to: "updater", filter: ["fuck-pdf-updater.exe", "updater.json"] },
		{ from: "build/gen", to: ".", filter: [appIcon] },
	],
	afterPack: "scripts/after-pack.cjs",
	fileAssociations: [{
		ext: "pdf",
		name: "PDF Document",
		description: "PDF Document",
		role: "Editor",
		icon: `build/gen/${docIcon}`,
	}],
	win: {
		icon: "build/icon.ico",
		signAndEditExecutable: false,
		target: [{ target: "portable", arch: ["x64"] }, { target: "nsis", arch: ["x64"] }],
	},
	portable: { artifactName: "fuck-pdf-${version}-portable.exe" },
	nsis: {
		oneClick: false,
		perMachine: false,
		allowToChangeInstallationDirectory: true,
		artifactName: "fuck-pdf-${version}-setup.exe",
		installerIcon: "build/icon.ico",
		uninstallerIcon: "build/icon.ico",
		createDesktopShortcut: true,
		createStartMenuShortcut: true,
		shortcutName: "fuck pdf",
		license: "LICENSE",
		include: "build/installer.nsh",
	},
};
