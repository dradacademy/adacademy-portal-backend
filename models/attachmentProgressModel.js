const mongoose = require("mongoose");

// Per-student, per-attachment view tracking — deliberately lean, matching
// videoProgressModel.js's shape. "Completion" for an attachment is simply
// binary (viewed at least once, or not — there's no percentage to track for
// a document the way there is watch-time for a video), so viewCount > 0 is
// the one signal the Student Progress dashboard's "attachment completion"
// figure reads.
const attachmentProgressSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    attachmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Attachment",
      required: true,
      index: true,
    },
    viewCount: {
      type: Number,
      default: 0,
    },
    firstViewedAt: {
      type: Date,
      default: null,
    },
    lastViewedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

attachmentProgressSchema.index({ userId: 1, attachmentId: 1 }, { unique: true });

module.exports = mongoose.model("AttachmentProgress", attachmentProgressSchema);
