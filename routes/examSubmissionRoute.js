const express = require("express");
const {
  submitExam,
  getPassedSubmissionForUser,
  getPreviousAttemptForUser,
  getExamSubmissionById,
  getAllPassedSubmission,
  getAllPreviousAttempt,
  submitReviewForExamSubmission,
  deleteCommentInExamSubmission,
  updateCommentInExamSubmission,
} = require("../controllers/examSubmissionController");
const {
  verifyToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware");
const router = express.Router();

router.get(
  "/completed/get",
  verifyToken,
  authorizeRoles("admin", "evaluator"),
  getAllPassedSubmission
);
router.get(
  "/completed/:userId",
  verifyToken,
  authorizeRoles("admin", "evaluator", "student"),
  getPassedSubmissionForUser
);
router.get(
  "/previous-attempt/get",
  verifyToken,
  authorizeRoles("admin", "evaluator"),
  getAllPreviousAttempt
);
router.get(
  "/previous-attempt/:userId",
  verifyToken,
  authorizeRoles("admin", "evaluator", "student"),
  getPreviousAttemptForUser
);
router.get(
  "/get/:examSubmissionId",
  verifyToken,
  authorizeRoles("admin", "evaluator", "student"),
  getExamSubmissionById
);
router.post(
  "/submit",
  verifyToken,
  authorizeRoles("admin", "student"),
  submitExam
);
router.put(
  "/add-comment",
  verifyToken,
  authorizeRoles("admin", "evaluator"),
  submitReviewForExamSubmission
);
router.put(
  "/comment/update/:examId/:reviewId",
  verifyToken,
  authorizeRoles("admin", "evaluator"),
  updateCommentInExamSubmission
);
router.delete(
  "/comment/delete/:examId/:reviewId",
  verifyToken,
  authorizeRoles("admin", "evaluator"),
  deleteCommentInExamSubmission
);

module.exports = router;
