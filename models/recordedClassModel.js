const mongoose = require("mongoose");
const { EXAM_CATEGORIES } = require("../constants/examCategories");

// A single recorded class, stored permanently in Cloudflare Stream (see
// utils/cloudflareStream.js) instead of the previous YouTube-Live-with-
// 1-day-retention workflow. Access is gated by category match (this field)
// PLUS an active, non-expired enrollmentModel record for that student —
// see controllers/videoPlaybackController.js.
const recordedClassSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },
    // Which exam category this recording belongs to — the same isolation
    // key already used for exams/subjects (see constants/examCategories.js).
    category: {
      type: String,
      enum: EXAM_CATEGORIES,
      required: true,
    },
    // Optional, for grouping/filtering only — does NOT gate access (that's
    // category + enrollment).
    subject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      default: null,
    },
    // Cloudflare Stream's video UID — the only identifier we need to hand
    // back to Cloudflare for playback tokens, deletion, or webhook lookups.
    cloudflareVideoUid: {
      type: String,
      required: true,
      unique: true,
    },
    // Filled in once Cloudflare finishes processing (see the webhook
    // handler in recordedClassController.js).
    durationSeconds: {
      type: Number,
      default: null,
    },
    status: {
      type: String,
      enum: ["uploading", "processing", "ready", "error"],
      default: "uploading",
    },
    recordedDate: {
      type: Date,
      required: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // Soft-delete/retire flag. Kept false-but-present (never hard-deleted)
    // so watch-history/analytics rows referencing this video keep working
    // after retirement, and so the retention job (see below) has a history
    // row to point to.
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

recordedClassSchema.index({ category: 1, active: 1 });

module.exports = mongoose.model("RecordedClass", recordedClassSchema);
