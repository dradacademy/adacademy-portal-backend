const mongoose = require("mongoose");

// One row per one-time maintenance task that has already run (e.g. the
// October 2026 "make every existing class available for 14 days" grant —
// see utils/oneTimeAvailabilityGrant.js). The row's existence is the
// "already done" marker, so the task never runs twice, even across
// restarts or several server instances starting at once (_id is unique).
const systemFlagSchema = new mongoose.Schema(
  {
    _id: { type: String },
    doneAt: { type: Date, default: Date.now },
    details: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SystemFlag", systemFlagSchema);
