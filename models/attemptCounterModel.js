const mongoose = require("mongoose");

const attemptCounterSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    examId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Exam",
      required: true,
    },
    currentAttempt: {
      type: Number,
      default: 0,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Unique constraint to ensure one counter per user-exam combination
attemptCounterSchema.index({ userId: 1, examId: 1 }, { unique: true });

module.exports = mongoose.model("AttemptCounter", attemptCounterSchema);
