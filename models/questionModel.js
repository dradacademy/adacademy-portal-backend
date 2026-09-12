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
