const mongoose = require("mongoose");

// Singleton settings for the Pending Videos popup (same fixed-_id pattern as
// progressWeightConfigModel.js). Lets the admin switch the popup off at any
// time from the Video Tracker page without a new deploy.
const videoCommitmentConfigSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "video-commitment-config" },
    popupEnabled: { type: Boolean, default: true },
    // Longest a student may push a date into the future (days from today).
    maxDaysAhead: { type: Number, default: 30, min: 1, max: 365 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("VideoCommitmentConfig", videoCommitmentConfigSchema);
