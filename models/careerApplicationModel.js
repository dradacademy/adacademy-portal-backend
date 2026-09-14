const mongoose = require("mongoose");

// Captures submissions from the public /careers application form.
// Intentionally simple and unrelated to the User model — an applicant
// has no account, and never will unless the academy hires them and
// separately creates one.
const careerApplicationSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    contactNumber: {
      type: String,
      required: true,
      trim: true,
      maxlength: 20,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 150,
    },
    qualification: {
      type: String,
      trim: true,
      maxlength: 150,
      default: "",
    },
    college: {
      type: String,
      trim: true,
      maxlength: 200,
      default: "",
    },
    cgpa: {
      type: String,
      trim: true,
      maxlength: 30,
      default: "",
    },
    // Cloudinary URL, uploaded client-side (resource_type=raw, same
    // unsigned-preset pattern already used for question/content images —
    // see ContentManagementAdminPage.jsx). Optional: the applicant may
    // submit without a resume if the upload fails or they skip it, per
    // careerApplicationController.js.
    resumeUrl: {
      type: String,
      trim: true,
      default: null,
    },
    gateQualified: {
      type: Boolean,
      default: false,
    },
    // Only meaningful when gateQualified is true — not enforced required
    // at the schema level since it's conditional on that flag.
    gateScore: {
      type: String,
      trim: true,
      maxlength: 30,
      default: "",
    },
    experience: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },
    subjects: {
      type: [String],
      default: [],
    },
    // Set once an admin has reviewed/followed up — not exposed on the
    // public form; a future admin view can flip this via a separate route,
    // same pattern as EnrollmentLead.contacted.
    contacted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CareerApplication", careerApplicationSchema);
