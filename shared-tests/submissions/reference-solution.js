// Reference "correct" student submission for the Todo API problem.
// Written against the plain public Express + Mongoose APIs only (the subset
// listed in docs/solution-b-architecture.md's adapter coverage) so the exact
// same file can run unmodified under:
//   - Solution A (BrowserPod): real express + real mongoose
//   - Solution B: express-lite + mongoose-lite shims resolved for bare imports
//
// Exports the Express app instance; nothing calls app.listen() here — each
// harness wires up transport (real HTTP socket for A, in-process request/response
// simulation for B).

const express = require("express")
const mongoose = require("mongoose")

const TodoSchema = new mongoose.Schema({
    title: { type: String, required: true },
    done: { type: Boolean, default: false },
    priority: { type: Number, default: 0 },
})

const Todo = mongoose.model("Todo", TodoSchema)

const app = express()
app.use(express.json())

// simple logging middleware that mutates req, used to test middleware chaining
app.use((req, res, next) => {
    req.receivedAt = Date.now()
    next()
})

const router = express.Router()

router.post("/todos", async (req, res, next) => {
    try {
        if (!req.body || !req.body.title) {
            return res.status(400).json({ error: "title is required" })
        }
        const todo = await Todo.create({
            title: req.body.title,
            priority: req.body.priority,
        })
        res.status(201).json(todo)
    } catch (err) {
        next(err)
    }
})

router.get("/todos", async (req, res, next) => {
    try {
        const filter = {}
        if (req.query.done !== undefined) {
            filter.done = req.query.done === "true"
        }
        let query = Todo.find(filter)
        if (req.query.sort === "priority") {
            query = query.sort({ priority: -1 })
        }
        const todos = await query.exec()
        res.status(200).json(todos)
    } catch (err) {
        next(err)
    }
})

router.get("/todos/:id", async (req, res, next) => {
    try {
        const todo = await Todo.findById(req.params.id)
        if (!todo) return res.status(404).json({ error: "not found" })
        res.status(200).json(todo)
    } catch (err) {
        next(err)
    }
})

router.put("/todos/:id", async (req, res, next) => {
    try {
        const todo = await Todo.findByIdAndUpdate(req.params.id, req.body, { new: true })
        if (!todo) return res.status(404).json({ error: "not found" })
        res.status(200).json(todo)
    } catch (err) {
        next(err)
    }
})

router.delete("/todos/:id", async (req, res, next) => {
    try {
        const todo = await Todo.findByIdAndDelete(req.params.id)
        if (!todo) return res.status(404).json({ error: "not found" })
        res.status(200).json({ ok: true })
    } catch (err) {
        next(err)
    }
})

app.use(router)

// basic error handler middleware
app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message || "internal error" })
})

module.exports = { app, Todo }
