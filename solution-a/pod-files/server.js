// Harness-side wrapper around the student's untouched submission module.
// Adds grader-only routes under /__grader/* for seeding/reading/resetting DB
// state directly, without modifying the student's own file. Generalized to
// work with any submission's exports (not just the Todo API's {app, Todo}),
// matching Solution B's generic SEED/GET_COLLECTION/RESET design.
const express = require("express")
const studentExports = require("./reference-solution.js")
const { app: studentApp } = studentExports
const mongoose = require("mongoose") // resolves to our node_modules/mongoose shim

const app = express()
app.use(express.json())

app.post("/__grader/seed", async (req, res) => {
    const Model = req.body.modelKey ? studentExports[req.body.modelKey] : studentExports.Todo
    for (const doc of req.body.docs) {
        await Model.create(doc)
    }
    res.json({ ok: true })
})

app.get("/__grader/collection/:name", async (req, res) => {
    const map = mongoose.__getCollection(req.params.name)
    res.json(map ? [...map.values()] : [])
})

app.post("/__grader/reset", (req, res) => {
    mongoose.__resetAll()
    res.json({ ok: true })
})

app.use(studentApp)

const PORT = 4000
app.listen(PORT, () => {
    console.log(`grader server listening on ${PORT}`)
})
