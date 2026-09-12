const mongoose = require("mongoose");

const examSchema = new mongoose.Schema(
  {
    subject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      required: true,
    },
    subTopic: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    questions: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Question",
      },
    ],
    poolQuestions: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Question",
      },
    ],
    // Position of this exam within its subject+subTopic sequence (1, 2, 3...).
    // Replaces the old single `level` field — an exam can now freely mix
    // questions of different levels (each Question carries its own level),
    // and progression/unlocking is based on this order instead of level.
    order: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      required: true,
      enum: ["active", "inactive"],
    },
    examCode: {
      type: String,
      unique: true,
      required: true,
    },
    passPercentage: {
      type: Number,
      default: 90,
    },
    shuffleQuestion: {
      type: Boolean,
      default: false,
    },
    questionSelection: {
      MCQ: {
        startIndex: { type: Number, default: 0 },
        count: { type: Number, default: 0 },
      },
      MSQ: {
        startIndex: { type: Number, default: 0 },
        count: { type: Number, default: 0 },
      },
      "Fill in the Blanks": {
        startIndex: { type: Number, default: 0 },
        count: { type: Number, default: 0 },
      },
      "Short Answer": {
        startIndex: { type: Number, default: 0 },
        count: { type: Number, default: 0 },
      },
    },
    questionSets: [
      {
        name: { type: String, required: true },
        selectionType: {
          type: String,
          enum: ["manual", "random"],
          default: "manual",
        },
        questions: [{ type: mongoose.Schema.Types.ObjectId, ref: "Question" }], // For manual selection
        count: { type: Number, default: 0 }, // For random selection
        config: {
          // For random selection criteria configuration per type
          MCQ: { count: Number },
          MSQ: { count: Number },
          "Fill in the Blanks": { count: Number },
          "Short Answer": { count: Number },
        },
      },
    ],
    activeQuestionSetId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Performance indexes for common queries
examSchema.index({ subject: 1, subTopic: 1, order: 1 }, { unique: true }); // For exam lookups + ordering
examSchema.index({ status: 1 }); // For active exam queries

module.exports = mongoose.model("Exam", examSchema);
