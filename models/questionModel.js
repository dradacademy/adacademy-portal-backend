const mongoose = require("mongoose");

const QuestionSchema = new mongoose.Schema(
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
    level: {
      type: Number,
      required: true,
      enum: [1, 2, 3, 4],
    },
    questionType: {
      type: String,
      enum: ["MCQ", "Fill in the Blanks", "MSQ", "Short Answer"],
      required: true,
    },
    questionText: {
      type: String,
      required: true,
    },
    options: {
      type: [mongoose.Schema.Types.Mixed], // Array of objects { text: String, image: String } or String (legacy)
      default: undefined, // Only needed for MCQ & MSQ
    },
    correctAnswers: {
      type: [String],
      required: true,
    },
    // Optional per-question overrides. When null, grading/duration logic
    // falls back to the global level-based Mark/Duration config for this
    // question's `level`. This is what lets an admin customize marks,
    // negative marks, and duration individually per question instead of
    // relying on one fixed value for the whole exam/level.
    marks: {
      type: Number,
      default: null,
    },
    negativeMark: {
      type: Number,
      default: null,
    },
    duration: {
      type: Number, // seconds
      default: null,
    },
    image: {
      type: String,
      default: null,
    },
    answerKeyText: {
      type: String,
      default: null,
    },
    answerKeyImage: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Question", QuestionSchema);
