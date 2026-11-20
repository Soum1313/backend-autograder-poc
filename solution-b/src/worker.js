// Isolation boundary: evaluates the bundled student+shim code here, not on
// the main thread. The in-memory "database" (mongoose-lite's collections map)
// lives entirely inside this worker's global scope.

let studentModule = null

function parseQuery(queryStr) {
    const query = {}
    if (!queryStr) return query
    for (const pair of queryStr.split("&")) {
        if (!pair) continue
        const [k, v] = pair.split("=")
        query[decodeURIComponent(k)] = decodeURIComponent(v ?? "")
    }
    return query
}

function buildRequest(method, path, body, headers) {
    const [pathname, queryStr] = path.split("?")
    const normalizedHeaders = {}
    for (const [k, v] of Object.entries(headers ?? {})) {
        normalizedHeaders[k.toLowerCase()] = v
    }
    return {
        method,
        path: pathname,
        query: parseQuery(queryStr),
        body: body ?? {},
        headers: normalizedHeaders,
        params: {},
    }
}

self.onmessage = async (ev) => {
    const { id, type, payload } = ev.data
    try {
        let result
        switch (type) {
            case "LOAD": {
                // Indirect eval runs in worker-global scope, so the bundle's
                // `var StudentModule = ...` (from esbuild's iife/globalName
                // output) attaches to `self`, giving us a fresh module
                // instance - and fresh mongoose-lite collections - each time.
                ;(0, eval)(payload.bundledCode)
                studentModule = self.StudentModule
                result = { ok: true }
                break
            }
            case "SEED": {
                const Model = payload.modelKey ? studentModule[payload.modelKey] : studentModule.Todo
                for (const doc of payload.docs) {
                    await Model.create(doc)
                }
                result = { ok: true }
                break
            }
            case "REQUEST": {
                const req = buildRequest(payload.method, payload.path, payload.body, payload.headers)
                const res = await studentModule.app.handle(req)
                result = { status: res.statusCode, body: res.body }
                break
            }
            case "GET_COLLECTION": {
                const map = self.__mongooseLiteCollections?.get(payload.name)
                result = map ? [...map.values()] : []
                break
            }
            case "RESET": {
                studentModule = null
                delete self.StudentModule
                delete self.__mongooseLiteCollections
                result = { ok: true }
                break
            }
            default:
                throw new Error(`Unknown message type: ${type}`)
        }
        self.postMessage({ id, ok: true, result })
    } catch (err) {
        self.postMessage({ id, ok: false, error: err?.message ?? String(err) })
    }
}
