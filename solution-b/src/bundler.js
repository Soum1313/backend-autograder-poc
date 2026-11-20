// Bundles student Express/Mongoose code against our local shims using
// esbuild-wasm, loaded straight from a CDN (no npm install needed for this POC).

let esbuildPromise = null

async function getEsbuild() {
    if (!esbuildPromise) {
        esbuildPromise = (async () => {
            const mod = await import("https://esm.sh/esbuild-wasm@0.24.2")
            const esbuild = mod.default ?? mod
            await esbuild.initialize({
                wasmURL: "https://esm.sh/esbuild-wasm@0.24.2/esbuild.wasm",
                worker: true,
            })
            return esbuild
        })()
    }
    return esbuildPromise
}

export async function bundleStudentCode(studentSource, shimSources) {
    const esbuild = await getEsbuild()

    const virtualFiles = {
        "/entry.js": studentSource,
        "/shims/express-lite.js": shimSources.express,
        "/shims/mongoose-lite.js": shimSources.mongoose,
    }

    const virtualFsPlugin = {
        name: "virtual-fs",
        setup(build) {
            build.onResolve({ filter: /.*/ }, (args) => {
                if (args.path === "express") return { path: "/shims/express-lite.js" }
                if (args.path === "mongoose") return { path: "/shims/mongoose-lite.js" }
                if (virtualFiles[args.path] !== undefined) return { path: args.path }
                return { path: args.path, namespace: "unresolved" }
            })
            build.onLoad({ filter: /.*/, namespace: "" }, (args) => {
                const contents = virtualFiles[args.path]
                if (contents === undefined) {
                    return { errors: [{ text: `Cannot resolve module: ${args.path}` }] }
                }
                return { contents, loader: "js" }
            })
            build.onLoad({ filter: /.*/, namespace: "unresolved" }, (args) => ({
                errors: [{ text: `Module not found: ${args.path}` }],
            }))
        },
    }

    const result = await esbuild.build({
        entryPoints: ["/entry.js"],
        bundle: true,
        write: false,
        format: "iife",
        globalName: "StudentModule",
        plugins: [virtualFsPlugin],
        logLevel: "silent",
    })

    return result.outputFiles[0].text
}
