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
    // Index-based identity for MCQ/MSQ correct-answer options, parallel to
    // (and preferred over) the text-based `correctAnswers` above. Solves the
    // "duplicate/blank option text" collision: two options with identical
    // text (the normal case for image-only options) can't be told apart by
    // comparing text, but their positions are always unambiguous. When this
    // array is present it is the authoritative source of truth for grading
    // and for the admin-builder / student UI's "which option is selected"
    // display; `correctAnswers` is then kept only as a derived text mirror
    // (for export/legacy display) rebuilt from these indexes. Left
    // `undefined` for every question created/saved before this field
    // existed (and for non-MCQ/MSQ question types) — all grading and UI
    // code falls back to the legacy text-based comparison whenever this is
    // absent, so no backfill/migration is required.
    correctOptionIndexes: {
      type: [Number],
      default: undefined,
    },
    // Only meaningful for questionType "Fill in the Blanks" — flips the
    // student-facing input from a plain text box to the on-screen numeric
    // keypad (digits, ., -, backspace, clear) used for GATE-style Numerical
    // Answer Type (NAT) questions, and switches grading to compare the
    // answer as a NUMBER instead of an exact string (see
    // ExamSubmissionHelper.js) so "2.3" and "2.30" are treated the same.
    isNumericAnswer: {
      type: Boolean,
      default: false,
    },
    // NAT range-grading support (only meaningful when isNumericAnswer is
    // true): when natAnswerMode is "range", any submitted numeric value
    // within [rangeMin, rangeMax] inclusive is graded correct instead of
    // requiring an exact match against `correctAnswers` — e.g. a range of
    // "10 to 15" accepts 10, 12.5, and 15 all as correct. rangeMin/rangeMax
    // are stored as strings (not Number) so the same scientific/power
    // notations already accepted for exact NAT answers ("1e-3", "10^-7",
    // ...) — see ExamSubmissionHelper.js's parseNumericAnswer — work here
    // too. Left null whenever natAnswerMode is "exact" (the default), so an
    // exact-mode question never carries stale range data from an earlier
    // edit.
    natAnswerMode: {
      type: String,
      enum: ["exact", "range"],
      default: "exact",
    },
    rangeMin: {
      type: String,
      default: null,
    },
    rangeMax: {
      type: String,
      default: null,
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
