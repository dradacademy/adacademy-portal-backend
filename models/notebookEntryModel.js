const mongoose = require("mongoose");

// One row per (student, question) for the "My Mistakes" notebook
// (2026-10-08): bookmark flag, "mastered" flag (student marked a mistake as
// learnt), and practice-reattempt counters. Mistakes themselves are not
// stored here — they are read live from the student's latest completed
// attempts, so this only holds what the student chose to do with them.
const notebookEntrySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    questionId: { type: mongoose.Schema.Types.ObjectId, ref: "Question", required: true },
    examId: { type: mongoose.Schema.Types.ObjectId, ref: "Exam", default: null },
    bookmarked: { type: Boolean, default: false },
    mastered: { type: Boolean, default: false },
    practiceCount: { type: Number, default: 0 },
    lastPracticeCorrect: { type: Boolean, default: null },
    lastPracticedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

notebookEntrySchema.index({ userId: 1, questionId: 1 }, { unique: true });

module.exports = mongoose.model("NotebookEntry", notebookEntrySchema);
