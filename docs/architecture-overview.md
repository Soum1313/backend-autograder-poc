# Architecture Overview — Solution A vs Solution B

A condensed, implementation-level summary of both solutions. For full build logs,
every bug hit, and exact measurements, see `docs/solution-a-architecture.md` and
`docs/solution-b-architecture.md`.

---

## Solution A — BrowserPod (real Node.js runtime in the browser)

### Core idea

Boot an actual, unmodified Node.js 22 runtime inside the browser tab (compiled to
WebAssembly, virtualized as a Linux-like microVM by BrowserPod), `npm install` the
student's real dependencies, run their real Express app, and grade it — all **for free,
with no account or API key**: the only thing that ever needs real networking is
`npm install`, and BrowserPod's free "fetch network" plus its `opinionatedFetch` helper
make that work without a key. Everything else happens entirely inside the Pod over
plain loopback, which both networking tiers support identically.

### Architecture

```
Browser tab (grading page)
  |
  |-- @leaningtech/browserpod SDK (loaded from esm.sh CDN)
  |     |
  |     '-- BrowserPod.createFetchNetwork({ fetch: BrowserPod.opinionatedFetch })
  |         BrowserPod.boot({ network })  ->  Pod (WASM Linux microVM + real Node 22)
  |           |                                 (no API key, no account - free tier)
  |           |-- real npm install (express + ~68 transitive deps, via opinionatedFetch)
  |           |-- pod-files/server.js   <- outer Express app we write (grader routes)
  |           |     '-- mounts the student's untouched reference-solution.js as middleware
  |           |-- node_modules/mongoose = our in-memory JS shim (real Mongoose can't
  |           |      reach a real DB from inside the sandbox, and mongodb-memory-server's
  |           |      native binary is explicitly unsupported by BrowserPod)
  |           |-- app.listen(4000)                      <- plain loopback, no Portal
  |           '-- pod-files/request-cli.js               <- one fresh `node` process per
  |                 (real http.request() to localhost:4000)   grading call
  |
  '-- harness.js (GraderRuntime impl): pod.run("node", ["request-cli.js", ...]) per
        request / seed / reset / getCollectionState call, reading the result back out
        of the terminal's captured stdout (a "##RESP##{...}" line) - never a real
        cross-origin fetch, so no Edge/Portal/API key is needed anywhere
```

### Execution flow, per submission

1. Import the SDK, create a free fetch network with `opinionatedFetch`, `BrowserPod.boot({ network })`
   — boots a fresh Linux/Node microVM, no API key.
2. Write files into the Pod's virtual filesystem: `package.json`, the student's
   unmodified submission, our `server.js` wrapper, and `request-cli.js`.
3. Run `npm install` for real (downloads express + transitive deps from the real npm
   registry via `opinionatedFetch`).
4. Write `node_modules/mongoose` (our shim) *after* `npm install` finishes — writing it
   before gets it silently deleted as "extraneous."
5. Start `node server.js` as a long-running process (fire-and-forget).
6. For every test case/seed/reset call, spawn `node request-cli.js <method> <path> <body> <headers>`
   — a one-shot process that makes a real loopback HTTP call to `server.js` and prints
   the result as one line; the harness reads it back out of the terminal's stdout buffer.

### What's real vs. shimmed

| Layer | Real or shimmed |
|---|---|
| Node.js runtime | **Real** (actual Node 22, WASM-virtualized) |
| Express | **Real** (`npm install express`, the actual package) |
| Mongoose / database | **Shimmed** (in-memory JS Map store; real Mongoose has nothing to connect to) |
| Network transport to the app | **Real loopback HTTP**, entirely inside the Pod — no cross-origin call, no Portal, no API key |

### Known limitations (measured, not theoretical)

- ~35 s boot-to-ready per submission on the free tier (dominated by `npm install`,
  which is itself ~3.8x slower than with a paid API key because two of npm's own
  audit/advisory endpoint calls get CORS-blocked on the free network and retry before
  giving up). With an API key (BrowserPod Edge, still free up to 1,000 hours/month):
  ~10.5 s.
- ~871 ms per test-case request on the free tier (a fresh `node` process spawned per
  call); ~238 ms with an API key (one Portal connection reused). This is a fixable
  design choice — batching multiple requests into one `request-cli.js` invocation
  would amortize the Node-startup cost — not attempted in this POC.
- One unhandled async error in student code can crash the entire Node process,
  silently failing every subsequent test case in that run (Express 4 has no
  built-in async-rejection safety net).
- Running 3 Pods concurrently in one browser tab was not demonstrated to work
  reliably in this POC (CORS failures, one boot that never resolved) — found on the
  paid tier, not re-tested on the free tier, but not expected to differ.
- **No account or API key needed** (confirmed live on the free tier) — this is no
  longer a limitation, just noted here since it was one in the first version of this POC.
- Requires COOP/COEP response headers on the hosting page (a real but small
  deployment constraint, applies on both tiers).

---

## Solution B — esbuild-wasm + Custom Express/Mongoose Adapter

### Core idea

Don't try to run real Node.js at all. Bundle the student's plain CommonJS
Express/Mongoose-style code with esbuild-wasm (running client-side, loaded from a
CDN), resolving `require("express")`/`require("mongoose")` to our own small
compatibility shims instead of the real packages, then execute the result directly
in-process inside a dedicated Web Worker — no network, no account, no real server.

### Architecture

```
Student submission (plain CJS: require("express"), require("mongoose"))
        |
        v
bundler.js — esbuild-wasm (esm.sh CDN, no npm install for the page itself)
  virtual-fs plugin:
    - "express"  -> shims/express-lite.js
    - "mongoose" -> shims/mongoose-lite.js
    - entry.js   -> the student's source
  bundles everything into one self-contained IIFE (format: iife, globalName)
        |
        v
worker.js (dedicated Web Worker — the isolation boundary)
  (0, eval)(bundledCode)  ->  self.StudentModule = { app, Todo, ... }
  mongoose-lite's in-memory collections live only in this worker's global scope
        |
        v
harness.js (main thread) — GraderRuntime implementation
  postMessage protocol: LOAD / SEED / REQUEST / GET_COLLECTION / RESET
  REQUEST calls studentModule.app.handle(req) directly — no real socket
```

### Execution flow, per submission

1. Fetch the two shim source files and the student's source as plain text.
2. `esbuild.build()` bundles them together entirely in the browser (no install step).
3. Post the bundled code string to a fresh Worker; the worker evaluates it with
   indirect `eval`, which (because of how `var` + IIFE globals work) attaches the
   result to the worker's own global scope.
4. The harness talks to the worker over `postMessage`: seed data by calling the
   model's `.create()` directly (bypassing the student's own routes), then simulate
   each test request by constructing a plain `{method, path, query, body, headers}`
   object and calling `app.handle(req)` — our `express-lite` dispatcher runs the full
   middleware/router chain in-process and resolves to a `{status, body}` result.
5. `reset()` re-sends the *same* bundled code to `LOAD` again — re-evaluating it
   creates brand-new shim closures (fresh `collections` Map, fresh module state),
   which is the entire reset mechanism; no explicit "clear the DB" step needed.

### What's real vs. shimmed

| Layer | Real or shimmed |
|---|---|
| JS execution | Real (student's own code runs as actual JS, unmodified logic) |
| Express | **Shimmed** (`express-lite.js`: app/router, verbs, params, nested router
  mounting at arbitrary depth, router-scoped middleware, async handlers, 4-arg error
  middleware) |
| Mongoose / database | **Shimmed** (`mongoose-lite.js`: Schema/model, CRUD, query
  operators, update operators, `.populate()` for stored `ref` fields, in-memory Map store) |
| Network transport | **None** — in-process function call, no sockets at all |

### Known limitations (measured, not theoretical)

- Compatibility is whatever we've explicitly built: embedded sub-documents,
  virtuals, schema statics/methods, real `ObjectId`, and "virtual populate" (the
  reverse side of a relationship) are not implemented.
- Any student code that imports a real third-party npm package beyond
  Express/Mongoose-shaped code has nothing to resolve to.
- No per-submission execution timeout is enforced yet (an infinite loop in student
  code would hang that one Worker indefinitely).
- A thrown/rejected handler error is always caught and turned into a clean 500 by
  the dispatcher — this is *more* forgiving than real Express 4, which is worth
  knowing when comparing crash behavior against Solution A.

### Measured headline numbers

- ~12 ms warm bundle time (after the first page load), <0.3 ms per test case.
- 50 submissions run in parallel, in one browser tab, in 422 ms total, zero failures.
- $0 marginal cost, zero external account/network dependency at grading time.
