const mongoose = require("mongoose");

// Singleton global-config document — same pattern as durationModel.js /
// markModel.js (fixed _id, one document total).
const videoSettingsSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: "video-settings",
    },
    // Retention window, in days, before a recorded class is permanently
    // deleted from Cloudflare Stream storage (cost control — see the
    // plan's cost math). null/0 means "keep forever" (no automatic
    // deletion) — this is the deliberate DEFAULT, so an admin has to
    // explicitly opt in to automatic, irreversible deletion rather than
    // it happening as a surprise.
    videoRetentionDays: {
      type: Number,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("VideoSettings", videoSettingsSchema);
