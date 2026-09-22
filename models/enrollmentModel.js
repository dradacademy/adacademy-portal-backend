const mongoose = require("mongoose");
const { EXAM_CATEGORIES } = require("../constants/examCategories");

// Course-enrollment validity window for the recorded-class video system.
// Deliberately separate from User.category (which only says WHICH category
// a student belongs to, with no expiry concept) — a video only plays when
// BOTH the category matches AND an active, non-expired Enrollment record
// exists for that student+category. This leaves the existing exam-
// eligibility code path (which only ever checks User.category) completely
// untouched.
//
// "Active" is always computed LIVE (!revoked && validTill >= now), never
// flipped by a scheduled job — so expiry takes effect the instant it
// passes, with nothing that can drift out of sync. See isEnrollmentActive
// below and its use in videoPlaybackController.js.
const enrollmentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    category: {
      type: String,
      enum: EXAM_CATEGORIES,
      required: true,
    },
    validFrom: {
      type: Date,
      default: Date.now,
    },
    validTill: {
      type: Date,
      required: true,
    },
    revoked: {
      type: Boolean,
      default: false,
    },
    // "full" (default, unchanged behavior for every enrollment that
    // predates this field — Mongoose applies the schema default on read)
    // gives the usual lectures + recordings + materials + tests access.
    // "test_series_only" is the admin's new plan for students enrolled
    // just for the online test series: they can still see/attempt every
    // test in this category (checkExamEligibility.js / examFunctionController.js
    // deliberately never check this field), but are blocked from live
    // classes, recorded lectures, and materials — see the accessLevel
    // check in videoPlaybackController.js, liveClassController.js, and
    // attachmentController.js, which all run this check right after their
    // existing isEnrollmentActive check.
    accessLevel: {
      type: String,
      enum: ["full", "test_series_only"],
      default: "full",
    },
    grantedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

// Renewing a student's course simply updates validTill on the same
// document (upsert) — no separate renewal-history rows in this iteration.
enrollmentSchema.index({ userId: 1, category: 1 }, { unique: true });

// Live-computed helper — never trust a cached "isActive" field.
const isEnrollmentActive = (enrollment) => {
  if (!enrollment) return false;
  if (enrollment.revoked) return false;
  if (!enrollment.validTill) return false;
  return new Date(enrollment.validTill) >= new Date();
};

const EnrollmentModel = mongoose.model("Enrollment", enrollmentSchema);

module.exports = EnrollmentModel;
module.exports.isEnrollmentActive = isEnrollmentActive;
