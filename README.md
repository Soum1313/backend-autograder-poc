# Backend Autograder POC

Compares two architectures for grading student-written Express + Mongoose backend
code entirely client-side: **Solution A** (BrowserPod - a real Node.js runtime in
the browser) vs **Solution B** (our own esbuild-wasm pipeline + a custom
Express/Mongoose compatibility shim).

Start with **[docs/comparison-report.md](docs/comparison-report.md)** for the
recommendation. See `docs/implementation-plan.md` and the two
`docs/solution-*-architecture.md` files for how each was actually built and what
broke along the way.

This POC is fully independent of `Mentorpick_Backend` and `mentorpick-v2-frontend` -
nothing here is imported by, or imports from, either production repo.

## Running Solution B (no account needed)

```bash
cd backend-autograder-poc
python3 -m http.server 8999
```

Then open `http://localhost:8999/solution-b/index.html`, pick a problem from the
dropdown (Todo API, or the harder Blog API with nested routers/auth
middleware/populate), and click "Run tests". If you don't see the dropdown, hard-refresh
once - `python3 -m http.server` doesn't send cache-busting headers.

## Running Solution A (no account or API key needed)

```bash
cd backend-autograder-poc
python3 solution-a/serve-coop.py   # serves with the COOP/COEP headers BrowserPod needs
```

Then open `http://localhost:8998/solution-a/index.html` and click "Boot pod + run
tests". Runs entirely on BrowserPod's free fetch network - boot + `npm install` takes
~35 seconds (see `docs/solution-a-architecture.md` for why the free tier is slower
than the paid-API-key version this POC started with).

## Directory layout

```
backend-autograder-poc/
├── docs/                    implementation plan, both architectures, comparison report
├── solution-a/              BrowserPod real-Node.js solution
├── solution-b/              esbuild-wasm + custom Express/Mongoose shim solution
└── shared-tests/            the one Todo API student submission + test cases both solutions grade
```
