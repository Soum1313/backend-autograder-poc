import { SolutionBRuntime } from "./harness.js"
import { runCases } from "../../shared-tests/run-cases.js"

const runBtn = document.getElementById("run-btn")
const statusEl = document.getElementById("status")
const resultsEl = document.getElementById("results")
const timingEl = document.getElementById("timing")
const problemSelect = document.getElementById("problem-select")

const PROBLEMS = {
    "todo-api": {
        submission: "../shared-tests/submissions/reference-solution.js",
        testDef: "../shared-tests/todo-api.test.json",
    },
    "blog-api": {
        submission: "../shared-tests/submissions/blog-api-reference.js",
        testDef: "../shared-tests/blog-api.test.json",
    },
}

async function main() {
    const problem = PROBLEMS[problemSelect.value]
    statusEl.textContent = "Fetching student submission + test cases…"
    const [studentSource, testDef] = await Promise.all([
        fetch(problem.submission, { cache: "no-store" }).then((r) => r.text()),
        fetch(problem.testDef, { cache: "no-store" }).then((r) => r.json()),
    ])

    const runtime = new SolutionBRuntime()

    statusEl.textContent = "Bundling + loading student code…"
    const tLoadStart = performance.now()
    await runtime.loadStudentCode(studentSource)
    const loadMs = performance.now() - tLoadStart

    statusEl.textContent = "Running test cases…"
    const tRunStart = performance.now()
    const results = await runCases(runtime, testDef)
    const runMs = performance.now() - tRunStart

    const passed = results.filter((r) => r.passed).length
    statusEl.textContent = `Done: ${passed}/${results.length} passed`

    timingEl.textContent = [
        `Bundle time (esbuild-wasm): ${runtime.lastBundleTimeMs.toFixed(1)} ms`,
        `Load (bundle + worker LOAD round-trip): ${loadMs.toFixed(1)} ms`,
        `All ${results.length} test cases: ${runMs.toFixed(1)} ms (${(runMs / results.length).toFixed(2)} ms/case avg)`,
    ].join("\n")

    resultsEl.innerHTML = ""
    for (const r of results) {
        const row = document.createElement("div")
        row.className = r.passed ? "pass" : "fail"
        row.textContent = `[${r.passed ? "PASS" : "FAIL"}] ${r.id} (${r.category}) — ${r.reason} — ${r.elapsedMs.toFixed(2)}ms`
        resultsEl.appendChild(row)
    }

    window.__lastResults = results
    window.__runtime = runtime
}

runBtn.addEventListener("click", () => {
    resultsEl.innerHTML = ""
    main().catch((err) => {
        statusEl.textContent = `ERROR: ${err.message}`
        console.error(err)
    })
})
