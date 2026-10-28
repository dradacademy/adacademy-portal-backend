const mongoose = require("mongoose");

// "Count this recorded class as watched" even though the app didn't measure
// it (2026-10-28). Needed because students used to tap the YouTube logo in
// the player and watch on YouTube itself, where the app can't see them —
// YouTube never tells us WHICH student watched, so that past viewing can't
// be fetched. Two sources:
//   "student" — the student ticked "I already watched this fully on
//               YouTube" in the Pending Videos popup (their word, shown to
//               the admin in purple as "Says watched").
//   "admin"   — the admin marked it watched on the Video Tracker.
// Deleting the row (admin "Undo") puts the video back in the student's
// pending list. The measured watch % is never changed by this.
const videoWatchOverrideSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    videoId: { type: mongoose.Schema.Types.ObjectId, ref: "RecordedClass", required: true, index: true },
    source: { type: String, enum: ["student", "admin"], required: true },
    markedAt: { type: Date, default: Date.now },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

videoWatchOverrideSchema.index({ userId: 1, videoId: 1 }, { unique: true });

module.exports = mongoose.model("VideoWatchOverride", videoWatchOverrideSchema);
