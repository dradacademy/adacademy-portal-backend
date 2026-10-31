const mongoose = require("mongoose");

// Live Q&A during live classes (2026-10-28).
// Students type questions beside the live video; the admin sees them within
// a few seconds and marks them answered / pinned / hidden. Unanswered
// questions stay in the admin's "After class" list until replied to.

const liveQuestionSchema = new mongoose.Schema(
  {
    liveClassId: { type: mongoose.Schema.Types.ObjectId, ref: "LiveClass", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // Name shown in the panel, copied when the question is asked.
    name: { type: String, default: "" },
    text: { type: String, required: true, trim: true, maxlength: 500 },
    status: { type: String, enum: ["open", "answered", "hidden"], default: "open", index: true },
    pinned: { type: Boolean, default: false },
    upvotes: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    // Optional written reply (usually after class).
    reply: { type: String, default: "", maxlength: 2000 },
    repliedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
liveQuestionSchema.index({ liveClassId: 1, createdAt: 1 });

// One row per "I didn't understand" tap.
const liveConfusionSchema = new mongoose.Schema(
  {
    liveClassId: { type: mongoose.Schema.Types.ObjectId, ref: "LiveClass", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);
liveConfusionSchema.index({ liveClassId: 1, createdAt: -1 });

module.exports = {
  LiveQuestion: mongoose.model("LiveQuestion", liveQuestionSchema),
  LiveConfusion: mongoose.model("LiveConfusion", liveConfusionSchema),
};

// ── Live quiz (2026-10-28) ──────────────────────────────────────────────
// The teacher posts a question during the live class (MCQ or a numeric
// answer for sums) with a time limit; students answer beside the video and
// earn points that feed the live leaderboard.
const livePollSchema = new mongoose.Schema(
  {
    liveClassId: { type: mongoose.Schema.Types.ObjectId, ref: "LiveClass", required: true, index: true },
    kind: { type: String, enum: ["mcq", "numeric"], required: true },
    text: { type: String, default: "", maxlength: 1000 }, // may be blank: "question is on screen"
    options: { type: [String], default: [] }, // MCQ labels (A–D text, may be blank)
    correctIndex: { type: Number, default: null },
    correctValue: { type: Number, default: null },
    tolerance: { type: Number, default: 0 }, // numeric: accepted ± range
    points: { type: Number, default: 10 },
    timeLimitSec: { type: Number, default: 60 },
    startedAt: { type: Date, default: Date.now },
    closesAt: { type: Date, required: true },
    closedAt: { type: Date, default: null }, // closed early by the teacher
  },
  { timestamps: true }
);

const livePollAnswerSchema = new mongoose.Schema(
  {
    pollId: { type: mongoose.Schema.Types.ObjectId, ref: "LivePoll", required: true },
    liveClassId: { type: mongoose.Schema.Types.ObjectId, ref: "LiveClass", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, default: "" },
    choice: { type: Number, default: null },
    value: { type: Number, default: null },
    correct: { type: Boolean, default: false },
    points: { type: Number, default: 0 },
    ms: { type: Number, default: 0 }, // time taken to answer
  },
  { timestamps: true }
);
livePollAnswerSchema.index({ pollId: 1, userId: 1 }, { unique: true });

module.exports.LivePoll = mongoose.model("LivePoll", livePollSchema);
module.exports.LivePollAnswer = mongoose.model("LivePollAnswer", livePollAnswerSchema);
