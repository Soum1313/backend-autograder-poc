# Extended Comparison — Cost, Performance, Authoring, Integration, System Requirements, Coverage

This extends `docs/comparison-report.md` with six dimensions not covered there, now that
Solution A has also been run against the harder Blog API (nested routers, auth
middleware, populate) — the same stress test Solution B was already run against. Both
now pass 16/16 on it. All numbers below are measured live in this POC, not estimated.

## 0. The Blog API run on Solution A (new this round)

Real Express + real Node handled the harder problem correctly once two real bugs were
found and fixed:

- A stale browser-cached copy of `mongoose-lite-node.js` (missing `.populate()`, added
  for Solution B earlier but never ported to Solution A's copy of the shim) was being
  served by the dev static server across edits. Fixed by porting the same `populate()`/
  `SingleQuery`/`modelsByName` additions to `mongoose-lite-node.js`, and by adding
  `cache: "no-store"` to every pod-file/shim fetch in both solutions' harnesses - this
  had silently bitten testing more than once by this point.
- A latent bug in `__resetAll()`: it cleared the *registry* of collections
  (`collections.clear()`) instead of emptying each collection's `Map` in place. Since
  Solution A's Model classes are created once at `require()` time and their closures hold
  direct references to the original `Map` objects, clearing the registry orphaned the old
  (still-populated) Maps instead of actually resetting them. Invisible in every earlier
  test because `reset()` was always called before any data existed yet; would have broken
  silently the moment a pod was reused across more than one reset cycle. Fixed to clear
  each Map's contents instead.

After both fixes: **16/16 passed**, confirmed in a clean single-pod browser tab.

## 1. Cost efficiency

| | Solution A (BrowserPod) | Solution B (custom adapter) |
|---|---|---|
| 3rd-party payment | **None required**, confirmed live on the free fetch network. BrowserPod Edge (optional, only needed for Portals/real TCP, neither used here) is metered at 10 tokens ($0.01)/connected-hour with 1,000 free hours/month - not needed for this problem bank's requirements. | None. |
| Runtime expense | $0 - all compute is client-side, in the student's/grader's own browser tab. The only real network traffic is `npm install` hitting the public npm registry directly (free, no cost to us). | $0 - all compute is client-side. No network traffic at grading time once the bundler script is cached. |
| CDN / delivery cost | The BrowserPod SDK + WASM runtime **must** load from BrowserPod's own CDN (`rt.browserpod.io`) under the free Community Licence - self-hosting or mirroring it onto our own S3/CloudFront requires a paid **Enterprise Licence**. So there's no S3 option here even if we wanted one; the CDN cost (free to us) is a given, not a choice. Also requires a visible "Powered by BrowserPod" credit on the page. | `esbuild-wasm` loads from a public CDN (esm.sh) today, but it's MIT-licensed open source with no such restriction - **we could mirror the handful of static JS/Wasm files onto our own S3+CloudFront** for a few cents/month at any realistic scale, removing the third-party CDN dependency entirely if we ever wanted tighter control or to stop depending on esm.sh's uptime. No attribution requirement either way. |
| Hidden costs | Engineering time dealing with real, measured instability (see Performance below - boot times ranging 17-50s, and one outright hang reproduced live when 3 Pods shared one browser tab). | Engineering time extending the shim's Express/Mongoose coverage as the problem bank grows (see Coverage below) - a known, bounded, self-inflicted cost rather than an external one. |

**Bottom line: both are $0 today.** The real difference isn't price, it's *control* over
the delivery path - Solution B can be fully self-hosted if we ever want that; Solution A's
free tier is free specifically because we accept BrowserPod's CDN and branding terms.

## 2. Performance

### Initial setup (cold boot, per submission)

| | Solution A (free tier) | Solution B |
|---|---|---|
| Observed range across runs | **17.1 s – 50 s** (`npm install` alone varied this much across otherwise-identical runs - see the variance note below) | **0.2 s – 0.8 s** cold (first bundle on a fresh page load, includes initializing esbuild-wasm); **~12 ms** warm (same page, next bundle) |

**A real reliability finding, not just a speed one:** running three Pods in one browser
tab (from earlier testing) and, separately, re-booting a second/third Pod in the same
tab during this round's testing, both reproduced an outright **hang** - `npm install`
or a grading call simply never completing, no error thrown, nothing to catch. Moving to
a fresh, single-Pod-per-tab browser tab fixed it every time. This POC cannot recommend
running more than one BrowserPod Pod per browser tab; a production deployment would need
one real tab per student (which happens to match BrowserPod's own intended usage model),
not a grading page fanning out many Pods itself.

### Runtime refresh (re-grading without a full environment rebuild)

- **Solution A**: no official "restart the process" API exists. This POC's `reset()`
  clears in-memory DB state via a grader route in under a second, but swapping in a
  *different* submission's code still means writing a new file and restarting
  `node server.js` - not measured as a separate fast path in this POC, but in principle
  cheaper than a full reboot since `npm install` wouldn't need to re-run for the same
  problem (express is already installed).
- **Solution B**: `reset()` re-evaluates the *same* bundle fresh (new module/collection
  instances) in low single-digit milliseconds. Loading a genuinely different
  submission's code is a fresh bundle, ~12 ms warm.

### Test-case execution

| | Solution A (free tier) | Solution B |
|---|---|---|
| Todo API (14 cases) | 871 ms/case avg | <0.3 ms/case |
| Blog API (16 cases) | **2,454 ms/case avg** (39.3 s total) - notably higher than the Todo API's per-case average in the same tier, consistent with the overall variance observed, not a fixed per-request cost | ~1 ms/case avg (16.4 ms total on a cold page) |

Each Solution A grading call spawns a brand-new real `node` process (no persistent
connection to reuse); each Solution B call is a plain in-process function call. That
architectural difference, not problem complexity, is what drives the gap.

## 3. Authoring a problem - how easy?

**Solution A**: a problem author writes **completely normal** Express + Mongoose code,
exactly as they would for a real codebase or tutorial - no list of "forbidden" APIs to
remember, because Express is the real package. The only thing to keep in mind: Mongoose
is still our shim underneath (same feature list as Solution B's - see Coverage), so
advanced Mongoose patterns are still off the table even though Express itself has zero
restrictions. Net: **low authoring friction** for anything Express-shaped, with the same
Mongoose ceiling as Solution B.

**Solution B**: a problem author must stay within the shim's explicit, documented feature
list for *both* Express and Mongoose. Within that list, authoring is just as easy as for
Solution A. The real cost shows up when a problem idea strays outside the list mid-design
- it then becomes a "go extend the shim first" task (hours to days, depending on the
feature) before the problem can ship, rather than something the author can just write and
move on from. This POC's own Todo→Blog extension is a real example of that cost actually
being paid once (nested routers, `populate()`, router-scoped middleware all had to be
built) to unlock a harder problem shape.

## 4. Integration - developer effort

### Short term (getting the harness working at all)

| | Solution A | Solution B |
|---|---|---|
| Lines of harness code (this POC) | ~280 (harness.js + server.js + request-cli.js + mongoose shim) | ~550 (express-lite + mongoose-lite + bundler + worker + harness) |
| Real bugs hit before it worked | 6 total across both build rounds (resizable-ArrayBuffer decode, `Process` not a real Promise, npm pruning a manually-placed `node_modules/mongoose`, Express dispatch-order for grader routes, a stale-cache populate regression, a reset-clearing-the-wrong-thing bug) | 1 (route-matching prefix bug) in the first round, plus 2 more (trailing-slash join, param-aware middleware prefix) extending to the Blog API |
| External dependencies to stand up | A real npm package + COOP/COEP headers + (initially) an account/API key, later removed | None beyond a CDN script tag |

Once built, **adding a new problem to either harness is cheap and problem-agnostic** -
proven directly by the Blog API working through both harnesses unmodified (Solution A's
`server.js`/`request-cli.js` needed zero changes beyond generalizing the already-existing
seed/collection routes to accept a model name).

### Long term (growing a problem bank over months/years)

- **Solution A**: the harness code itself shouldn't need to grow much further - fidelity
  comes for free from using the real runtime. Ongoing cost shifts to **vendor risk**:
  tracking BrowserPod SDK version changes, its pricing/licensing terms, and (not yet
  built) a process-crash/timeout supervision layer, since a single unhandled async error
  in student code can currently take down an entire grading run (documented in
  `docs/solution-a-architecture.md`).
- **Solution B**: the harness also stays stable, but the **shim's own coverage has to
  grow** as the problem bank diversifies - every genuinely new Express/Mongoose pattern a
  future problem needs is additional, cumulative, self-maintained code. Fully within our
  control, but it is real and it compounds with problem-bank breadth.

**Net tradeoff**: Solution A trades long-term *code* maintenance for long-term *vendor*
dependency; Solution B trades vendor independence for accumulating, owned maintenance
debt as problems diversify.

## 5. Client-side system requirements

| | Solution A (BrowserPod) | Solution B (custom adapter) |
|---|---|---|
| Browser APIs needed | `SharedArrayBuffer` (requires **cross-origin isolation** - COOP/COEP response headers on the *hosting* page, a real deployment requirement on our side), WebAssembly | Web Workers, WebAssembly - no cross-origin isolation needed; this POC's plain `python3 -m http.server` (no special headers at all) served it correctly throughout |
| Browser support | BrowserPod's own FAQ: works on all major browsers, but **"works best in Chromium-based browsers"**; Firefox and Safari have documented limitations | No special browser requirements beyond standard Worker/Wasm support, which is universal across current browsers |
| Device class | Boots a **full Linux-like microVM + real Node.js runtime** in WASM - categorically heavier on memory/CPU than a JS Worker (not precisely measured here, but a full OS+runtime image vs. a handful of JS closures is not a close comparison). Likely needs a reasonably modern desktop/laptop; the "real Linux kernel in the browser" design point suggests desktop-class hardware is the implicit target, not low-end or older mobile devices. | A single esbuild-wasm compile call plus an in-memory `Map`-based store inside one Worker - lightweight enough to expect it to run fine on budget laptops, Chromebooks, and most phones. |
| Network at grading time | **Required every cold boot** (`npm install` against the real npm registry, even on the free tier) | **None**, once the bundler script is cached by the browser - grading itself is fully offline-capable after first load |

## 6. Coverage - what each solution can and cannot grade today

Both solutions share one structural ceiling: **neither can offer real MongoDB fidelity**.
`mongodb-memory-server`'s native binary is explicitly unsupported inside a BrowserPod Pod,
and a real remote MongoDB is out of scope for both per this project's own "no shared DB
for 400 concurrent students" constraint. So Mongoose-depth limitations below apply
**identically to both** solutions - the only coverage difference that actually exists
between them is on the **Express/Node-ecosystem** side, where Solution A is real and
Solution B is a shim.

### Solution A (real Express + real Node, shimmed Mongoose) - CAN author

- Anything Express-shaped with **zero restrictions** - arbitrary middleware nesting,
  any routing pattern, any real third-party npm package that doesn't need a remote
  network call to complete (bcrypt, jsonwebtoken, multer, cors, helmet, joi/zod,
  socket.io as a library, etc.) - it's the real npm registry, not a curated subset.
- Real file-system operations inside the Pod's own virtual FS.
- Real multi-file/multi-module project submissions (not just one script).
- Real background timers/process-lifecycle code.
- Shell/CLI-flavored tasks (bash, git are present in the Pod) - a category Solution B
  cannot touch at all.
- Rust/C++ programs compiled for BrowserPod's target (mentioned in its own docs) - a
  whole separate problem category outside this POC's scope but technically available.
- Any Mongoose feature this shim already supports (see the shared list below).

### Solution A - CANNOT author (or needs real new infra first)

- Anything needing a **real remote database connection** (no TCP without paid Edge plus
  an allow-listed domain, and out of scope regardless per the "no shared DB" constraint).
- Anything needing a **real native binary not already compiled for BrowserPod's WASM
  target** (e.g. `sharp`, `canvas`, many native addons) - explicitly unsupported per
  BrowserPod's own docs.
- Anything needing **real inbound networking from a genuine external caller** into the
  student's server (no public URL without Edge/Portal, deliberately avoided here).
- Problems whose pedagogy depends on **fast, tight feedback loops** (sub-second re-runs,
  live-as-you-type checking) - currently impractical given 17-50 s cold boots and
  multi-second per-request variance, without first building process-reuse/batching
  optimizations this POC identified but didn't implement.
- Anything past this shim's current Mongoose ceiling (next section - shared with B).

### Solution B (shimmed Express + shimmed Mongoose) - CAN author

- Anything within the documented Express-lite feature set: arbitrarily nested routers,
  router-scoped and global middleware, async handlers, `req.params/query/headers/body`,
  4-arg error middleware, `res.status/json/send/sendStatus/end`.
- Anything within the documented Mongoose-lite feature set: `Schema`/`model`, full CRUD,
  the 7 supported query operators, the 5 supported update operators, `.populate()` for a
  stored `ref` field (single or array), query chaining (`sort/skip/limit/select/lean`).
- Any additional **pure-JS npm package with no Node-built-in dependency** (lodash, uuid,
  zod/joi, date libraries, a modern Web-Crypto-based JWT library like `jose`) - via the
  CDN-passthrough resolver widening identified as the natural next step (not yet built in
  this POC).
- Problems that benefit from **near-instant feedback** (sub-millisecond to low-single-digit-ms
  grading) - the natural fit for large-scale, high-frequency test runs.

### Solution B - CANNOT author (or needs real new engineering first)

- Embedded/nested Mongoose sub-documents, virtuals, schema statics/methods,
  discriminators, transactions, the aggregation pipeline, real `ObjectId` semantics,
  "virtual populate" (the reverse side of a relationship without a stored ref) - all
  individually shimmable with more work, none built yet.
- Any **Node-only library whose core behavior depends on a real native binding or a
  Node built-in with no browser-safe equivalent** - e.g. real `bcrypt` (native), real
  `jsonwebtoken` (uses Node's `crypto` module directly; untested in this POC but flagged
  as a likely failure via simple CDN passthrough), `sharp`, native DB drivers.
- Real filesystem access, real multi-process behavior, real multi-file project structure
  beyond what the virtual bundle can represent.
- Any task requiring a **real external network call to a third party that must actually
  succeed** - permanently blocked by browser CORS, not a "not built yet" gap, unless a
  request-interception/mocking layer is built (identified, not built).
- Any problem whose entire point is **authenticity** - "write real backend code the way
  you'd deploy it" - Solution B cannot honestly claim this no matter how much shim code
  is added; Solution A is the only one of the two that can.

### Shared ceiling (applies to both, equally)

Embedded sub-documents, virtuals, schema statics/methods, discriminators, transactions,
aggregation pipeline, real `ObjectId`, virtual/reverse populate, and anything requiring a
real remote MongoDB - all blocked for the same underlying reason (no real Mongo reachable,
no native `mongod` binary allowed inside a Pod), regardless of which solution is used.
