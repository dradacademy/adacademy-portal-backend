const mongoose = require("mongoose");

// One mistake mark, click-pinned by the admin onto one of the student's
// uploaded answer-sheet page images. Coordinates are PERCENTAGE-based
// (0-100, relative to the image's own displayed width/height) rather than
// raw pixels, so a pin stays correctly placed regardless of what size the
// image happens to render at in the browser (admin review screen vs a
// student's phone).
const mistakeSchema = new mongoose.Schema(
  {
    imageIndex: {
      type: Number,
      required: true,
    },
    type: {
      type: String,
      enum: ["silly", "concept", "application"],
      required: true,
    },
    xPercent: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    yPercent: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    note: {
      type: String,
      default: "",
    },
    markedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

// A student's handwritten-answer-sheet submission for one exam (optionally
// tied to a specific attempt). Images live in GridFS (bucket "appFiles" —
// see utils/gridfsHelper.js), referenced here only by file id + filename/
// content type, matching the same pattern as attachmentModel.js.
const answerSheetSchema = new mongoose.Schema(
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
      index: true,
    },
    // Which attempt this upload corresponds to, if the student had more
    // than one — purely informational, not a uniqueness key (a student may
    // upload more than once for the same attempt if they made a mistake).
    attemptNumber: {
      type: Number,
      default: null,
    },
    images: [
      {
        gridFsFileId: { type: mongoose.Schema.Types.ObjectId, required: true },
        fileName: { type: String, required: true },
        contentType: { type: String, required: true },
      },
    ],
    mistakes: [mistakeSchema],
    reviewed: {
      type: Boolean,
      default: false,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

answerSheetSchema.index({ examId: 1, userId: 1, createdAt: -1 });

module.exports = mongoose.model("AnswerSheet", answerSheetSchema);
