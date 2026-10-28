const express = require("express");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
const requireCompletedProfile = require("../middlewares/requireCompletedProfile");
const c = require("../controllers/studyTrackerController");

// Daily Study Tracker (TNPSC JDO) — 2026-10-28.
const router = express.Router();
router.use(verifyToken);

// Student
router.get("/me", authorizeRoles("admin", "student"), requireCompletedProfile, c.getMine);
router.post("/me/intro-seen", authorizeRoles("student"), requireCompletedProfile, c.markIntroSeen);
router.post("/me/plan", authorizeRoles("student"), requireCompletedProfile, c.fillMyMissingDates);
router.post("/me/check/start", authorizeRoles("student"), requireCompletedProfile, c.startCheck);
router.post("/me/check/submit", authorizeRoles("student"), requireCompletedProfile, c.submitCheck);

// Admin
router.get("/admin/summary", authorizeRoles("admin"), c.getSummary);
router.get("/admin/student/:studentId", authorizeRoles("admin"), c.getStudent);
router.put("/admin/plan/:studentId", authorizeRoles("admin"), c.savePlan);
router.post("/admin/entry", authorizeRoles("admin"), c.addAdminEntry);
router.delete("/admin/entry/:entryId", authorizeRoles("admin"), c.deleteEntry);
router.get("/admin/config", authorizeRoles("admin"), c.getAdminConfig);
router.put("/admin/config", authorizeRoles("admin"), c.saveAdminConfig);
router.post("/admin/import", authorizeRoles("admin"), c.importOld);

module.exports = router;
