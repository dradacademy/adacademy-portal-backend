const mongoose = require("mongoose");

// A student's doubt on one question of a completed test (2026-10-08).
// Only eligible students can create one (utils/doubtEligibility.js); the
// admin answers from the Doubts inbox and the student gets a personal
// notification.
const doubtSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    questionId: { type: mongoose.Schema.Types.ObjectId, ref: "Question", required: true },
    examId: { type: mongoose.Schema.Types.ObjectId, ref: "Exam", required: true },
    examSubmissionId: { type: mongoose.Schema.Types.ObjectId, ref: "ExamSubmission", required: true },
    category: { type: String, default: null },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    status: { type: String, enum: ["open", "answered", "closed"], default: "open", index: true },
    reply: { type: String, default: "", maxlength: 5000 },
    repliedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    repliedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

doubtSchema.index({ status: 1, createdAt: -1 });
doubtSchema.index({ userId: 1, examSubmissionId: 1 });

module.exports = mongoose.model("Doubt", doubtSchema);
