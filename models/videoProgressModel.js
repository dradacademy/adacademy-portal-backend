const mongoose = require("mongoose");

// Per-student, per-video watch-time rollup. Deliberately lean: just the
// counters the admin's Video Analytics view and the student's "Continue
// Watching" banner need (session count, total watched seconds, last
// position, last watched date) — no per-session log table, since the
// requirement only asks for rolled-up totals, not a full session history.
//
// percentWatched is DERIVED at read time (min(100, totalWatchSeconds /
// video.durationSeconds * 100)), never stored, so it can't drift if a
// video's duration is corrected later after upload processing.
const videoProgressSchema = new mongoose.Schema(
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
    lastPositionSeconds: {
      type: Number,
      default: 0,
    },
    // Simple sum of session lengths (e.g. 30 + 20 + 10 = 60 minutes
    // watched), matching the admin's worked example literally — NOT capped
    // to the video's duration here (the cap is applied only when deriving
    // percentWatched), so a student who rewatches the same section more
    // than once still gets full credit for total time spent.
    totalWatchSeconds: {
      type: Number,
      default: 0,
    },
    sessionCount: {
      type: Number,
      default: 0,
    },
    lastWatchedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

videoProgressSchema.index({ userId: 1, videoId: 1 }, { unique: true });

const derivePercentWatched = (progress, durationSeconds) => {
  if (!progress || !durationSeconds || durationSeconds <= 0) return 0;
  return Math.min(100, (progress.totalWatchSeconds / durationSeconds) * 100);
};

const VideoProgressModel = mongoose.model("VideoProgress", videoProgressSchema);

module.exports = VideoProgressModel;
module.exports.derivePercentWatched = derivePercentWatched;
