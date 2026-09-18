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
  },
  { timestamps: true }
);

liveClassSchema.index({ category: 1, active: 1 });

module.exports = mongoose.model("LiveClass", liveClassSchema);
