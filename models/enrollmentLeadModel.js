const mongoose = require("mongoose");

// Captures leads from the public "Enroll Now" form on the marketing site.
// This is intentionally simple — no auth, no relation to the User model —
// since a prospective student fills this out before they have any account.
const enrollmentLeadSchema = new mongoose.Schema(
  {
    studentName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    mobileNumber: {
      type: String,
      required: true,
      trim: true,
      maxlength: 20,
    },
    // Not required at the schema level — a quick "Request a Callback"
    // submission (source: "callback_request") intentionally skips this
    // field to keep that flow to just name + mobile. The controller still
    // requires it for the full "enroll_form" submission.
    targetExam: {
      type: String,
      trim: true,
      maxlength: 120,
      default: null,
    },
    // Distinguishes the full enrollment-interest form from the quick
    // "Request a Callback" button — both write to this same collection so
    // the admin has one place to see every inbound lead.
    source: {
      type: String,
      enum: ["enroll_form", "callback_request"],
      default: "enroll_form",
    },
    // Set once an admin has followed up on this lead — not exposed on the
    // public form; a future admin view can flip this via a separate route.
    contacted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("EnrollmentLead", enrollmentLeadSchema);
