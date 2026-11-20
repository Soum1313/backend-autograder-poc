import { bundleStudentCode } from "./bundler.js"

// Implements the shared GraderRuntime contract (see docs/implementation-plan.md)
// for Solution B.
export class SolutionBRuntime {
    constructor() {
        this.worker = new Worker(new URL("./worker.js", import.meta.url))
        this._pending = new Map()
        this._msgId = 0
        this._bundledCode = null
        this.lastBundleTimeMs = null
        this.worker.onmessage = (ev) => {
            const { id, ok, result, error } = ev.data
            const p = this._pending.get(id)
            if (!p) return
            this._pending.delete(id)
            ok ? p.resolve(result) : p.reject(new Error(error))
        }
    }

    _send(type, payload) {
        const id = ++this._msgId
        return new Promise((resolve, reject) => {
            this._pending.set(id, { resolve, reject })
            this.worker.postMessage({ id, type, payload })
        })
    }

    async loadStudentCode(studentSource) {
        // cache: "no-store" - see the identical fix + comment in Solution A's
        // harness.js; the dev static server sends no cache-control headers
        // and the browser has repeatedly served stale shim files across edits.
        const [expressSrc, mongooseSrc] = await Promise.all([
            fetch(new URL("../shims/express-lite.js", import.meta.url), { cache: "no-store" }).then((r) => r.text()),
            fetch(new URL("../shims/mongoose-lite.js", import.meta.url), { cache: "no-store" }).then((r) => r.text()),
        ])
        const t0 = performance.now()
        this._bundledCode = await bundleStudentCode(studentSource, { express: expressSrc, mongoose: mongooseSrc })
        this.lastBundleTimeMs = performance.now() - t0
        await this._send("LOAD", { bundledCode: this._bundledCode })
    }

    async seed(docs, modelKey) {
        return this._send("SEED", { docs, modelKey })
    }

    async request(method, path, body, headers) {
        return this._send("REQUEST", { method, path, body, headers })
    }

    async getCollectionState(name) {
        return this._send("GET_COLLECTION", { name })
    }

    async reset() {
        await this._send("RESET", {})
        if (this._bundledCode) await this._send("LOAD", { bundledCode: this._bundledCode })
    }

    async dispose() {
        this.worker.terminate()
    }
}
