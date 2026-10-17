const express = require("express");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
const {
  createRecordedClass,
  listRecordedClasses,
  updateRecordedClass,
  bulkUpdateAvailability,
  bulkGroupRecordedClasses,
  deleteRecordedClass,
  getVideoAnalytics,
  getStudentVideoAnalytics,
} = require("../controllers/recordedClassController");

const router = express.Router();

// Everything here is admin-only management/analytics. There is no
// unauthenticated upload/webhook route anymore — the video itself lives on
// YouTube, managed there by the admin; this API only ever stores a link.
router.use(verifyToken, authorizeRoles("admin"));

router.post("/", createRecordedClass);
router.get("/", listRecordedClasses);
// Must come before "/:id" so "bulk-availability" isn't read as an id.
router.patch("/bulk-availability", bulkUpdateAvailability);
router.patch("/bulk-group", bulkGroupRecordedClasses);
router.patch("/:id", updateRecordedClass);
router.delete("/:id", deleteRecordedClass);
router.get("/analytics", getVideoAnalytics);
router.get("/analytics/student/:userId", getStudentVideoAnalytics);

module.exports = router;
