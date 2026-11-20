# Comparison Report — Browser-Based Backend Autograding POC

Both solutions were actually implemented and run against the identical Todo API
student submission and the identical 14-case test suite (`shared-tests/`), not just
designed on paper. See `docs/solution-a-architecture.md` and
`docs/solution-b-architecture.md` for the full build logs, bugs hit, and fixes.

## Headline result up front, with the caveat that matters most

**Solution B (custom Express/Mongoose adapter on esbuild-wasm) is the clear choice
for this use case.** Not because Solution A "used a real runtime" (that was not
treated as automatically better) and not because B is "more lightweight" (that was
not treated as automatically better either) - but because, once both were actually
built and measured, A turned out to deliver almost none of the fidelity advantage
this comparison expected, at a cost of roughly three to four orders of magnitude in
per-submission latency, a real process-crash risk that can silently wipe out an
entire grading run, and an unresolved question about whether it can even run
multiple submissions concurrently in one browser tab. **Solution A was also rebuilt
once already in this POC**, after confirming it can run entirely free (no API key,
no account - see `docs/solution-a-architecture.md`), which removes the "locked into a
paid vendor" objection but makes it noticeably *slower* than the version that did use
a paid API key, not faster or cheaper in a way that changes the conclusion. The one
fidelity advantage Solution A keeps - real Express - does not currently seem worth
that price for a Todo-CRUD-shaped problem bank.

## Comparison table

| Criteria | Solution A: BrowserPod | Solution B: Custom Adapter |
|---|---|---|
| Setup complexity | Moderate: real npm package, COOP/COEP headers, **no account or API key needed** (confirmed live - see below), 4 distinct bugs hit before it worked end-to-end | Low: no account, no API key, no npm install for the page itself (esbuild-wasm from a CDN); 1 bug hit (route-matching) |
| Implementation effort (this POC) | ~250 lines (harness.js + server.js + request-cli.js + mongoose shim + COOP server) | ~550 lines (express-lite + mongoose-lite + bundler + worker + harness) - more code, but all of it is ours, none of it a black box |
| Runtime startup (cold, per submission) | **10,475 ms with an API key (Edge); 34,925 ms (~35 s) free, no API key** - both measured live; the free tier is slower because `npm install`'s own audit/advisory calls get CORS-blocked and retried | 793 ms cold (esbuild-wasm init), 228 ms on a fresh page after that, **12 ms warm** |
| Subsequent execution speed (per test case) | **238 ms/case with an API key** (real HTTP through an Edge Portal); **871 ms/case free, no API key** (a fresh `node` process per request, instead of one open connection - see below) | **<0.3 ms/case** (in-process function call) |
| Memory usage | Not directly measured (full Linux/Node WASM VM per Pod - categorically heavier than a JS Worker; not quantified in this POC) | Not directly measured, but one dedicated Worker per submission, no VM/kernel layer |
| Dependency loading | Real `npm install` of express + ~68 transitive packages: ~9 s with an API key, **~34 s free** (same packages, slower only because of CORS-blocked audit calls retrying on the free network) | esbuild-wasm itself loads once per page (CDN), then every bundle reuses the already-initialized instance (~12 ms) |
| Express compatibility | **Full - the real package.** No gaps, by construction. | Partial, by design: core app/router/middleware (including arbitrarily nested routers and router-scoped middleware, added and verified after this report was first written)/params/async handlers work; anything beyond the documented subset doesn't |
| Mongoose compatibility | **Also a shim, not the real package** - `mongodb-memory-server`'s native binary is explicitly unsupported by BrowserPod, so Mongoose ends up logically identical to Solution B's | Shim, same documented subset as Solution A ended up needing anyway |
| Database implementation | In-memory JS Map-based store (same approach as B, just running inside real Node instead of a Worker) | In-memory JS Map-based store inside a Worker |
| Database isolation | One Pod (one full process) per submission; reset currently done via an `/__grader/reset` route, not process restart (no documented pod-kill API) | One Worker per submission; reset re-evaluates the bundle, giving a fresh module/collections instance |
| Test determinism | Yes when the server survives - but see the crash finding below: a single unhandled async error silently voids every later test case in that run | Yes - every failure was a clean pass/fail, including deliberately-broken submissions (6/14, not a false pass or a crash) |
| Hidden test integration | Same approach as B would need (extra routes/requests); no backdoor into the student's process beyond HTTP | Direct in-process call into the store, bypassing student routes entirely - simpler and can't be spoofed by a student intercepting HTTP |
| Student experience | Closest to a real backend dev environment (real npm, real Express errors/stack traces) | Express/Mongoose-shaped, but shim error messages and the unsupported-pattern list are a real surface for student confusion |
| Debugging experience | Real Node stack traces survived the one crash we triggered and were readable in the captured terminal output | Readable: esbuild gives clean bundle-error messages (verified: a deliberate syntax error produced a clear, single-line error, no crash) |
| Maintenance burden | Low *application* code to maintain, but a hard external dependency: a commercial SDK (even though compute itself is free, Edge/Portal is a vendor service we don't control) | All ~550 lines are ours to maintain; the compatibility-gap list grows as problems grow more complex, and only we can grow it |
| Scalability for 400 students | **Unresolved and concerning**: 11–35 s/submission boot (depending on tier) + unproven concurrent-Pod behavior in one tab (3-parallel boot attempt hung/CORS-failed in this POC) | **Measured and strong**: 50 submissions in parallel in 422 ms in one tab, zero failures |
| Network dependency | **None, confirmed live** - the free tier needs no account, API key, or Edge/Portal at all; `npm install` is the only real network call, made possible on the free tier via `BrowserPod.opinionatedFetch` | Zero network dependency at grading time (esbuild-wasm itself needs one CDN fetch, once, cacheable) |
| Security/isolation concerns | Full Linux-like environment increases attack surface; one submission's bug can crash the whole Pod process, affecting that whole grading run, not just one test case | Narrower surface (a handful of shimmed JS globals in a Worker); a thrown/rejected handler error is always caught per-request, never kills the Worker; neither solution enforces timeouts or blocks `fetch`/`WebSocket` today |
| Cost | **$0 is genuinely viable** (confirmed live, no API key) - Edge remains available and metered (10 tokens/connected-hour, 1,000 free hours/month) only if Portals/real TCP are ever needed, but this POC's requirements (npm install, loopback-only networking) don't need it | **$0, no vendor dependency** beyond a one-time CDN fetch of esbuild-wasm |
| Long-term flexibility | Tied to BrowserPod's roadmap either way (Community Licence requires a visible attribution link even on the free tier); no longer tied to its *pricing*, since the free tier is sufficient for this use case | Fully owned; every constraint is one we chose and can change ourselves |

## Answers to the required questions

**1. Which solution would you choose for our current educational autograding use
case?** Solution B.

**2. Why?** Once actually measured, Solution A's supposed fidelity advantage mostly
evaporates (Mongoose is a shim either way - BrowserPod explicitly can't run
`mongodb-memory-server`'s native binary), and its cost advantage doesn't hold up either:
confirming Solution A can run for free (no API key, no account) was a genuine positive
finding, but it made the solution *slower* (~35 s boot and ~871 ms/request vs ~10.5 s and
~238 ms with a paid API key), not cheaper-and-equally-fast. Either way, the latency gap
against Solution B (~0.01 s boot, <0.3 ms/request) is three to four orders of magnitude,
and Solution A still has a crash mode that can wipe out an entire grading run from one
unhandled async bug in a student's own code (something Solution B's dispatcher
structurally cannot do). For simple CRUD-shaped Express/Mongoose problems - exactly what
this problem bank targets - the extra fidelity of a real runtime wasn't worth what it
cost in this POC, on either tier.

**3. What are the biggest advantages of [Solution B]?** Zero marginal cost per
submission, no external account/vendor/network dependency at grading time, measured
clean scaling to 50 concurrent submissions in under half a second, and every failure
mode observed in testing was a clean, honest pass/fail (no crash, no silent false
pass).

**4. What are its biggest drawbacks?** It is a hand-maintained compatibility layer:
every Express/Mongoose pattern it doesn't yet support is a problem we have to notice
and add, and it already has a documented list of unsupported patterns (embedded
sub-documents, virtuals, schema statics/methods, "virtual populate" of the reverse
side of a relationship, real `ObjectId`, and anything using a real third-party npm
package beyond Express/Mongoose shapes). Note: multi-level router nesting and
`populate()` of a stored ref field were originally on this list when the POC was
first evaluated, but were added in a follow-up extension pass (see
`docs/solution-b-architecture.md`) and are no longer gaps.

**5. What capabilities are we sacrificing by choosing it?** Any problem that
genuinely needs a real backend ecosystem - a real third-party npm package (e.g. a
validation library, a queue client, `bcrypt`, anything with native bindings), real
multi-process/multi-file project structure, or Mongoose features beyond basic
CRUD/query operators - would not work without first extending the shim, or would
need to fall back to a different execution path entirely.

**6. What risks could cause us to regret this decision?** If the problem bank grows
beyond simple CRUD-shaped Express/Mongoose exercises (e.g. file uploads, auth
middleware using real JWT libraries, WebSocket problems, anything genuinely
multi-package), the adapter's maintenance burden could grow faster than expected,
and each new unsupported pattern surfaces as a confusing-to-students failure rather
than a clear "not supported" message unless we deliberately build that in.

**7. Is the alternative genuinely better in any important scenario?** Yes, in one
case this POC did confirm as real: if a future problem set requires a genuinely
authentic Node.js/Linux environment (arbitrary real npm packages, real file I/O, real
multi-process behavior, something that would be dishonest to fake with a shim),
Solution A's real runtime is the only one of the two that can honestly deliver that -
Solution B cannot, by construction, no matter how much adapter code is added.

**8. Is either implementation unnecessarily complicated for our requirements?**
Solution A's machinery (the outer-app-wrapping pattern, the one-shot-CLI-process-per-request
loopback transport that replaced the original Portal-based one) is real necessary
complexity for *its* approach, not padding - but it's also complexity this problem bank
doesn't currently need, since the problems targeted (CRUD-shaped Express/Mongoose
exercises) don't need a real npm ecosystem. Solution B's shims are already about as small
as they can be for the documented, explicit feature list; nothing in it looks like
premature generality.

**9. What would be the minimum architecture we should actually build?** Solution B as
built here, extended incrementally: add the specific Express/Mongoose patterns the
*actual* problem bank needs (checked against real problem drafts, not guessed), add a
per-submission execution timeout in the Worker (not implemented in this POC - see the
security section of each architecture doc), and keep the direct-in-process
seed/reset/collection-state approach rather than adding any HTTP layer.

**10. What would make you reconsider this recommendation?** Concrete evidence that
the problem bank needs a real npm package or real Node semantics the shim can't
reasonably support (point 7); or if BrowserPod resolves the crash-isolation gap (e.g.
Express 5 by default, or a documented pod-health/restart API) and demonstrates
reliable multi-Pod concurrency in one tab, at which point the per-submission cost is
the only remaining tradeoff, and that might be worth it for problems that need real
fidelity.
