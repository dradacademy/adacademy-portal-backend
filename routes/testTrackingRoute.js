const express = require("express");
const {
  getStudentTestIndex,
  getAdminTestTracking,
} = require("../controllers/testTrackingController");
const {
  verifyToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware");

const router = express.Router();

// A student may fetch only their own index; an admin may fetch any
// student's (same permission pattern as /exam-function/eligible-exam).
router.get(
  "/student/:userId",
  verifyToken,
  authorizeRoles("admin", "student"),
  getStudentTestIndex
);

router.get(
  "/admin",
  verifyToken,
  authorizeRoles("admin"),
  getAdminTestTracking
);

module.exports = router;
