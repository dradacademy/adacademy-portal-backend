const mongoose = require("mongoose");

// Replaces the old userPassSchema (which was keyed by subject+subTopic+level).
// Now that an exam can no longer be identified by a single "level", pass
// records are keyed directly by examId, with subject/subTopic/order kept as
// denormalized fields for convenient querying (e.g. "all passes for this
// subject+subTopic in order").
const examPassSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    examId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Exam",
      required: true,
    },
    subject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      required: true,
    },
    subTopic: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    order: {
      type: Number,
      required: true,
    },
    pass: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

examPassSchema.index({ userId: 1, examId: 1 }, { unique: true });
examPassSchema.index({ userId: 1, subject: 1, subTopic: 1, order: 1 });

module.exports = mongoose.model("ExamPass", examPassSchema);
