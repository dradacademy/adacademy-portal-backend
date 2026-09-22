const enrollmentModel = require("../models/enrollmentModel");
const userModel = require("../models/userModel");

// PATCH /api/enrollments/:userId (admin only) — set/renew a student's
// course-enrollment validity window for the video system. Upserts on
// {userId, category}, so renewing a course simply updates validTill on the
// same document — no separate renewal-history rows in this iteration.
const setEnrollment = async (req, res) => {
  try {
    const { userId } = req.params;
    const { category, validTill, revoked, accessLevel } = req.body;

    if (!category || !validTill) {
      return res.status(400).json({
        success: false,
        message: "category and validTill are required.",
      });
    }

    const student = await userModel.findById(userId).select("role category");
    if (!student || student.role !== "student") {
      return res.status(404).json({ success: false, message: "Student not found." });
    }

    // Defaults to "full" whenever the caller doesn't send a recognized
    // value — keeps any not-yet-updated frontend/API caller working exactly
    // as before this field existed.
    const resolvedAccessLevel = accessLevel === "test_series_only" ? "test_series_only" : "full";

    const enrollment = await enrollmentModel.findOneAndUpdate(
      { userId, category },
      {
        userId,
        category,
        validTill,
        revoked: revoked ?? false,
        accessLevel: resolvedAccessLevel,
        grantedBy: req.user._id,
        $setOnInsert: { validFrom: new Date() },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(200).json({ success: true, data: enrollment });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to set enrollment.",
      error: error.message,
    });
  }
};

// GET /api/enrollments/:userId (admin only) — every category this student
// has an enrollment record for (used by the "Manage Enrollment" modal to
// pre-fill current state).
const getEnrollmentsForStudent = async (req, res) => {
  try {
    const { userId } = req.params;
    const enrollments = await enrollmentModel.find({ userId }).sort({ category: 1 });
    res.status(200).json({ success: true, data: enrollments });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch enrollments.",
      error: error.message,
    });
  }
};

module.exports = {
  setEnrollment,
  getEnrollmentsForStudent,
};
