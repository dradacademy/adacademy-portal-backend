const mongoose = require("mongoose");

// "I will finish watching this video by <date>" — the date a student
// promised in the Pending Videos popup (2026-10-28). One row per student per
// recorded class. The popup appears every time a student opens the app and
// they can't continue until every pending video has a date that hasn't
// passed yet. The admin's Video Tracker uses these rows to show who kept
// their promise and who didn't.
//
// Status is never stored — it is worked out when read (see
// utils/videoCommitments.js) from targetDate, completedAt and the student's
// live watch %, so it can't go stale.
const historySchema = new mongoose.Schema(
  {
    targetDate: { type: Date, required: true },
    setAt: { type: Date, required: true },
    // true when this date had already passed (promise broken) before the
    // student replaced it with a new one.
    missed: { type: Boolean, default: false },
  },
  { _id: false }
);

const videoCommitmentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    videoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RecordedClass",
      required: true,
      index: true,
    },
    // 11:59:59 PM IST on the day the student picked.
    targetDate: { type: Date, required: true },
    // The very first date promised for this video (never changes).
    firstTargetDate: { type: Date, required: true },
    // When the current date was set.
    setAt: { type: Date, default: Date.now },
    // Older dates, oldest first.
    history: { type: [historySchema], default: [] },
    // How many times a promised date passed without the video being
    // finished (each one counted when the student had to pick a new date).
    missedCount: { type: Number, default: 0 },
    // How many times the student changed the date in total.
    changeCount: { type: Number, default: 0 },
    // First moment the video reached the "completed" watch % — stamped by
    // the progress ping (controllers/videoPlaybackController.js).
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

videoCommitmentSchema.index({ userId: 1, videoId: 1 }, { unique: true });

module.exports = mongoose.model("VideoCommitment", videoCommitmentSchema);
