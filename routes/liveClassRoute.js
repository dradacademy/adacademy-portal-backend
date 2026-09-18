const express = require("express");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
const {
  startLiveClass,
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
router.get("/", authorizeRoles("admin"), listLiveClasses);
router.get("/attendance-report", authorizeRoles("admin"), getLiveAttendanceReport);
router.delete("/:id", authorizeRoles("admin"), deleteLiveClass);

// Student-facing (admins can also hit these, same as recorded-class
// playback, e.g. to preview).
router.get("/current", authorizeRoles("admin", "student"), listCurrentLiveClasses);
router.get("/:id/join", authorizeRoles("admin", "student"), joinLiveClass);
router.post("/:id/progress", authorizeRoles("admin", "student"), recordLiveProgress);

module.exports = router;
