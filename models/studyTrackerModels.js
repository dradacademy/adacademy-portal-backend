const mongoose = require("mongoose");

// Daily Study Tracker (TNPSC JDO) — 2026-10-28. See constants/studyTracker.js.

// One settings document for the whole feature.
const poolRefSchema = new mongoose.Schema(
  {
    subject: { type: mongoose.Schema.Types.ObjectId, ref: "Subject", required: true },
    subTopic: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { _id: false }
);

const configSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "study-tracker-config" },
    enabled: { type: Boolean, default: true },
    quizQuestionCount: { type: Number, default: 10, min: 3, max: 30 },
    passPercent: { type: Number, default: 75, min: 1, max: 100 },
    // IST "HH:MM" — from this time each day the student is reminded to
    // send today's update until they do.
    reminderTime: { type: String, default: "17:30" },
    // Every portal test is written as 50 questions/marks, whatever the bank
    // holds, so test % = marks obtained / testTotalMarks.
    testTotalMarks: { type: Number, default: 50, min: 1 },
    // Latest allowed target date when a student fills a missing one.
    gsExamDate: { type: String, default: "2026-11-15" },
    civilExamDate: { type: String, default: "2026-11-22" },
    // Question sources for each check: key "GS::Polity::New notes".
    // Stored as a list (not a Map) because unit names contain dots, which
    // MongoDB map keys can't hold.
    questionPools: {
      type: [new mongoose.Schema({ key: { type: String, required: true }, refs: { type: [poolRefSchema], default: [] } }, { _id: false })],
      default: [],
    },
    // Which test subjects count as which test type for the averages.
    // subjectId -> "GS" | "Civil" | "Apt & Lang". Unlisted subjects are ignored.
    testSubjectTypes: { type: Map, of: String, default: {} },
    // Who gets the feature. Never saved yet (undefined) = every TNPSC JDO
    // student. Once the admin saves the list, ONLY these students get it
    // (any course).
    studentIds: { type: [mongoose.Schema.Types.ObjectId], ref: "User", default: undefined },
  },
  { timestamps: true }
);

// Target dates — set by the admin only.
const planSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    // [{ key, date: "YYYY-MM-DD" }] (IST day). Keys: GS/Civil unit names, or
    // "Aptitude" / "Language" for those whole subjects. A list, not a Map,
    // because unit names contain dots.
    dates: {
      type: [new mongoose.Schema({ key: { type: String, required: true }, date: { type: String, required: true } }, { _id: false })],
      default: [],
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// One accepted progress report: "this material of this unit is now X% done".
const entrySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    day: { type: String, required: true }, // "YYYY-MM-DD" IST
    subject: { type: String, required: true },
    unit: { type: String, required: true },
    material: { type: String, required: true },
    percent: { type: Number, required: true }, // 0.25 / 0.5 / 0.75 / 1
    topics: { type: String, default: "" },
    // How the report was accepted:
    //   quiz      — passed the random-question check
    //   no_quiz   — no questions are linked to this unit yet, so it was
    //               accepted without a check (shown to the admin)
    //   migrated  — copied from the old tracker page (before the portal)
    //   admin     — entered or corrected by the admin
    source: { type: String, enum: ["quiz", "no_quiz", "migrated", "admin"], required: true },
    quizAttempt: { type: mongoose.Schema.Types.ObjectId, ref: "StudyQuizAttempt", default: null },
  },
  { timestamps: true }
);
entrySchema.index({ userId: 1, subject: 1, unit: 1, material: 1 });
entrySchema.index({ day: 1 });

// Every check a student started — passed or not.
const quizAttemptSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    day: { type: String, required: true },
    subject: { type: String, required: true },
    unit: { type: String, required: true },
    material: { type: String, required: true },
    claimedPercent: { type: Number, required: true },
    topics: { type: String, default: "" },
    questionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Question" }],
    answers: { type: [mongoose.Schema.Types.Mixed], default: [] },
    correct: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    scorePercent: { type: Number, default: null },
    passPercent: { type: Number, required: true },
    passed: { type: Boolean, default: false },
    submittedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
quizAttemptSchema.index({ day: 1 });

// Per-student flags (intro popup seen, etc).
const studentStateSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    introSeenAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = {
  StudyTrackerConfig: mongoose.model("StudyTrackerConfig", configSchema),
  StudyPlan: mongoose.model("StudyPlan", planSchema),
  StudyEntry: mongoose.model("StudyEntry", entrySchema),
  StudyQuizAttempt: mongoose.model("StudyQuizAttempt", quizAttemptSchema),
  StudyStudentState: mongoose.model("StudyStudentState", studentStateSchema),
};
