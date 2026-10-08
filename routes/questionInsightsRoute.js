const express = require("express");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
const { getQuestionInsights } = require("../controllers/questionInsightsController");

const router = express.Router();
router.get("/:examSubmissionId", verifyToken, authorizeRoles("admin", "evaluator", "student"), getQuestionInsights);

module.exports = router;
