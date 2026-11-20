// Deliberately incomplete: valid code, but skips the "title is required"
// validation and never returns 404 for missing documents. Used to verify the
// grader correctly fails the right test cases instead of false-passing.

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

const router = express.Router()

router.post("/todos", async (req, res) => {
    // BUG: no validation of req.body.title
    const todo = await Todo.create({ title: req.body.title, priority: req.body.priority })
    res.status(201).json(todo)
})

router.get("/todos", async (req, res) => {
    const todos = await Todo.find({}).exec()
    res.status(200).json(todos)
})

router.get("/todos/:id", async (req, res) => {
    const todo = await Todo.findById(req.params.id)
    // BUG: returns 200 with null body instead of 404 when not found
    res.status(200).json(todo)
})

app.use(router)

module.exports = { app, Todo }
