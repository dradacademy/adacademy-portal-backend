const mongoose = require("mongoose");
const { EXAM_CATEGORIES } = require("../constants/examCategories");

const subtopicSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

const subjectSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
    },
    // Which of the four exam categories this subject belongs to. Required
    // going forward — this is what lets a student's own `category` (see
    // userModel.js) scope which subjects/exams they can ever see, so a
    // TNPSC AE subject is simply invisible to a GATE-category student.
    category: {
      type: String,
      required: true,
      enum: EXAM_CATEGORIES,
    },
    subtopics: [subtopicSchema],
  },
  { timestamps: true }
);

subjectSchema.index({ category: 1 });

const Subject = mongoose.model("Subject", subjectSchema);

module.exports = Subject;
