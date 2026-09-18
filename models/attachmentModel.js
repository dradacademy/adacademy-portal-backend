const mongoose = require("mongoose");
const { EXAM_CATEGORIES } = require("../constants/examCategories");

// A single admin-uploaded study material file (PDF/PPT/Word), stored inside
// MongoDB itself via GridFS (see utils/gridfsHelper.js) rather than a
// separate paid file-hosting service — the admin's explicit instruction was
// "give provision to upload from my side... if i upload students can able
// to view", not to pursue a paid/complex DRM locking solution. Access is
// gated the same way recorded classes are: category match + an active,
// non-expired Enrollment record (see controllers/attachmentController.js).
//
// Honest limitation, same as the recorded-class video system: the in-app
// viewer has no download button, but this is not true DRM — there's no way
// to fully stop a determined viewer from capturing the content by other
// means (a screenshot, a PDF-print-to-file, etc). It controls the easy,
// obvious path (no direct file link, no download button anywhere in the UI),
// not every possible path.
const attachmentSchema = new mongoose.Schema(
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
    category: {
      type: String,
      enum: EXAM_CATEGORIES,
      required: true,
    },
    // Optional, for grouping/filtering only — does NOT gate access.
    subject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      default: null,
    },
    fileName: {
      type: String,
      required: true,
    },
    contentType: {
      type: String,
      required: true,
    },
    fileSize: {
      type: Number,
      default: 0,
    },
    // The GridFS file's own _id (bucket "appFiles" — see gridfsHelper.js).
    gridFsFileId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // Soft-delete/retire flag — hides it from students without losing the
    // view-history rows (AttachmentProgress) that reference it.
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

attachmentSchema.index({ category: 1, active: 1 });

module.exports = mongoose.model("Attachment", attachmentSchema);
