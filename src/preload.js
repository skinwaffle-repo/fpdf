// fuck pdf - preload bridge
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const { contextBridge, ipcRenderer, webUtils } = require("electron");

async function engine(method, ...args) {
	const r = await ipcRenderer.invoke("engine", method, args);
	if (!r.ok) {
		const e = new Error(r.error);
		e.code = r.code;
		throw e;
	}
	return r.value;
}

async function unwrap(p) {
	const r = await p;
	if (r && r.ok === false) throw new Error(r.error);
	return r && "value" in r ? r.value : r;
}

contextBridge.exposeInMainWorld("fpdf", {
	engine,
	openDialog: (opts) => ipcRenderer.invoke("file:openDialog", opts),
	saveDialog: (opts) => ipcRenderer.invoke("file:saveDialog", opts),
	pickFolder: (opts) => ipcRenderer.invoke("file:pickFolder", opts),
	openFile: (file, password) => unwrap(ipcRenderer.invoke("file:open", file, password)),
	readFile: (file) => ipcRenderer.invoke("file:read", file),
	saveDoc: (docId, file, opts) => unwrap(ipcRenderer.invoke("file:saveDoc", docId, file, opts)),
	writeFile: (file, bytes) => unwrap(ipcRenderer.invoke("file:write", file, bytes)),
	writeMany: (folder, files) => unwrap(ipcRenderer.invoke("file:writeMany", folder, files)),
	exists: (file) => ipcRenderer.invoke("file:exists", file),
	pendingFiles: () => ipcRenderer.invoke("app:pendingFiles"),
	getSettings: () => ipcRenderer.invoke("settings:get"),
	setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
	appInfo: () => ipcRenderer.invoke("app:info"),
	print: (docId, opts) => unwrap(ipcRenderer.invoke("app:print", docId, opts)),
	showInFolder: (file) => ipcRenderer.invoke("shell:show", file),
	openExternal: (url) => ipcRenderer.invoke("shell:external", url),
	devtools: () => ipcRenderer.invoke("app:devtools"),
	fullscreen: () => ipcRenderer.invoke("app:fullscreen"),
	quit: () => ipcRenderer.invoke("app:quit"),
	pathForFile: (file) => {
		try { return webUtils.getPathForFile(file); } catch { return ""; }
	},
	onOpenFiles: (cb) => ipcRenderer.on("open-files", (_e, files) => cb(files)),
	onEngineCrash: (cb) => ipcRenderer.on("engine-crashed", (_e, msg) => cb(msg)),
	platform: process.platform,
});
