// One-shot CLI run once per grader call (pod.run("node", ["request-cli.js", ...])).
// Takes method/path/body/headers as argv (not stdin - BrowserPod's Terminal API
// has no documented way to feed stdin to a running process, see
// docs/solution-a-architecture.md), makes a single plain loopback HTTP request
// to the already-running server.js on the same Pod, and prints the result as
// one delimited line the host page's terminal-output buffer can pick out.
const http = require("http")

const [, , method, path, bodyArg, headersArg] = process.argv
const body = bodyArg && bodyArg !== "null" ? JSON.parse(bodyArg) : undefined
const extraHeaders = headersArg ? JSON.parse(headersArg) : {}
const data = body !== undefined ? JSON.stringify(body) : null

const headers = { ...extraHeaders }
if (data) {
    headers["Content-Type"] = "application/json"
    headers["Content-Length"] = Buffer.byteLength(data)
}

const req = http.request({ host: "localhost", port: 4000, method, path, headers }, (res) => {
    let chunks = ""
    res.on("data", (c) => (chunks += c))
    res.on("end", () => {
        let parsedBody
        try {
            parsedBody = chunks ? JSON.parse(chunks) : null
        } catch {
            parsedBody = chunks
        }
        console.log("##RESP##" + JSON.stringify({ status: res.statusCode, body: parsedBody }))
    })
})
req.on("error", (err) => {
    console.log("##RESP##" + JSON.stringify({ error: err.message }))
})
if (data) req.write(data)
req.end()
