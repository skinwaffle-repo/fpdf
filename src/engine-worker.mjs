// fuck pdf - engine worker thread
// SPDX-License-Identifier: AGPL-3.0-or-later
import { parentPort, workerData } from "node:worker_threads";
import { Engine } from "./engine.mjs";

const engine = new Engine({ fontDirs: workerData && workerData.fontDirs });

function transferables(value, out = [], depth = 0) {
	if (!value || depth > 4) return out;
	if (ArrayBuffer.isView(value)) {
		// only transfer buffers we own outright, never a view into WASM memory
		const own = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength;
		if (own && !(value.buffer instanceof SharedArrayBuffer) && !out.includes(value.buffer)) out.push(value.buffer);
	} else if (Array.isArray(value)) {
		for (const v of value) transferables(v, out, depth + 1);
	} else if (typeof value === "object") {
		for (const k of Object.keys(value)) transferables(value[k], out, depth + 1);
	}
	return out;
}

parentPort.on("message", ({ id, method, args }) => {
	try {
		if (typeof method !== "string" || method.startsWith("_") || typeof engine[method] !== "function") {
			throw new Error("Unknown engine method: " + method);
		}
		const result = engine[method](...(args || []));
		let transfer = [];
		try { transfer = transferables(result); } catch { transfer = []; }
		parentPort.postMessage({ id, result }, transfer);
	} catch (e) {
		const message = String((e && e.message) || e);
		parentPort.postMessage({ id, error: message, code: (e && e.code) || null });
	}
});

parentPort.postMessage({ ready: true });
