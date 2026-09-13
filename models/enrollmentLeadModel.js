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
    targetExam: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
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
