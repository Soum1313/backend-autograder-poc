# Solution A — BrowserPod Real Node.js Runtime

## Status: working, tested, **and rebuilt once already** - v1 used a paid-tier API key;
v2 (current) runs entirely free, with no API key and no account, confirmed live.

## Actual package/API (confirmed from https://browserpod.io/docs, not assumed)

- npm package: `@leaningtech/browserpod`, current published version `4.1.0` (not `0.1` -
  guessed wrong on the first try, confirmed via the npm registry directly).
- `BrowserPod.boot({ apiKey })` boots a real, unmodified Node.js 22 build (compiled to
  WASM, run as a Linux-like microVM) inside the browser tab. Without an API key it boots
  on a free "**fetch network**" (CORS-limited, no Portals, no TCP besides HTTP/HTTPS/WebSocket).
  With a key it boots on **BrowserPod Edge** - the only metered part (10 tokens/connected-hour,
  1,000 free hours/month; compute itself is never metered either way).
- The page must be served with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` (needed for `SharedArrayBuffer`); plain
  HTTP is fine on localhost. Implemented as `serve-coop.py`, a ~25-line Python
  `http.server` subclass, since the project's own static file servers don't set these.
  This applies on both the free and paid network modes.
- Licensing requires a visible "Powered by BrowserPod" credit linking to browserpod.io
  unless on a paid Edge Pro plan - added to `index.html`'s footer. This applies even on
  the free tier.

## v1 → v2: dropping the API key entirely

The original build (v1) used `BrowserPod.boot({ apiKey })` and a BrowserPod Edge **Portal**
(a public HTTPS URL for the Pod's Express server) so the host page could `fetch()` into
it directly, real cross-origin HTTP. That needed an account, an API key, and metered
Edge connected-hours.

Per BrowserPod's own docs (`understanding-browserpod/networking`), the only thing that
actually needs real networking for this POC is `npm install` - there's no remote MongoDB,
no other external call. Two things made dropping the API key possible:

1. **`BrowserPod.createFetchNetwork({ fetch: BrowserPod.opinionatedFetch })`** - a
   preconfigured fetch handler that specifically makes `npm install` work on the free
   network, where a plain `npm install` would otherwise fail (npm sends headers the
   registry doesn't accept over a vanilla browser `fetch()`).
2. **Programs inside a Pod reach each other on `localhost` regardless of network type**
   (same doc). Since nothing outside the Pod needs to reach the Pod's server anymore,
   Portals (Edge-only) are unnecessary - the student's Express server and our grading
   calls can both live *inside* the same Pod and talk over plain loopback HTTP.

That second point is what actually replaces the Portal: instead of the host page
`fetch()`-ing a public URL, a **tiny one-shot `node request-cli.js <method> <path> <body> <headers>`
process** (spawned per grading call via `pod.run()`) makes the loopback HTTP call from
*inside* the Pod and prints the result as a single delimited line
(`##RESP##{...}`) to stdout, which the host page picks up from the terminal's
`onOutput` buffer. This sidesteps a real, separate problem noted in the original build -
`Terminal.write()` sends output *display* text only and documented nowhere does BrowserPod
expose a way to feed a *running* process new stdin from the host page - by never needing
to send input to a long-running process at all. Each grading call is its own fresh,
argv-driven process instead.

## Why `mongodb-memory-server` was ruled out without attempting it

BrowserPod's own docs list, under "What BrowserPod supports": **"Not supported:
Prebuilt native binaries from npm packages; use Wasm alternatives."**
`mongodb-memory-server` downloads a real, prebuilt native `mongod` binary - exactly what's
explicitly unsupported. This was confirmed from the documentation itself, so no time was
spent actually attempting it (per the brief's own instruction not to fight this). Real
`mongoose` was therefore never going to have anything to connect to inside a Pod; the
Mongoose layer in Solution A is the **same kind of in-memory JS shim** as Solution B's
(`pod-files/mongoose-lite-node.js`, logically identical to `solution-b/shims/mongoose-lite.js`,
written as a real `node_modules/mongoose` package inside the Pod's filesystem so
`require("mongoose")` resolves to it transparently).

This means the "real Mongoose" differentiator this comparison expected going in **does
not actually exist** - neither solution can offer real Mongoose/MongoDB fidelity, for the
same underlying reason (no real DB reachable, no native binary allowed). The genuine,
surviving fidelity difference is **real Express**, not real Mongoose.

## Architecture (as built, not just planned - current, v2)

```
reference-solution.js (same unmodified file as Solution B)
        |
        v
pod-files/server.js (outer Express app, written by us, not the student)
  - mounts the student's app as middleware: outer.use(studentApp)
  - adds /__grader/seed, /__grader/collection/:name, /__grader/reset
  - no CORS needed anymore - nothing outside the Pod calls this directly
        |
        v
BrowserPod Pod (free fetch network, no API key, no account - real Node.js 22,
                real npm-installed express@4.19.2 via opinionatedFetch,
                node_modules/mongoose = our JS shim)
        |
        v  app.listen(4000)  (plain loopback, no Portal)
        |
        |  pod-files/request-cli.js - a fresh one-shot `node` process per
        |  grading call, making a real http.request() to localhost:4000 and
        |  printing "##RESP##{...}" to stdout
        v
harness.js (main thread) - GraderRuntime implementation: pod.run("node",
["request-cli.js", ...]) per request/seed/reset/getCollectionState call,
reading the result back out of the terminal's captured stdout
```

v1 (superseded) used `BrowserPod.boot({ apiKey })` + a Portal (public HTTPS URL) so the
host page could `fetch()` straight into the Pod's server, which needed an account, an
API key, and CORS headers on the server. Kept below for the record since the bugs found
building it are still real findings about the SDK.

## Bugs found and fixed during testing (none hypothetical - all hit live)

1. **`TextDecoder.decode()` threw on every single `onOutput` callback**: `"The
   provided ArrayBuffer value must not be resizable."` BrowserPod hands the terminal
   output callback a `Uint8Array` backed by a *resizable* `ArrayBuffer`, which
   `TextDecoder.decode()` rejects outright in this browser. This silently ate 100% of
   the pod's terminal output (we saw nothing printed, and wrongly assumed `npm install`
   was hanging for 30+ seconds when it was actually running fine). Fixed by copying into
   a plain buffer first: `decoder.decode(new Uint8Array(buf))`.

2. **(v1 only, no longer applicable) CORS blocked every real request to the Portal URL**:
   `Access to fetch at 'https://...-4000.browserportal.io/...' ... blocked by CORS policy:
   No 'Access-Control-Allow-Origin' header`. The student's Express app (correctly) doesn't
   add CORS headers - there's no reason a backend-only submission should. Our first fix
   attempt (`app.use(express.json())` + routes appended *after* `require()`-ing the
   student's app) didn't work: Express's dispatcher stops at the first **matching route**,
   so anything appended after the student's own router never runs for the student's own
   routes (only our own later `/__grader/*` paths would ever see it). Fixed (in v1) by
   wrapping the student app in an **outer** Express app
   (`outer.use(corsMiddleware); outer.use(studentApp)`). **v2 has no CORS problem at all**
   - once grading moved to loopback HTTP from a process inside the same Pod, there's no
   cross-origin boundary left to cross. The outer-app-wrapping *pattern* (mounting the
   student's app as middleware under our own grader routes) is still used in v2's
   `server.js`, just without the CORS middleware - the Express dispatch-order lesson
   (bug learned here) still applies to where `/__grader/*` routes have to sit.

3. **`this.pod.run(...).catch is not a function`**: `Process` (the object returned by
   `pod.run`) is *thenable* but not a real `Promise` - it has no `.catch`. Our
   fire-and-forget "watch the long-running server process for a crash" code needed
   `Promise.resolve(pod.run(...)).catch(...)` instead.

4. **npm install silently deletes a manually-placed `node_modules/mongoose`
   folder**: writing our mongoose shim into `node_modules/mongoose` *before* running
   `npm install` resulted in `npm install` reporting `"added 68 packages, and **removed 1
   package**"` - it treats anything in `node_modules` that isn't declared in
   `package.json` as extraneous and prunes it, even on a plain `npm install` with no
   other flags. Fixed by writing the shim files *after* `npm install` finishes, not before.

5. **(found extending to the Blog API) The dev static server serving pod-files has no
   cache-control headers, and the browser repeatedly served a stale, pre-edit copy of
   `mongoose-lite-node.js` across code changes** - concretely, an old copy missing
   `.populate()` got fetched into a freshly-booted Pod, producing
   `"Post.findById(...).populate is not a function"` even though the file on disk was
   already fixed. Fixed by adding `cache: "no-store"` to every `fetch()` of a pod-file or
   shim in `harness.js` (and the matching fetches in `app.js`, and the equivalent ones in
   Solution B's `harness.js`/`app.js` too, since the same risk exists there). This is a
   dev-server artifact, not a BrowserPod issue, but it cost real debugging time twice.

6. **`__resetAll()` cleared the wrong thing.** It called `collections.clear()` -
   clearing the *registry* that maps collection names to their `Map` objects - instead of
   emptying each existing `Map`'s contents. Since Model classes are created once at
   `require()` time and their closures hold a direct reference to the original `Map`
   object (not a lookup through the registry each time), clearing the registry just
   orphaned the old, still-populated Maps without actually resetting them. This was
   invisible in every earlier test because `reset()` was always the very first call, on
   data that didn't exist yet - it would only have surfaced the moment a Pod was reused
   for a second reset cycle with real data already in it. Fixed to iterate
   `collections.values()` and call `.clear()` on each Map instead.

## A real, unresolved finding: one unhandled async error can crash the whole Pod process

*(Found under v1; not re-run under v2, but this is Node/Express-level behavior,
independent of which network the Pod boots on, so there's no reason to expect it
differs.)*

Running the same deliberately-buggy `broken-no-validation.js` submission (used against
Solution B, where it scored 6/14) against Solution A scored **1/14**: the very first
request that hit the bug (`POST /todos` with no `title`, which the shim's required-field
check throws for) is **not wrapped in try/catch** in that submission, and Express 4 does
not auto-catch a rejected promise returned from an async handler. The resulting unhandled
rejection **crashed the whole Node process**, and every subsequent request failed outright
with "Failed to fetch" (connection refused - the server was gone), not an HTTP error
response.

This is a genuine, structural difference, not a bug in this POC's own code:

- **Solution B's `express-lite` dispatcher explicitly wraps every handler call and
  routes a thrown/rejected error into `next(err)`** - a buggy request degrades to a
  500 for that one request; the worker (and every other in-flight/future request)
  survives.
- **Real Express 4 + real Node has no such net by default.** One submission's single
  unhandled async bug doesn't just fail one test case, it can take down every
  remaining test case for that same student in that same grading run.

This wasn't "fixed" in this POC (e.g. by adding our own `process.on("uncaughtException")`
safety net in `server.js`) because it's more valuable here as evidence: **a production
version of Solution A would need an explicit process-supervision/crash-isolation layer
(e.g. Express 5's built-in async error handling, or a watchdog that detects a dead Pod
process and reports a clean "submission crashed the server" verdict instead of a wall
of misleading "connection failed" test results)**. That's real, non-trivial additional
engineering Solution A needs that Solution B structurally doesn't.

## Concurrency: not demonstrated to work within one browser tab

*(Also found under v1; not re-run under v2 - free-network concurrency across several
Pods in one tab remains an open question either way.)*

A deliberate attempt to boot **3 Pods concurrently in the same browser tab** (mirroring
the 50-parallel-worker test that succeeded cleanly for Solution B) produced CORS
failures on some requests and one boot that never resolved, timing out the test
harness itself after 45 seconds. This was not root-caused further (per the brief's own
time-boxing instruction) - it is reported here as exactly what it is: **this POC did
not establish that multiple real Node/BrowserPod Pods can be run concurrently and
reliably within a single browser tab**, in contrast to Solution B's measured, clean
10/25/50-parallel-worker results. A production deployment of Solution A would most
likely need one Pod per browser tab (i.e., truly one real student's own device/tab per
Pod, which is BrowserPod's actual intended usage model) rather than one grading page
fanning out many Pods itself - worth validating explicitly before relying on it.

## Actual measurements (this machine, one successful end-to-end run, reference solution)

| Stage | v1: Edge + API key + Portal | v2: free fetch network, no API key |
|---|---|---|
| SDK import (esm.sh CDN) | 27.4 ms | 31.7 ms |
| `BrowserPod.boot(...)` | 605.0 ms | 449.6 ms |
| `npm install` (express + ~68 transitive packages) | 8,941.7 ms | **33,915.1 ms (~34 s)** |
| Wait for Portal / settle time before first call | 861.4 ms | 500 ms (fixed delay, no Portal to await) |
| **Total boot-to-ready, per submission** | **10,475.2 ms (~10.5 s)** | **34,925.4 ms (~35 s)** |
| 14 test cases | 3,334.5 ms total, 238.2 ms/case avg (real HTTP over Edge/Portal) | **12,199.9 ms total, 871.4 ms/case avg** (one fresh `node` process per request) |

**v2 is free and needs no account, but is ~3.4x slower end-to-end than v1, for two
distinct, now-measured reasons:**

1. **`npm install` is ~3.8x slower on the free network.** The console output shows why:
   `npm` itself calls two audit/advisory endpoints
   (`registry.npmjs.org/-/npm/v1/security/advisories/bulk` and `.../audits/quick`) that
   get flatly CORS-blocked on the fetch network (`opinionatedFetch` doesn't cover every
   npm-internal call, just the registry fetches that matter for resolving packages).
   `npm` retries/backs off on these failures before giving up and continuing - its own
   log line says `added 68 packages in 32s`, i.e. npm's own clock attributes the slowdown
   to exactly this.
2. **Per-request latency is ~3.7x worse because each grading call now boots a brand-new
   real Node.js process** (`pod.run("node", ["request-cli.js", ...])`) instead of reusing
   one already-open HTTP connection to a Portal. Spawning Node itself (even inside an
   already-booted Pod) costs more than one more network round-trip did.

**Variance observed across repeated runs (v2, free tier), including the Blog API extension:**
`npm install` alone ranged from **17.1 s to 50 s** across otherwise-identical runs, and
per-test-case latency ranged from **871 ms/case (Todo API) to 2,454 ms/case (Blog API)**
in the same tier. Separately, running a second or third Pod in the same already-used
browser tab reproduced an outright **hang** (no error, no timeout, just nothing further
happening) more than once; moving to a fresh single-Pod-per-tab browser tab fixed it
every time. The free tier isn't just slower than the paid tier - it's measurably less
predictable, and this POC cannot recommend sharing one browser tab across multiple Pods.

**(2) is a fixable design choice, not a hard limitation.** All 14 test cases' request
paths/bodies are known upfront once the seed step resolves real ids - nothing after that
needs to inspect a previous response before building the next request. Batching every
remaining request into **one** `request-cli.js` invocation (looping over a JSON array of
calls instead of one call per process) would amortize the Node-startup cost across all of
them. This POC's shared `shared-tests/run-cases.js` driver calls `runtime.request()` once
per case and awaits each one before the next, so doing this cleanly means either giving
Solution A's runtime its own batching test-driver, or changing the shared contract - not
done here, but it's the obvious next lever if v2's absolute speed needs to improve.

For comparison, Solution B's equivalent numbers (from its own architecture doc): ~12 ms
warm bundle time, <0.3 ms/test-case, 50 parallel submissions in 422 ms total. Even against
the faster v1 numbers the gap was already roughly four orders of magnitude on
per-submission overhead; against v2's free-tier numbers it's wider still.

## Isolation

- Real Node.js 22 running as its own WASM-virtualized Linux process in a dedicated Web
  Worker internally (per BrowserPod's own architecture docs) - a different, heavier
  isolation boundary than Solution B's single JS Worker, but it is still client-side,
  still running in the grading page's own browser tab, and still has no documented
  resource/timeout limits enforced by us. The crash behavior above shows the opposite of
  over-isolation: a crash in student code can take the *entire* submission's grading
  session down, not just the one offending request.
- Student code gets a real Linux-like environment (npm, bash, git) - meaningfully more
  surface area than Solution B's handful of shimmed globals, which is both the main
  selling point (closer to "real" backend dev) and the main attack surface increase.
