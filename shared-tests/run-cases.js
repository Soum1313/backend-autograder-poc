// Shared test-case runner. Pure logic, no DOM — consumed by both solutions'
// own UI/test pages so the *evaluation logic* is identical, while each
// solution keeps its own transport (in-process call vs real HTTP) separate.

function evaluate(expect, response) {
    if (!response) return { passed: false, reason: "no response" }
    if (expect.status !== undefined && response.status !== expect.status) {
        return { passed: false, reason: `expected status ${expect.status}, got ${response.status}` }
    }
    if (expect.bodyContains) {
        for (const [k, v] of Object.entries(expect.bodyContains)) {
            if (response.body?.[k] !== v) {
                return { passed: false, reason: `expected body.${k}=${JSON.stringify(v)}, got ${JSON.stringify(response.body?.[k])}` }
            }
        }
    }
    if (expect.minLength !== undefined) {
        if (!Array.isArray(response.body) || response.body.length < expect.minLength) {
            return { passed: false, reason: `expected array length >= ${expect.minLength}, got ${response.body?.length}` }
        }
    }
    if (expect.length !== undefined) {
        if (!Array.isArray(response.body) || response.body.length !== expect.length) {
            return { passed: false, reason: `expected array length === ${expect.length}, got ${response.body?.length}` }
        }
    }
    if (expect.allMatch) {
        for (const item of response.body) {
            for (const [k, v] of Object.entries(expect.allMatch)) {
                if (item[k] !== v) return { passed: false, reason: `item failed allMatch ${k}=${v}` }
            }
        }
    }
    if (expect.sortedDescBy) {
        const key = expect.sortedDescBy
        for (let i = 1; i < response.body.length; i++) {
            if (response.body[i - 1][key] < response.body[i][key]) {
                return { passed: false, reason: `not sorted desc by ${key}` }
            }
        }
    }
    if (expect.nestedArrayFirstItem) {
        const { field, contains } = expect.nestedArrayFirstItem
        const arr = response.body?.[field]
        if (!Array.isArray(arr) || arr.length === 0) {
            return { passed: false, reason: `expected body.${field} to be a non-empty array, got ${JSON.stringify(arr)}` }
        }
        for (const [k, v] of Object.entries(contains)) {
            if (arr[0]?.[k] !== v) {
                return { passed: false, reason: `expected ${field}[0].${k}=${JSON.stringify(v)}, got ${JSON.stringify(arr[0]?.[k])}` }
            }
        }
    }
    return { passed: true, reason: "ok" }
}

export async function runCases(runtime, testDef) {
    await runtime.reset()
    const seedCollection = testDef.seedCollection || "todos"
    const seedDocs = testDef.seed.map(({ _seed, ...rest }) => rest)
    await runtime.seed(seedDocs, testDef.seedModel)
    const seeded = await runtime.getCollectionState(seedCollection)
    const seedIds = seeded.map((d) => d._id)

    const resolvePath = (path) => path.replace(/\{\{seed(\d+)\}\}/g, (_, i) => seedIds[Number(i)])

    const results = []
    for (const testCase of testDef.cases) {
        const path = resolvePath(testCase.request.path)
        const t0 = performance.now()
        let response
        let errorMsg = null
        try {
            response = await runtime.request(testCase.request.method, path, testCase.request.body, testCase.request.headers)
        } catch (e) {
            errorMsg = e.message
        }
        const elapsedMs = performance.now() - t0
        const outcome = errorMsg ? { passed: false, reason: errorMsg } : evaluate(testCase.expect, response)
        results.push({
            id: testCase.id,
            category: testCase.category,
            passed: outcome.passed,
            reason: outcome.reason,
            elapsedMs,
            response,
        })
    }
    return results
}
