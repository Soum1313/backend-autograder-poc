# Solution B — Custom Express/Mongoose Adapter on esbuild-wasm

## Status: fully working, fully tested (as implemented, not just planned)

## Architecture

```
reference-solution.js (plain CJS, require("express")/require("mongoose"))
        |
        v
bundler.js — esbuild-wasm (loaded from esm.sh CDN, no npm install)
        |  virtual-fs plugin: resolves bare "express"/"mongoose" imports
        |  to local shim files, bundles everything into one IIFE
        v
worker.js (dedicated Web Worker — isolation boundary)
        |  (0, eval)(bundledCode)  -> self.StudentModule = { app, Todo }
        |  mongoose-lite's in-memory collections live in this worker's
        |  global scope only
        v
harness.js (main thread) — GraderRuntime implementation
        |  postMessage protocol: LOAD / SEED / REQUEST / GET_COLLECTION / RESET
        v
shared-tests/run-cases.js — same test-case definitions as Solution A
```

## Express compatibility (`shims/express-lite.js`)

Implemented: `express()`, `express.Router(opts)` (`mergeParams` accepted and
unnecessary - see below), `app.use()` / `router.use()` with **arbitrary mounting
depth** (re-flattening on every `use()` call means a router mounted inside a router
mounted inside the app works with no special-casing), verb methods
(`get/post/put/patch/delete`), route params (`:id`), `req.params/query/headers/body`,
middleware chain with `next(err)`, async handlers (rejected promises routed into
`next`), 4-arg error-handling middleware, `res.status/json/send/sendStatus/end`.
`express.json()` is a no-op pass-through since the harness always hands handlers an
already-parsed JS object body (no real wire format to parse).

**Extended for a harder "blog API" stress test** (`shared-tests/submissions/blog-api-reference.js`,
`shared-tests/blog-api.test.json`): a nested `/posts/:postId/comments` resource router,
a `requireAuth` middleware scoped only to that sub-router (reading a real header),
pagination (`skip`/`limit`), and Mongoose-style `.populate()`. All 16 cases passed,
including the original 14 Todo API cases with **zero regressions** after these changes.

**`mergeParams` needs no real implementation**: because mounting re-flattens a
sub-router's routes into the parent as one fully-concatenated path string (e.g.
`"/posts" + "/:postId/comments" + "/"` → `"/posts/:postId/comments"`, one regex
compiled from the whole thing), every `:param` along the mount chain is already
captured by the single outermost route match. A real implementation detail turned
into a free correctness property of the "flatten by string concatenation" design.

**Bug found and fixed during testing**: the dispatch loop originally applied a
middleware mount-path prefix check (`req.path.startsWith(entry.path)`) to route
entries too. Since a route entry's `path` is the raw pattern (e.g. `/todos/:id`),
`startsWith` against a literal colon-containing string never matches a real id,
so every parameterized route silently 404'd. This was masked in several test
cases that *expected* 404 anyway (nonexistent-id cases), and only surfaced once
`read-by-id`/`update-valid`/`delete-valid` (which use a real seeded id) were run.
Fixed by only applying the prefix check to middleware entries; route entries are
matched purely through their own compiled regex.

**Two more bugs found while building the blog API stress test:**

1. **Trailing-slash mismatch on flattened sub-router routes.** Naive string
   concatenation of mount path + sub-route path (e.g. `"/:postId/comments" + "/"`)
   produced `"/:postId/comments/"` - a route pattern demanding a trailing slash the
   real client request (`POST /posts/<id>/comments`, no trailing slash) never sends.
   Real Express collapses a sub-router's `"/"` route onto its mount path exactly;
   our naive concatenation didn't. Fixed with a `joinPath()` helper that special-cases
   a sub-path of `"/"` (collapses onto the mount path) instead of literally
   concatenating strings.
2. **Middleware mount-path matching couldn't handle a parameterized mount path.**
   `commentsRouter.use(requireAuth)`, once flattened twice (into `postsRouter`, then
   into `app`), ends up with a mount path like `"/posts/:postId/comments"`. The
   original literal `req.path.startsWith(entry.path)` check (same bug class as the
   route-matching one above, but for middleware) would never match a concrete
   request path against a pattern containing a literal colon. Fixed with a
   `compilePrefix()` matcher (an anchored-at-start regex, unlike `compilePath()`'s
   anchored-at-both-ends one) that also captures and merges any params found in the
   mount path into `req.params` - which is how `requireAuth` or any other
   sub-router-scoped middleware gets access to params from its mount chain too.

## Mongoose compatibility (`shims/mongoose-lite.js`)

Implemented: `Schema`, `model()`, `create`, `find` (with `.sort/.skip/.limit/.select/.lean/.populate/.exec`,
and direct `await` via a `then()` on the Query object), `findOne`, `findById` (now
returns a `SingleQuery` - also chainable with `.populate()`, also directly awaitable),
`countDocuments`, `exists`, `deleteOne/deleteMany`, `updateOne/updateMany`,
`findOneAndUpdate/findByIdAndUpdate`, `findOneAndDelete/findByIdAndDelete`,
query operators `$gt/$gte/$lt/$lte/$ne/$in/$nin/$exists`, update operators
`$set/$unset/$inc/$push/$pull`. Required-field validation and `default` values
are applied in `applyDefaultsAndValidate`, thrown as a plain `Error` with a
`status` property the route code is expected to turn into a 400 (matches how a
real Mongoose `ValidationError` is typically handled in route code, without
pulling in Mongoose's actual validation engine).

**`populate()` added** (schema fields declared with `ref`, e.g.
`commentIds: [{ type: String, ref: "Comment" }]`): a module-level `modelsByName`
registry lets any model resolve another model by name at populate time, and
`populateDoc()` replaces the id(s) in place with the referenced document(s) - the
common array-of-refs and single-ref cases both verified live (`get-post-populated-comments`
in the blog API test set).

Still not implemented (explicitly out of scope per the spec): nested/embedded
sub-document schemas, virtuals, instance methods/statics declared on the schema,
indexes, transactions, change streams, real `ObjectId` type (ids are plain hex
strings, not an `ObjectId` instance — `.toString()` on them works but
`instanceof mongoose.Types.ObjectId` would not), and "virtual populate" (populating
the *reverse* direction of a relationship, e.g. a `Post` listing its `Comment`s
without storing `commentIds` on the `Post` itself - real Mongoose supports this with
extra schema config; this shim only populates a field that actually stores the
foreign id(s), which is what the stress-test submission does and is the common case).

## In-memory store

One `Map` per collection (pluralized lowercase model name — simple `name + "s"`,
not real Mongoose pluralization rules), keyed by a sequential hex id generated
per-process. The whole store lives inside the dispatch Worker's global scope;
re-`eval`-ing the bundle (done on every `reset()`) creates a brand-new closure
instance of the shim, which is how resets and isolation between submissions are
achieved — no explicit "clear the DB" step was needed once this was the
reset strategy.

## Isolation

- Execution happens in a dedicated Web Worker, not the host page's main thread.
  A worker cannot touch the DOM, cannot read the harness's own variables, and a
  worker-level crash doesn't take down the grading UI.
- It is **not** a strong security sandbox: within that worker, student code has
  full JS capability — it can open a WebSocket, call `fetch()`, run an infinite
  loop (which would hang that one worker, not the main thread, but nothing here
  currently enforces a timeout or kills a hung worker), or try to read
  `self.__mongooseLiteCollections` directly to bypass the Mongoose API and
  fabricate "passing" data. None of that is prevented today. See
  `docs/comparison-report.md` for the full security assessment.

## Actual measurements (this machine, Chromium-based Claude Browser pane)

| Scenario | Result |
|---|---|
| Cold bundle (very first esbuild-wasm init + bundle) | ~793 ms |
| Bundle after esbuild-wasm already initialized (fresh page load) | ~228 ms |
| Warm bundle (esbuild-wasm already initialized, same page) | ~12 ms |
| 14 test cases, in-process dispatch | ~2–4 ms total (<0.3 ms/case) |
| 10 submissions, run sequentially (fresh worker each) | 160.6 ms |
| 10 submissions, run in parallel (10 workers at once) | 102 ms |
| 25 submissions, run in parallel | 225.5 ms |
| 50 submissions, run in parallel | 422 ms (~8.4 ms/submission) |
| Syntax-error submission | Rejected cleanly with `esbuild` error text; harness did not crash |
| Logically-incomplete submission (reference solution with validation/404 bugs removed) | Correctly scored 6/14, not a false 14/14 |

All of the above are measured in one browser tab (one real user's machine), not
across 400 separate real devices — see `docs/comparison-report.md` for how far
that generalizes.
