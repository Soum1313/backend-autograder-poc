// Same shim as Solution B's shims/mongoose-lite.js (kept in sync by hand - see
// that file's comments for the populate()/SingleQuery rationale), adapted for
// a real Node.js process and with an explicit __resetAll/__getCollection
// export, since BrowserPod gives us no documented way to kill/restart a
// running process from the host page - reset happens via an in-process
// grader route in server.js instead (see docs/solution-a-architecture.md).

let idSeq = 1
function genId() {
    const hex = (idSeq++).toString(16).padStart(24, "0")
    return hex
}

const collections = new Map()
const modelsByName = new Map()

function pluralize(name) {
    return name.toLowerCase() + "s"
}

function getCollection(name) {
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)
}

// Resolves a schema field declared with `ref` (e.g. `{ type: String, ref:
// "Comment" }`, or `[{ type: String, ref: "Comment" }]` for an array of
// refs) into the referenced document(s), replacing the id(s) in place.
async function populateDoc(doc, schemaDef, field) {
    const spec = schemaDef[field]
    const isArraySpec = Array.isArray(spec)
    const refSpec = isArraySpec ? spec[0] : spec
    const refName = refSpec && refSpec.ref
    if (!refName) return doc
    const RefModel = modelsByName.get(refName)
    if (!RefModel) return doc
    if (isArraySpec) {
        const ids = doc[field] || []
        doc[field] = await Promise.all(ids.map((id) => RefModel.findById(id)))
    } else {
        doc[field] = doc[field] ? await RefModel.findById(doc[field]) : null
    }
    return doc
}

function applyDefaultsAndValidate(def, data) {
    const result = {}
    for (const [key, spec] of Object.entries(def)) {
        if (Array.isArray(spec)) {
            // Array-of-refs field (e.g. `[{ type: String, ref: "Comment" }]`):
            // no validation beyond defaulting to an empty array.
            result[key] = data[key] !== undefined ? data[key] : []
            continue
        }
        const fieldSpec = typeof spec === "function" ? { type: spec } : spec
        let value = data[key]
        if (value === undefined && "default" in fieldSpec) {
            value = typeof fieldSpec.default === "function" ? fieldSpec.default() : fieldSpec.default
        }
        if (value === undefined && fieldSpec.required) {
            const err = new Error(`Path \`${key}\` is required.`)
            err.status = 400
            throw err
        }
        if (value !== undefined) result[key] = value
    }
    return result
}

function matchesFilter(doc, filter) {
    for (const [key, cond] of Object.entries(filter || {})) {
        const val = doc[key]
        if (cond && typeof cond === "object" && !Array.isArray(cond)) {
            for (const [op, opVal] of Object.entries(cond)) {
                if (op === "$gt" && !(val > opVal)) return false
                if (op === "$gte" && !(val >= opVal)) return false
                if (op === "$lt" && !(val < opVal)) return false
                if (op === "$lte" && !(val <= opVal)) return false
                if (op === "$ne" && val === opVal) return false
                if (op === "$in" && !opVal.includes(val)) return false
                if (op === "$nin" && opVal.includes(val)) return false
                if (op === "$exists" && (val !== undefined) !== opVal) return false
            }
        } else if (val !== cond) {
            return false
        }
    }
    return true
}

function applyUpdate(doc, update) {
    const hasOperators = Object.keys(update).some((k) => k.startsWith("$"))
    if (!hasOperators) {
        Object.assign(doc, update)
        return doc
    }
    if (update.$set) Object.assign(doc, update.$set)
    if (update.$unset) for (const k of Object.keys(update.$unset)) delete doc[k]
    if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v
    if (update.$push)
        for (const [k, v] of Object.entries(update.$push)) {
            doc[k] = doc[k] || []
            doc[k].push(v)
        }
    if (update.$pull)
        for (const [k, v] of Object.entries(update.$pull)) {
            doc[k] = (doc[k] || []).filter((item) => item !== v)
        }
    return doc
}

class Query {
    constructor(coll, filter, schemaDef) {
        this._coll = coll
        this._filter = filter
        this._schemaDef = schemaDef
        this._sort = null
        this._skip = 0
        this._limit = null
        this._populateFields = []
    }
    sort(spec) {
        this._sort = spec
        return this
    }
    select() {
        return this
    }
    lean() {
        return this
    }
    skip(n) {
        this._skip = n
        return this
    }
    limit(n) {
        this._limit = n
        return this
    }
    populate(field) {
        this._populateFields.push(field)
        return this
    }
    async exec() {
        let docs = [...this._coll.values()].filter((d) => matchesFilter(d, this._filter))
        if (this._sort) {
            const [key, dir] = Object.entries(this._sort)[0]
            docs = docs.sort((a, b) => (a[key] - b[key]) * (dir < 0 ? -1 : 1))
        }
        if (this._skip) docs = docs.slice(this._skip)
        if (this._limit) docs = docs.slice(0, this._limit)
        docs = docs.map((d) => ({ ...d }))
        for (const field of this._populateFields) {
            docs = await Promise.all(docs.map((d) => populateDoc(d, this._schemaDef, field)))
        }
        return docs
    }
    then(resolve, reject) {
        return this.exec().then(resolve, reject)
    }
}

// Wraps a single-document lookup (findById/findOne) so it supports chained
// .populate() while still being directly awaitable, like the rest of this shim.
class SingleQuery {
    constructor(fetcher, schemaDef) {
        this._fetcher = fetcher
        this._schemaDef = schemaDef
        this._populateFields = []
    }
    populate(field) {
        this._populateFields.push(field)
        return this
    }
    async exec() {
        let doc = await this._fetcher()
        for (const field of this._populateFields) {
            if (doc) doc = await populateDoc(doc, this._schemaDef, field)
        }
        return doc
    }
    then(resolve, reject) {
        return this.exec().then(resolve, reject)
    }
}

class Schema {
    constructor(def) {
        this.def = def
    }
}

function model(name, schema) {
    const collName = pluralize(name)
    const coll = getCollection(collName)

    class Model {
        static async create(data) {
            const fields = applyDefaultsAndValidate(schema.def, data)
            const id = genId()
            const doc = { _id: id, ...fields }
            coll.set(id, doc)
            return { ...doc }
        }
        static find(filter = {}) {
            return new Query(coll, filter, schema.def)
        }
        static async findOne(filter = {}) {
            const docs = await new Query(coll, filter, schema.def).exec()
            return docs[0] || null
        }
        static findById(id) {
            return new SingleQuery(() => {
                const doc = coll.get(id)
                return doc ? { ...doc } : null
            }, schema.def)
        }
        static async countDocuments(filter = {}) {
            return (await new Query(coll, filter).exec()).length
        }
        static async exists(filter = {}) {
            return (await this.countDocuments(filter)) > 0
        }
        static async deleteOne(filter = {}) {
            const docs = await new Query(coll, filter).exec()
            if (docs[0]) coll.delete(docs[0]._id)
            return { deletedCount: docs[0] ? 1 : 0 }
        }
        static async deleteMany(filter = {}) {
            const docs = await new Query(coll, filter).exec()
            docs.forEach((d) => coll.delete(d._id))
            return { deletedCount: docs.length }
        }
        static async updateOne(filter, update) {
            const docs = await new Query(coll, filter).exec()
            if (!docs[0]) return { matchedCount: 0, modifiedCount: 0 }
            applyUpdate(coll.get(docs[0]._id), update)
            return { matchedCount: 1, modifiedCount: 1 }
        }
        static async updateMany(filter, update) {
            const docs = await new Query(coll, filter).exec()
            docs.forEach((d) => applyUpdate(coll.get(d._id), update))
            return { matchedCount: docs.length, modifiedCount: docs.length }
        }
        static async findOneAndUpdate(filter, update) {
            const docs = await new Query(coll, filter).exec()
            if (!docs[0]) return null
            applyUpdate(coll.get(docs[0]._id), update)
            return { ...coll.get(docs[0]._id) }
        }
        static async findByIdAndUpdate(id, update) {
            const real = coll.get(id)
            if (!real) return null
            applyUpdate(real, update)
            return { ...real }
        }
        static async findOneAndDelete(filter) {
            const docs = await new Query(coll, filter).exec()
            if (!docs[0]) return null
            coll.delete(docs[0]._id)
            return docs[0]
        }
        static async findByIdAndDelete(id) {
            const doc = coll.get(id)
            if (!doc) return null
            coll.delete(id)
            return { ...doc }
        }
    }

    modelsByName.set(name, Model)
    return Model
}

function __resetAll() {
    // Empty each collection's Map *in place* - don't clear the outer
    // `collections` registry itself. Model classes were created once at
    // require-time and their `coll` closures hold direct references to these
    // Map objects; replacing/removing the registry entries would orphan the
    // old (still-populated) Maps instead of actually clearing them, since
    // there's no re-require here to rebuild those closures (unlike Solution
    // B, where reset re-evaluates the whole bundle fresh).
    for (const coll of collections.values()) {
        coll.clear()
    }
    idSeq = 1
}

const mongoose = { Schema, model, __resetAll, __getCollection: getCollection }
module.exports = mongoose
module.exports.default = mongoose
