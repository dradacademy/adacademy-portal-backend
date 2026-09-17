const mongoose = require("mongoose");
const { EXAM_CATEGORIES } = require("../constants/examCategories");

// A single recorded class, hosted on the admin's own YouTube account (as an
// Unlisted video) and referenced here by its video ID — replacing both the
// original YouTube-Live-with-1-day-retention workflow AND a first draft of
// this feature built on Cloudflare Stream, which the admin decided against
// in favor of continuing to use YouTube. Access is gated by category match
// (this field) PLUS an active, non-expired enrollmentModel record for that
// student — see controllers/videoPlaybackController.js. Note the real
// tradeoff versus the Cloudflare Stream approach: a YouTube embed has no
// on-page download button, but it is not true DRM-protected streaming —
// there is no way to fully prevent a determined viewer from capturing the
// video by other means. The enrollment/category gate controls who gets
// in-app access to watch it, not what they can do with it afterward.
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
    // The 11-character YouTube video ID (extracted from whatever URL format
    // the admin pastes — watch?v=, youtu.be/, embed/, shorts/ — see
    // utils/youtube.js). This is the only identifier needed to embed the
    // video via the YouTube IFrame Player.
    youtubeVideoId: {
      type: String,
      required: true,
      trim: true,
    },
    // Admin-entered (YouTube's public Data API isn't used here to avoid a
    // separate API-key setup just for this) — optional; when left blank,
    // percent-watched in analytics simply isn't computable (shown as "—")
    // until the admin fills it in via edit.
    durationSeconds: {
      type: Number,
      default: null,
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
    // Soft-delete/retire flag — hides it from students without losing the
    // watch-history/analytics rows that reference it.
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

recordedClassSchema.index({ category: 1, active: 1 });

module.exports = mongoose.model("RecordedClass", recordedClassSchema);
