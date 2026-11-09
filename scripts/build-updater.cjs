// Build the Windows updater (Go, cross-compiled) into dist-updater/.
"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { stamp } = require("./stamp-exe.cjs");

const root = path.resolve(__dirname, "..");
const version = require(path.join(root, "package.json")).version;
const out = path.join(root, "dist-updater");
const exe = path.join(out, "fuck-pdf-updater.exe");

(async () => {
	fs.mkdirSync(out, { recursive: true });
	execFileSync("go", ["test", "./..."], { cwd: path.join(root, "updater"), stdio: "inherit" });
	execFileSync("go", ["build", "-trimpath", "-ldflags", `-s -w -X main.version=${version}`, "-o", exe, "."], {
		cwd: path.join(root, "updater"),
		stdio: "inherit",
		env: { ...process.env, GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "0" },
	});
	await stamp(exe, { icon: path.join(root, "build", "icon.ico"), version, description: "fuck pdf updater", original: "fuck-pdf-updater.exe" });
	fs.copyFileSync(path.join(root, "build", "updater.json"), path.join(out, "updater.json"));
	console.log(`  * built ${path.relative(root, exe)} ${version} (${(fs.statSync(exe).size / 1e6).toFixed(1)} MB)`);
})().catch((e) => { console.error(e); process.exit(1); });
