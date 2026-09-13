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
    // How many attempts this student is allowed on this exam. Defaults to
    // 1 (the normal "attempt once" rule) — an admin can raise this for a
    // specific student+exam pair to grant a second (or further) attempt,
    // via the Controllers/Control Panel. This is the ONLY way a student
    // ever gets more than one attempt; students can never raise this
    // themselves.
    maxAllowedAttempts: {
      type: Number,
      default: 1,
      required: true,
    },
    grantedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    grantedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Unique constraint to ensure one counter per user-exam combination
attemptCounterSchema.index({ userId: 1, examId: 1 }, { unique: true });

module.exports = mongoose.model("AttemptCounter", attemptCounterSchema);
