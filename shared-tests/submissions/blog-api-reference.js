// Harder stress-test submission: two models, a nested resource router
// (/posts/:postId/comments), router-scoped auth middleware, pagination, and
// Mongoose-style populate() - all patterns the Todo API never exercised.
const express = require("express")
const mongoose = require("mongoose")

const CommentSchema = new mongoose.Schema({
    postId: { type: String, required: true },
    text: { type: String, required: true },
    author: { type: String, default: "anonymous" },
})
const Comment = mongoose.model("Comment", CommentSchema)

const PostSchema = new mongoose.Schema({
    title: { type: String, required: true },
    body: { type: String, default: "" },
    published: { type: Boolean, default: false },
    commentIds: [{ type: String, ref: "Comment" }],
})
const Post = mongoose.model("Post", PostSchema)

function requireAuth(req, res, next) {
    if (req.headers.authorization !== "Bearer secret-token") {
        return res.status(401).json({ error: "unauthorized" })
    }
    next()
}

const commentsRouter = express.Router({ mergeParams: true })
commentsRouter.use(requireAuth)

commentsRouter.post("/", async (req, res, next) => {
    try {
        if (!req.body?.text) return res.status(400).json({ error: "text is required" })
        const comment = await Comment.create({
            postId: req.params.postId,
            text: req.body.text,
            author: req.body.author,
        })
        await Post.findByIdAndUpdate(req.params.postId, { $push: { commentIds: comment._id } })
        res.status(201).json(comment)
    } catch (err) {
        next(err)
    }
})

commentsRouter.get("/", async (req, res, next) => {
    try {
        const comments = await Comment.find({ postId: req.params.postId }).exec()
        res.status(200).json(comments)
    } catch (err) {
        next(err)
    }
})

const postsRouter = express.Router()

postsRouter.post("/", async (req, res, next) => {
    try {
        if (!req.body?.title) return res.status(400).json({ error: "title is required" })
        const post = await Post.create({ title: req.body.title, body: req.body.body, published: req.body.published })
        res.status(201).json(post)
    } catch (err) {
        next(err)
    }
})

postsRouter.get("/", async (req, res, next) => {
    try {
        const page = parseInt(req.query.page || "1", 10)
        const limit = parseInt(req.query.limit || "10", 10)
        const posts = await Post.find({}).skip((page - 1) * limit).limit(limit).exec()
        res.status(200).json(posts)
    } catch (err) {
        next(err)
    }
})

postsRouter.get("/:id", async (req, res, next) => {
    try {
        const post = await Post.findById(req.params.id).populate("commentIds")
        if (!post) return res.status(404).json({ error: "not found" })
        res.status(200).json(post)
    } catch (err) {
        next(err)
    }
})

postsRouter.delete("/:id", async (req, res, next) => {
    try {
        await Comment.deleteMany({ postId: req.params.id })
        const post = await Post.findByIdAndDelete(req.params.id)
        if (!post) return res.status(404).json({ error: "not found" })
        res.status(200).json({ ok: true })
    } catch (err) {
        next(err)
    }
})

postsRouter.use("/:postId/comments", commentsRouter)

const app = express()
app.use(express.json())
app.use("/posts", postsRouter)

app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message || "internal error" })
})

module.exports = { app, Post, Comment }
