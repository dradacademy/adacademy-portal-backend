const express = require("express");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
const requireCompletedProfile = require("../middlewares/requireCompletedProfile");
const {
  startLiveClass,
  updateLiveClass,
  endLiveClass,
  listLiveClasses,
  listCurrentLiveClasses,
  joinLiveClass,
  recordLiveProgress,
  getLiveAttendanceReport,
  deleteLiveClass,
} = require("../controllers/liveClassController");

const router = express.Router();

router.use(verifyToken);

// Admin-only management + reporting.
router.post("/", authorizeRoles("admin"), startLiveClass);
router.patch("/:id/end", authorizeRoles("admin"), endLiveClass);
router.patch("/:id", authorizeRoles("admin"), updateLiveClass);
router.get("/", authorizeRoles("admin"), listLiveClasses);
router.get("/attendance-report", authorizeRoles("admin"), getLiveAttendanceReport);
router.delete("/:id", authorizeRoles("admin"), deleteLiveClass);

// Student-facing (admins can also hit these, same as recorded-class
// playback, e.g. to preview). requireCompletedProfile no-ops for admins.
router.get(
  "/current",
  authorizeRoles("admin", "student"),
  requireCompletedProfile,
  listCurrentLiveClasses
);
router.get(
  "/:id/join",
  authorizeRoles("admin", "student"),
  requireCompletedProfile,
  joinLiveClass
);
router.post(
  "/:id/progress",
  authorizeRoles("admin", "student"),
  requireCompletedProfile,
  recordLiveProgress
);

module.exports = router;
