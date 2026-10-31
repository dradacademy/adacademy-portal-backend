const mongoose = require("mongoose");
const { EXAM_CATEGORIES } = require("../constants/examCategories");

// A currently-running (or past) live class, streamed on the admin's own
// YouTube Live and referenced here by its video ID — same embed mechanism
// as RecordedClass (see recordedClassModel.js), just for an ongoing stream
// instead of an on-demand recording. There is no separate "live" hosting
// system: a YouTube Live broadcast gets a normal YouTube video ID the same
// way any upload does, so the same YouTube IFrame Player embed + the same
// category+enrollment access gate (see controllers/liveClassController.js)
// apply unchanged.
//
// Lifecycle is manual, not scheduled: the admin starts one (active: true)
// when going live and ends it (active: false, endedAt set) when the class
// finishes. Starting a new live class for a category that already has one
// active automatically ends the previous one first (see
// createLiveClass in the controller) — a category only ever has at most
// one live class in progress at a time. After a class ends, the admin
// separately adds it to Recorded Classes if they want it kept on-demand —
// this model and RecordedClass are intentionally independent, since a live
// session (transient, no duration known upfront) and a recording (durable,
// with a visibility window) have different lifecycles.
const liveClassSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      enum: EXAM_CATEGORIES,
      required: true,
    },
    subject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      default: null,
    },
    // Subtopic + Theory/Problems (2026-10-31) — chosen on Go Live and
    // copied onto the recording that End Live creates.
    subtopic: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    subtopicName: {
      type: String,
      default: "",
      trim: true,
    },
    // Which part of the subtopic this class covers (2026-10-31): "theory",
    // "both" (theory + problems in one class),
    // "problems", or "" (not set). Grouping/filtering only.
    part: {
      type: String,
      enum: ["", "theory", "problems", "both"],
      default: "",
    },
    youtubeVideoId: {
      type: String,
      required: true,
      trim: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
    startedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    startedAt: {
      type: Date,
      default: Date.now,
    },
    endedAt: {
      type: Date,
      default: null,
    },
    // Optional real class length set by the admin (Edit Live Class). When
    // set, it is used instead of the Go Live -> End Live time for attendance
    // (see utils/liveSession.js) — e.g. when End Live was pressed late.
    durationSeconds: {
      type: Number,
      default: null,
    },
    // How long the REPLAY stays watchable for students once this class
    // ends and is added to Recorded Classes — chosen on the Go Live form
    // (or later via Edit) and copied onto that recording. Same rule as
    // RecordedClass (see utils/classAvailability.js): N days counted from
    // the class date (startedAt), or until a chosen date, or never.
    visibilityWindowDays: {
      type: Number,
      default: 7,
      min: 0,
    },
    availableUntil: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

liveClassSchema.index({ category: 1, active: 1 });

// How long this session has actually run so far — the denominator for a
// student's live watch percentage (see liveAttendanceModel.js /
// controllers/liveClassController.js). While still active this is a
// moving target (now - startedAt); once ended it's fixed (endedAt -
// startedAt). Never zero, so a percentage calculation never divides by 0.
liveClassSchema.methods.getElapsedSeconds = function () {
  const end = this.endedAt || new Date();
  const seconds = (end.getTime() - new Date(this.startedAt).getTime()) / 1000;
  return Math.max(1, Math.round(seconds));
};

module.exports = mongoose.model("LiveClass", liveClassSchema);
