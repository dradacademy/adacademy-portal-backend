const express = require("express");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
const {
  requestUploadUrl,
  handleUploadWebhook,
  listRecordedClasses,
  updateRecordedClass,
  deleteRecordedClass,
  getVideoAnalytics,
  getStudentVideoAnalytics,
  getRetentionSetting,
  updateRetentionSetting,
  runRetentionSweepNow,
} = require("../controllers/recordedClassController");

const router = express.Router();

// Cloudflare Stream calls this directly — no user session exists, so it's
// verified by HMAC signature (see verifyWebhookSignature) instead of
// verifyToken/authorizeRoles. Must stay UNAUTHENTICATED at the route level.
router.post("/webhook", handleUploadWebhook);

// Everything else here is admin-only management/analytics.
router.use(verifyToken, authorizeRoles("admin"));

router.post("/upload-url", requestUploadUrl);
router.get("/", listRecordedClasses);
router.patch("/:id", updateRecordedClass);
router.delete("/:id", deleteRecordedClass);
router.get("/analytics", getVideoAnalytics);
router.get("/analytics/student/:userId", getStudentVideoAnalytics);
router.get("/settings/retention", getRetentionSetting);
router.patch("/settings/retention", updateRetentionSetting);
router.post("/settings/retention/run-now", runRetentionSweepNow);

module.exports = router;
