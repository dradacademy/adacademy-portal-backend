const express = require("express");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
const requireCompletedProfile = require("../middlewares/requireCompletedProfile");
const {
  getMyPending,
  saveMyDates,
  getTracker,
  getStudentDetail,
  setBatchForStudents,
  updateSettings,
} = require("../controllers/videoCommitmentController");

// Pending Videos popup (student) + Video Tracker (admin) — 2026-10-28.
const router = express.Router();

router.use(verifyToken);

// Student's own popup. Admin calls are answered with "not enabled".
router.get("/me", authorizeRoles("admin", "student"), requireCompletedProfile, getMyPending);
router.post("/me", authorizeRoles("student"), requireCompletedProfile, saveMyDates);

router.get("/admin", authorizeRoles("admin"), getTracker);
router.get("/admin/student/:studentId", authorizeRoles("admin"), getStudentDetail);
router.patch("/admin/batch", authorizeRoles("admin"), setBatchForStudents);
router.patch("/admin/settings", authorizeRoles("admin"), updateSettings);

module.exports = router;
