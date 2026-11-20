// Implements the shared GraderRuntime contract for Solution A (BrowserPod).
//
// v2: runs on the FREE fetch network (no API key, no account, no Edge, no
// Portal). The only thing that ever needs real networking is `npm install`
// (via BrowserPod.opinionatedFetch, which exists specifically to make npm
// work on the free network - see https://browserpod.io/docs/understanding-browserpod/networking).
// Every grading request happens *inside* the Pod: request-cli.js makes a
// plain loopback HTTP call to the already-running server.js on the same Pod,
// and the host page only ever reads the result back through the terminal's
// stdout capture (pod.run()'s exit + the accumulated onOutput text) - never a
// real cross-origin fetch. See docs/solution-a-architecture.md.

const RESP_PREFIX = "##RESP##"

export class SolutionARuntime {
    constructor({ log } = {}) {
        this.log = log || (() => {})
        this.pod = null
    }

    async boot({ studentSource }) {
        const t0 = performance.now()
        const mod = await import("https://esm.sh/@leaningtech/browserpod@4.1.0")
        const { BrowserPod } = mod.default ?? mod
        this.BrowserPod = BrowserPod
        this.bootImportMs = performance.now() - t0

        const tBoot0 = performance.now()
        const network = await BrowserPod.createFetchNetwork({ fetch: BrowserPod.opinionatedFetch })
        this.pod = await BrowserPod.boot({ network })
        this.bootPodMs = performance.now() - tBoot0

        this.outputBuffer = ""
        const decoder = new TextDecoder()
        this.terminal = await this.pod.createCustomTerminal({
            onOutput: (buf) => {
                // BrowserPod can hand back a Uint8Array backed by a resizable
                // ArrayBuffer, which TextDecoder.decode() rejects outright in
                // some browsers - copy into a plain fixed-length buffer first.
                const text = decoder.decode(new Uint8Array(buf))
                this.outputBuffer += text
                this.log(text)
            },
        })

        await this.pod.createDirectory("/project", { recursive: true })

        // cache: "no-store" - the dev static server (python http.server) sends
        // no cache-control headers, and the browser was repeatedly caching
        // stale copies of these pod-files across edits during development
        // (confirmed live: an old pre-populate() mongoose-lite-node.js got
        // served this way). These files are small and fetched once per boot,
        // so there's no real cost to always getting a fresh copy.
        const noCache = { cache: "no-store" }
        const [packageJson, serverSrc, cliSrc, mongooseShim] = await Promise.all([
            fetch(new URL("../pod-files/package.json", import.meta.url), noCache).then((r) => r.text()),
            fetch(new URL("../pod-files/server.js", import.meta.url), noCache).then((r) => r.text()),
            fetch(new URL("../pod-files/request-cli.js", import.meta.url), noCache).then((r) => r.text()),
            fetch(new URL("../pod-files/mongoose-lite-node.js", import.meta.url), noCache).then((r) => r.text()),
        ])

        await this._writeFile("/project/package.json", packageJson)
        await this._writeFile("/project/reference-solution.js", studentSource)
        await this._writeFile("/project/server.js", serverSrc)
        await this._writeFile("/project/request-cli.js", cliSrc)

        const tInstall0 = performance.now()
        const installExit = await this.pod.run("npm", ["install"], { terminal: this.terminal, cwd: "/project", echo: true })
        this.npmInstallMs = performance.now() - tInstall0
        if (installExit !== 0) {
            throw new Error(`npm install failed (exit ${installExit}) on the free fetch network. Output:\n${this.outputBuffer.slice(-2000)}`)
        }

        // Written *after* npm install: a plain `npm install` prunes extraneous
        // top-level packages not listed in package.json, so writing this shim
        // first just gets it deleted (observed directly: "removed 1 package").
        await this.pod.createDirectory("/project/node_modules/mongoose", { recursive: true })
        await this._writeFile("/project/node_modules/mongoose/package.json", JSON.stringify({ name: "mongoose", main: "index.js" }))
        await this._writeFile("/project/node_modules/mongoose/index.js", mongooseShim)

        // Fire-and-forget: this is a long-running server, not a one-shot
        // command. Process is thenable but not a real Promise (no .catch),
        // so wrap it to observe an unexpected exit/crash.
        Promise.resolve(this.pod.run("node", ["server.js"], { terminal: this.terminal, cwd: "/project", echo: true })).catch((e) => {
            this.log(`\n[server process ended] ${e?.message ?? e}\n`)
        })

        // No Portal to await this time - just give the server a moment to
        // bind its port before the first request-cli.js call.
        await new Promise((r) => setTimeout(r, 500))
    }

    async _runCli(method, path, body, headers) {
        const startLen = this.outputBuffer.length
        const args = ["request-cli.js", method, path, body !== undefined ? JSON.stringify(body) : "null", headers ? JSON.stringify(headers) : "null"]
        await this.pod.run("node", args, { terminal: this.terminal, cwd: "/project" })
        const newOutput = this.outputBuffer.slice(startLen)
        const line = newOutput.split("\n").find((l) => l.startsWith(RESP_PREFIX))
        if (!line) throw new Error(`No response line from request-cli.js. Output:\n${newOutput}`)
        const parsed = JSON.parse(line.slice(RESP_PREFIX.length))
        if (parsed.error) throw new Error(parsed.error)
        return parsed
    }

    async request(method, path, body, headers) {
        return this._runCli(method, path, body, headers)
    }

    async seed(docs, modelKey) {
        return this._runCli("POST", "/__grader/seed", { docs, modelKey })
    }

    async getCollectionState(name) {
        const res = await this._runCli("GET", `/__grader/collection/${name}`)
        return res.body
    }

    async reset() {
        await this._runCli("POST", "/__grader/reset")
    }

    async _writeFile(path, contents) {
        const file = await this.pod.createFile(path, "utf-8")
        await file.write(contents)
        await file.close()
    }

    async dispose() {
        // No documented pod.dispose()/terminate() in the SDK at the time of
        // writing; see docs/solution-a-architecture.md.
    }
}
