const express = require("express");
const {
  getAllExams,
  createExam,
  updateExam,
  deleteExam,
  getExamById,
  updateShuffleQuestion,
  regradeExam,
  backfillShortAnswerRanges,
} = require("../controllers/examController");
const { exportExamPdf, exportExamWord } = require("../controllers/examExportController");
const {
  verifyToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware");
const router = express.Router();

router.get("/getAll", verifyToken, authorizeRoles("admin"), getAllExams);
// Download the exam as a formatted question paper — PDF or Word.
router.get("/:id/export/pdf", verifyToken, authorizeRoles("admin"), exportExamPdf);
router.get("/:id/export/word", verifyToken, authorizeRoles("admin"), exportExamWord);
router.get("/:id", verifyToken, authorizeRoles("admin"), getExamById);
router.post("/create", verifyToken, authorizeRoles("admin"), createExam);
router.put("/update/:id", verifyToken, authorizeRoles("admin"), updateExam);
router.put(
  "/update/shuffle/:id",
  verifyToken,
  authorizeRoles("admin"),
  updateShuffleQuestion
);
router.delete("/delete/:id", verifyToken, authorizeRoles("admin"), deleteExam);
// On-demand: re-grade every already-completed submission for this exam
// against its current answer key/marks/pass percentage (see regradeHelper).
router.post("/:id/regrade", verifyToken, authorizeRoles("admin"), regradeExam);
// One-time (safely re-runnable) backfill: finds Short Answer questions
// whose answer explanation already states a numeric tolerance range but
// were created before Short Answer supported structured range-mode
// grading, sets their range fields, and re-grades every affected exam's
// already-completed submissions. See examController.js's
// backfillShortAnswerRanges for details.
router.post(
  "/short-answer-range-backfill",
  verifyToken,
  authorizeRoles("admin"),
  backfillShortAnswerRanges
);

module.exports = router;
