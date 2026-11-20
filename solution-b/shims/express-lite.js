// Minimal Express-compatible shim. CommonJS on purpose: it gets inlined by
// esbuild when the bundled student code does `require("express")`.

function compilePath(path) {
    const paramNames = []
    const regexStr = path.replace(/:[^/]+/g, (m) => {
        paramNames.push(m.slice(1))
        return "([^/]+)"
    })
    return { regex: new RegExp("^" + regexStr + "$"), paramNames }
}

// Like compilePath, but matches a *prefix* of req.path (for middleware mount
// paths, which may themselves contain :params from an outer router mount -
// e.g. a comments router mounted at "/:postId/comments" under a posts router
// mounted at "/posts"). Anchored at the start; the prefix must end exactly at
// a "/" boundary or the end of the string so "/posts2" doesn't match "/post".
function compilePrefix(path) {
    const paramNames = []
    const regexStr = path.replace(/:[^/]+/g, (m) => {
        paramNames.push(m.slice(1))
        return "([^/]+)"
    })
    return { regex: new RegExp("^" + regexStr + "(?:/|$)"), paramNames }
}

// Joins a mount path with a sub-path the way Express does: a sub-route of
// exactly "/" collapses onto the mount path itself (no trailing slash
// required in the real request), rather than literally concatenating strings.
function joinPath(mountPath, subPath) {
    if (!mountPath) return subPath
    if (!subPath || subPath === "/") return mountPath
    const base = mountPath.endsWith("/") ? mountPath.slice(0, -1) : mountPath
    return base + (subPath.startsWith("/") ? subPath : "/" + subPath)
}

function matchRoute(entry, method, pathName) {
    if (entry.type !== "route" || entry.method !== method) return null
    const m = entry.matcher.regex.exec(pathName)
    if (!m) return null
    const params = {}
    entry.matcher.paramNames.forEach((name, i) => (params[name] = m[i + 1]))
    return params
}

class Router {
    constructor() {
        this.stack = []
    }

    use(a, b) {
        let mountPath = null
        let handler = a
        if (typeof a === "string") {
            mountPath = a
            handler = b
        }
        if (handler && Array.isArray(handler.stack)) {
            // Mounting a sub-router: flatten its entries into this one.
            // Re-applying this on every use() call is what makes arbitrary
            // mounting depth work - a twice-flattened stack is still just a
            // stack of {route-with-full-path} / {middleware-with-full-prefix}
            // entries to the next flatten.
            for (const entry of handler.stack) {
                if (entry.type === "route") {
                    const path = joinPath(mountPath, entry.path)
                    this.stack.push({ ...entry, path, matcher: compilePath(path) })
                } else {
                    const path = entry.path ? joinPath(mountPath, entry.path) : mountPath
                    this.stack.push({ ...entry, path, prefixMatcher: path ? compilePrefix(path) : null })
                }
            }
        } else {
            this.stack.push({ type: "middleware", path: mountPath, handlers: [handler], prefixMatcher: mountPath ? compilePrefix(mountPath) : null })
        }
        return this
    }

    _route(method, path, handlers) {
        this.stack.push({ type: "route", method, path, handlers, matcher: compilePath(path) })
        return this
    }

    get(path, ...h) {
        return this._route("GET", path, h)
    }
    post(path, ...h) {
        return this._route("POST", path, h)
    }
    put(path, ...h) {
        return this._route("PUT", path, h)
    }
    patch(path, ...h) {
        return this._route("PATCH", path, h)
    }
    delete(path, ...h) {
        return this._route("DELETE", path, h)
    }
}

class App extends Router {
    handle(req) {
        return new Promise((resolve) => {
            let settled = false
            const finish = (res) => {
                if (settled) return
                settled = true
                resolve(res)
            }
            const res = {
                statusCode: 200,
                status(code) {
                    this.statusCode = code
                    return this
                },
                json(body) {
                    this.body = body
                    finish(this)
                    return this
                },
                send(body) {
                    this.body = body
                    finish(this)
                    return this
                },
                sendStatus(code) {
                    this.statusCode = code
                    finish(this)
                    return this
                },
                end() {
                    finish(this)
                    return this
                },
            }

            const stack = this.stack
            let idx = 0

            const next = (err) => {
                if (settled) return
                if (err) {
                    while (idx < stack.length) {
                        const entry = stack[idx++]
                        if (entry.type === "middleware" && entry.handlers[0].length === 4) {
                            try {
                                entry.handlers[0](err, req, res, next)
                            } catch (e) {
                                res.status(500).json({ error: e.message })
                            }
                            return
                        }
                    }
                    res.status(500).json({ error: err.message || "internal error" })
                    return
                }
                while (idx < stack.length) {
                    const entry = stack[idx++]
                    if (entry.type === "middleware") {
                        if (entry.prefixMatcher) {
                            const m = entry.prefixMatcher.regex.exec(req.path)
                            if (!m) continue
                            entry.prefixMatcher.paramNames.forEach((name, i) => (req.params[name] = m[i + 1]))
                        }
                        const h = entry.handlers[0]
                        if (h.length === 4) continue
                        try {
                            const r = h(req, res, next)
                            if (r && typeof r.catch === "function") r.catch(next)
                        } catch (e) {
                            next(e)
                        }
                        return
                    } else {
                        const params = matchRoute(entry, req.method, req.path)
                        if (!params) continue
                        Object.assign(req.params, params)
                        try {
                            const r = entry.handlers[0](req, res, next)
                            if (r && typeof r.catch === "function") r.catch(next)
                        } catch (e) {
                            next(e)
                        }
                        return
                    }
                }
                res.status(404).json({ error: "not found" })
            }

            next()
        })
    }
}

function express() {
    return new App()
}
express.Router = function (_options) {
    // _options (e.g. { mergeParams: true }) is accepted but unused: params
    // from every mount level already end up merged into req.params because
    // routes/middleware are matched against their *fully flattened* path.
    return new Router()
}
express.json = function () {
    // Our harness always hands handlers an already-parsed body object, so
    // this is a no-op pass-through kept only for API-shape compatibility.
    return function jsonBodyParserNoop(req, res, next) {
        next()
    }
}

module.exports = express
module.exports.default = express
