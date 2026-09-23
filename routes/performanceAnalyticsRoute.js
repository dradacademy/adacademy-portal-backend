const express = require("express");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
const {
  getMyPerformanceAnalytics,
  getStudentPerformanceAnalytics,
  getMyCategoryLeaderboards,
  getMyAttemptHistory,
  getCategoryRollup,
  generatePerformanceReportPdf,
} = require("../controllers/performanceAnalyticsController");

const router = express.Router();

router.use(verifyToken);

// Student's own comparison, the category leaderboards, and the attempt
// history for the trend/quadrant charts — all registered before the
// admin-only /:studentId route below, same ordering reason as
// studentProgressRoute.js's /me (otherwise these would be parsed as a
// studentId by the route below them).
router.get("/me", authorizeRoles("student"), getMyPerformanceAnalytics);
router.get("/leaderboards/me", authorizeRoles("student"), getMyCategoryLeaderboards);
router.get("/trend/me", authorizeRoles("student"), getMyAttemptHistory);

// Admin-only category-wide rollup — "/rollup/:category" is two segments,
// so it never collides with the single-segment "/:studentId" below either
// way, but kept above it anyway to match this file's existing convention
// of listing every non-parameterized route before the catch-all.
router.get("/rollup/:category", authorizeRoles("admin"), getCategoryRollup);

// Admin-only PDF export — "/:studentId/pdf" is two segments, so it's
// distinguishable from "/:studentId" below regardless of ordering, but
// kept above it for the same listing-convention reason as /rollup above.
router.get("/:studentId/pdf", authorizeRoles("admin"), generatePerformanceReportPdf);

router.get("/:studentId", authorizeRoles("admin"), getStudentPerformanceAnalytics);

module.exports = router;
