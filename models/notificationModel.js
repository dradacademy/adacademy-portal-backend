const mongoose = require("mongoose");
const { EXAM_CATEGORIES } = require("../constants/examCategories");

// A single notification fired whenever the admin posts something new for
// students to know about — a fresh recorded class, a newly posted test, a
// new attachment, or a direct announcement. `category: null` means "every
// student" (used for a global announcement); otherwise it only reaches
// students in that one category, same isolation key used everywhere else.
//
// There's no separate per-notification "read" table — see userModel.js's
// `lastSeenNotificationsAt`: a notification counts as unread/new for a
// student until they've opened the notification panel at least once after
// it was created (a single rolling watermark per student, not a per-item
// read receipt). That's what makes something "available at the front page
// the first time they see it," per the admin's request.
const notificationSchema = new mongoose.Schema(
  {
    category: {
      type: String,
      enum: EXAM_CATEGORIES,
      default: null,
    },
    type: {
      type: String,
      enum: ["video", "test", "attachment", "announcement"],
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      default: "",
    },
    // Optional pointer to the thing this notification is about (a
    // RecordedClass, Exam, or Attachment id) — not populated/validated
    // against a real ref since refModel varies; the frontend only ever
    // uses this to decide which page to link to, not to fetch it directly.
    refId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    refModel: {
      type: String,
      enum: ["RecordedClass", "Exam", "Attachment"],
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

notificationSchema.index({ category: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", notificationSchema);
