const mongoose = require("mongoose");

// Singleton config (same fixed-_id pattern as models/markModel.js) — the
// admin-configurable weighting for the Student Progress dashboard's
// "Overall Progress %" figure: examWeight/videoWeight/attachmentWeight are
// combined as a weighted average of each category's own completion
// percentage. They don't need to sum to 100 — the helper that consumes this
// (utils/studentProgressHelper.js) always divides by their actual sum, so
// e.g. 2/2/1 behaves identically to 40/40/20.
//
// Defaults (40/40/20) were chosen as a reasonable starting point weighting
// exams and videos equally and attachments lighter, since attachment
// "completion" is a much coarser binary signal (viewed or not) than exam
// scores or video watch-time — flagged to the admin as a default they can
// change any time from the dashboard, not a fixed rule.
const progressWeightConfigSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: "progress-weight-config",
    },
    examWeight: {
      type: Number,
      required: true,
      default: 40,
    },
    videoWeight: {
      type: Number,
      required: true,
      default: 40,
    },
    attachmentWeight: {
      type: Number,
      required: true,
      default: 20,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ProgressWeightConfig", progressWeightConfigSchema);
