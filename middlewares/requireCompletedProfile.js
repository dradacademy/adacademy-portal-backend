const studentProfileModel = require("../models/studentProfileModel");

// Defense-in-depth access gate: a student may not touch any content-access
// endpoint (recorded classes, live classes, materials, tests) until their
// StudentProfile has been fully submitted (both the student's and the
// parent/guardian's declaration signature — see saveMyProfile in
// studentProfileController.js, which is the single place `status` ever
// flips from "draft" to "submitted", and never flips back). The frontend
// also redirects an incomplete student straight to /profile (see App.jsx),
// but that alone would be trivially bypassable by calling these APIs
// directly, so this middleware is the real enforcement.
//
// No-ops for admin/evaluator — they're never gated by a student profile,
// even when previewing student-facing content (same "admin can also hit
// these" pattern already used throughout the video/live-class/attachment
// routes).
const requireCompletedProfile = async (req, res, next) => {
  try {
    if (!req.user || req.user.role !== "student") {
      return next();
    }

    const profile = await studentProfileModel
      .findOne({ userId: req.user._id })
      .select("status");

    if (profile && profile.status === "submitted") {
      return next();
    }

    return res.status(403).json({
      success: false,
      code: "PROFILE_INCOMPLETE",
      message: "Please complete your student profile before accessing this feature.",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to verify profile status.",
      error: error.message,
    });
  }
};

module.exports = requireCompletedProfile;
