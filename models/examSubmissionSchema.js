const mongoose = require("mongoose");

const ExamSubmissionSchema = new mongoose.Schema(
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
    attemptNumber: {
      type: Number,
      required: true,
    },
    examData: [
      {
        questionId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Question",
          required: true,
        },
        studentAnswer: {
          type: mongoose.Schema.Types.Mixed, // Supports multiple answer types
          // required: true,
        },
        // Index-based identity for the option(s) the student actually
        // clicked on an MCQ/MSQ question, parallel to (and preferred over)
        // the text-based `studentAnswer` above — see the matching comment on
        // Question.correctOptionIndexes for why this exists (duplicate/blank
        // option text can't be told apart by comparing text). Mongoose drops
        // any field not declared on a subdocument schema, so this MUST be
        // listed here explicitly to persist. `undefined`/absent for every
        // submission recorded before this field existed, and for non-MCQ/MSQ
        // answers — grading and display fall back to text-based comparison
        // whenever it's missing on either side.
        studentAnswerIndexes: {
          type: [Number],
          default: undefined,
        },
        correctAnswer: {
          type: mongoose.Schema.Types.Mixed, // Supports multiple answer types
        },
        isRight: {
          type: String,
          enum: ["Correct", "Incorrect", "Partially Correct", "Skipped"],
          default: "Skipped",
        },
      },
    ],
    timetaken: {
      type: Number,
      default: 0, // Time taken in seconds
    },
    obtainedMark: {
      type: Number,
      default: 0,
    },
    pass: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ["started", "completed"],
      default: "completed", // Default to completed for backward compatibility
    },
    // Explicit timestamp for when this submission was graded/completed.
    // Deliberately separate from `updatedAt`, which also shifts whenever a
    // review is added later — completedAt is set once, at submit time, and
    // never touched again, so it's safe to use for "attended date" and
    // on-time/late tracking in the Test Tracking dashboards.
    completedAt: {
      type: Date,
      default: null,
    },
    // Speed % = (questions attended / total questions) * 100. Populated at
    // grading time in submitExam. Null until then.
    speedPercent: {
      type: Number,
      default: null,
    },
    // Accuracy % = (correct answers / questions attended) * 100. Null when
    // the student attended zero questions (undefined, not zero).
    accuracyPercent: {
      type: Number,
      default: null,
    },
    reviews: [
      {
        evaluator: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        message: {
          type: String,
          required: true,
        },
      },
    ],
  },
  { timestamps: true }
);

ExamSubmissionSchema.path("reviews").schema.set("timestamps", true);

// Unique constraint to prevent duplicate submissions per attempt
ExamSubmissionSchema.index({ userId: 1, examId: 1, attemptNumber: 1 }, { unique: true });

// Performance indexes for common queries
ExamSubmissionSchema.index({ examId: 1, status: 1 }); // For checking active submissions
ExamSubmissionSchema.index({ userId: 1, pass: 1 }); // For pass/fail queries
ExamSubmissionSchema.index({ status: 1, createdAt: -1 }); // For status-based queries
ExamSubmissionSchema.index({ pass: 1, examId: 1 }); // For pass statistics

module.exports = mongoose.model("ExamSubmission", ExamSubmissionSchema);
