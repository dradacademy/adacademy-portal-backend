const express = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
const requireCompletedProfile = require("../middlewares/requireCompletedProfile");
const c = require("../controllers/liveQaController");

// Live Q&A during live classes (2026-10-28).
//
// Registered in index.js BEFORE the general per-IP limiter: the panel asks
// for updates every few seconds, and a whole classroom on one Wi-Fi shares
// one IP, which the general limit (300 per 10 min per IP) would block.
// This limiter counts per logged-in user instead.
const liveQaLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 600, // per user: one request a second on average
  keyGenerator: (req) => req.headers.authorization || ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, please slow down." },
});

const router = express.Router();
router.use(liveQaLimiter);
router.use(verifyToken);

router.get("/admin/classes", authorizeRoles("admin"), c.listClasses);
router.patch("/questions/:questionId", authorizeRoles("admin"), c.moderate);
router.post("/questions/:questionId/upvote", authorizeRoles("admin", "student"), requireCompletedProfile, c.upvote);
// Live quiz + leaderboard
router.post("/polls/:pollId/close", authorizeRoles("admin"), c.closePoll);
router.post("/polls/:pollId/answer", authorizeRoles("student"), requireCompletedProfile, c.answerPoll);
router.post("/:liveClassId/polls", authorizeRoles("admin"), c.createPoll);
router.get("/:liveClassId/leaderboard", authorizeRoles("admin"), c.getLeaderboard);
// Attendance checks (2026-10-30): who tapped "I'm present", and %.
router.get("/:liveClassId/attendance-checks", authorizeRoles("admin"), c.getAttendanceChecks);

router.get("/:liveClassId", authorizeRoles("admin", "student"), requireCompletedProfile, c.getBoard);
router.post("/:liveClassId/questions", authorizeRoles("student"), requireCompletedProfile, c.ask);
router.post("/:liveClassId/confused", authorizeRoles("student"), requireCompletedProfile, c.confused);

module.exports = router;
