const express = require("express");
const {
  getAllExamsOverview,
  getExamDetailedAnalysis,
  getStudentDetailedAnalysis,
  getAllStudentsOverview,
} = require("../controllers/dashboardController");
const {
  verifyToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware");

const router = express.Router();

router.get(
  "/exams/overview",
  verifyToken,
  authorizeRoles("admin"),
  getAllExamsOverview
);
router.get(
  "/exams/:examId/analysis",
  verifyToken,
  authorizeRoles("admin"),
  getExamDetailedAnalysis
);
router.get(
  "/students/overview",
  verifyToken,
  authorizeRoles("admin"),
  getAllStudentsOverview
);
router.get(
  "/students/:studentId/analysis",
  verifyToken,
  authorizeRoles("admin"),
  getStudentDetailedAnalysis
);

module.exports = router;
