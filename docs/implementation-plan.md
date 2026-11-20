# Implementation Plan — Browser-Based Backend Autograding POC

## Goal

Compare two architectures for grading student-written Express + Mongoose backend
code entirely client-side (no server executes student code), using the same
Todo API problem and the same test suite for both.

- **Solution A** — BrowserPod: a real Node.js runtime, compiled to WASM and
  virtualized in the browser (Leaning Technologies product).
- **Solution B** — our own esbuild-wasm pipeline extended with a minimal
  Express-compatible + Mongoose-compatible adapter, backed by an in-memory JS store.

This is a standalone POC. It lives in `backend-autograder-poc/`, outside both the
`mentorpick-v2-frontend` and `Mentorpick_Backend` repos, and does not import from
or modify either.

## Known constraint carried into both solutions

Browsers (and anything sandboxed in WASM, BrowserPod included) cannot open raw TCP
sockets. Confirmed from BrowserPod's own docs: pods can reach only "essential
services such as npm registries" — i.e. no general outbound networking to an
arbitrary MongoDB host. So **neither solution can talk to a real, remote MongoDB**.
Both need a local/in-memory database substitute. This removes "talks to real
MongoDB" as a differentiator between A and B — the comparison is really about
runtime fidelity (A) vs. engineering control and zero external dependency (B).

## What each solution will build

### Solution A — BrowserPod
- Boot a BrowserPod pod (Node 22) via `BrowserPod.boot()` with the API key.
- Inside the pod: real Express + real Mongoose, student's route/model code as-is.
- Database: real `mongoose` driver needs a Mongo wire-protocol server to talk to.
  Since the pod can't reach a real remote Mongo, first try running `mongodb-memory-server`
  (downloads a real `mongod` binary) *inside* the pod's virtual Linux filesystem —
  this is the one case BrowserPod's "real OS" nature might actually pay off, since
  WebContainers-style approaches can't do this at all. If that's infeasible in the
  time box, fall back to swapping in an in-memory Mongoose-compatible mock
  (`mongodb-memory-server` → if that fails, try a lightweight pure-JS mock mongoose
  driver) and document why.
- Harness (running in the host page, outside the pod) sends HTTP requests into the
  pod's exposed port, reads responses, and can shell into the pod to inspect/reset
  in-memory data between tests.

### Solution B — custom adapter on our esbuild-wasm pipeline
- Virtual file map + esbuild-wasm bundles the student's Express-style route file(s)
  against our own `express-lite` and `mongoose-lite` shim modules (bare imports
  `express`/`mongoose` resolved to local shim files instead of esm.sh).
- `express-lite`: app/router, verbs, middleware chain with `next()`, `req.params/query/body`,
  `res.status/json/send`.
- `mongoose-lite`: `Schema`, `model()`, document CRUD, query methods/chaining listed
  in the spec, `$gt/$gte/$lt/$lte/$ne/$in/$nin/$exists`, `$set/$unset/$inc/$push/$pull`.
- Backing store: a plain in-memory JS Map-based collection store, synchronous,
  deterministic IDs, explicit `resetDatabase()`.
- Harness calls the bundled app's exported request-handling function directly
  (no real HTTP socket needed — we simulate a `Request`/`Response` pair in-process),
  inside a Web Worker for isolation from the host page.

## Shared test harness contract

Both solutions expose the same minimal interface so `shared-tests/` can drive both:

```ts
interface GraderRuntime {
  loadStudentCode(code: string): Promise<void>
  seed(docs: any[]): Promise<void>
  request(method: string, path: string, body?: any): Promise<{ status: number; body: any }>
  getCollectionState(name: string): Promise<any[]>
  reset(): Promise<void>
  dispose(): Promise<void>
}
```

`shared-tests/todo-api.test.json` — the Todo CRUD test cases (same list for both) —
is data, consumed by a tiny runner in each solution's own test script (kept separate
since A's runner talks over the pod boundary and B's runs in-process; sharing the
*test case definitions*, not the runner code, is what keeps the comparison fair).

## Dependencies

- Solution A: `@browserpod/sdk` (or whatever the actual npm package name turns out
  to be — confirmed at implementation time), API key from `.env` (gitignored, never
  committed, never printed).
- Solution B: `esbuild-wasm` only (already proven in the main project). No other
  runtime dependency.
- Both: a plain static file server to host the POC page (e.g. `vite` or `http-server`)
  and the Claude Browser pane for manual verification — no Docker, no real DB.

## Execution flow (manual, in the Browser pane)

1. Open `solution-a/index.html` or `solution-b/index.html`.
2. Pick a student submission file (from `shared-tests/submissions/`).
3. Click "Run tests" → runner executes the shared Todo-API cases against the loaded runtime.
4. Results + timings rendered on the page and logged to console; copied into the
   comparison report.

## Explicitly excluded from this POC

- No Docker/Kubernetes, no real MongoDB server, no Atlas, no shared/multi-user deployment.
- No production-grade security hardening (we assess and document risks, not fix them all).
- No support for npm packages beyond the two shims being built (e.g. no arbitrary
  third-party middleware).
- No load test simulating real concurrent 400 students — only small-scale timing
  experiments (10/25/50 sequential or parallel runs) to spot obvious bottlenecks.
- No changes to `Mentorpick_Backend` or `mentorpick-v2-frontend`.

## Risks / open questions going in

- Exact BrowserPod SDK surface (package name, `boot()` signature, how a pod's
  internal port is exposed to the host page) is unconfirmed until we actually
  install it — plan assumes it needs adjustment once we see the real API.
- Whether `mongodb-memory-server`'s real `mongod` binary can run inside a
  BrowserPod pod at all (CPU arch / binary format match) is unknown — this is the
  single biggest unknown for Solution A and the most likely place we hit a
  documented blocker instead of a working demo.
