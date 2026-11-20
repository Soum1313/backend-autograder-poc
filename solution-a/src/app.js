import { SolutionARuntime } from "./harness.js"
import { runCases } from "../../shared-tests/run-cases.js"

const runBtn = document.getElementById("run-btn")
const statusEl = document.getElementById("status")
const resultsEl = document.getElementById("results")
const timingEl = document.getElementById("timing")
const logEl = document.getElementById("pod-log")
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

    const runtime = new SolutionARuntime({
        log: (text) => {
            logEl.textContent += text
            logEl.scrollTop = logEl.scrollHeight
        },
    })

    statusEl.textContent = "Booting BrowserPod pod (free fetch network, no API key), writing files, npm install, starting server…"
    const tBootStart = performance.now()
    await runtime.boot({ studentSource })
    const totalBootMs = performance.now() - tBootStart

    statusEl.textContent = "Pod ready. Running test cases…"
    const tRunStart = performance.now()
    const results = await runCases(runtime, testDef)
    const runMs = performance.now() - tRunStart

    const passed = results.filter((r) => r.passed).length
    statusEl.textContent = `Done: ${passed}/${results.length} passed`

    timingEl.textContent = [
        `BrowserPod SDK import: ${runtime.bootImportMs.toFixed(1)} ms`,
        `Pod boot (free fetch network, no API key): ${runtime.bootPodMs.toFixed(1)} ms`,
        `npm install express (via opinionatedFetch): ${runtime.npmInstallMs.toFixed(1)} ms`,
        `Total boot-to-ready: ${totalBootMs.toFixed(1)} ms`,
        `All ${results.length} test cases (loopback HTTP inside the Pod, via a one-shot node process per request): ${runMs.toFixed(1)} ms (${(runMs / results.length).toFixed(2)} ms/case avg)`,
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
    logEl.textContent = ""
    runBtn.disabled = true
    main()
        .catch((err) => {
            statusEl.textContent = `ERROR: ${err.message}`
            console.error(err)
        })
        .finally(() => {
            runBtn.disabled = false
        })
})
