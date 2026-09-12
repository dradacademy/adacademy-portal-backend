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
    level: {
      type: Number,
      required: true,
      enum: [1, 2, 3, 4],
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
examSchema.index({ subject: 1, subTopic: 1, level: 1 }); // For exam lookups
examSchema.index({ status: 1 }); // For active exam queries

module.exports = mongoose.model("Exam", examSchema);
