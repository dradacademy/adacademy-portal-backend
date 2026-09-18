const mongoose = require("mongoose");

// Per-student watch-time tracking for a LiveClass session — the live
// counterpart to videoProgressModel (which tracks recorded-class watch
// time). A live stream's total duration isn't known in advance the way a
// recording's is, so "percent watched" here is computed against the
// session's ELAPSED duration (now - startedAt while still live, or
// endedAt - startedAt once it's over) rather than a stored duration field
// — see liveClassModel.js's getElapsedSeconds().
const liveAttendanceSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    liveClassId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LiveClass",
      required: true,
      index: true,
    },
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

liveAttendanceSchema.index({ userId: 1, liveClassId: 1 }, { unique: true });

module.exports = mongoose.model("LiveAttendance", liveAttendanceSchema);
