const express = require("express");
const {
  addComment,
  deleteComment,
  getCommentByEvaluator,
  editComment,
  getAllComment,
  getCommentByRangeForStudents,
} = require("../controllers/reviewController");
const {
  authorizeRoles,
  verifyToken,
} = require("../middlewares/authMiddleware");
const router = express.Router();

router.get(
  "/get",
  verifyToken,
  authorizeRoles("admin", "evaluator", "student"),
  getAllComment
);
router.get(
  "/get-by-evaluator/:evaluatorId",
  verifyToken,
  authorizeRoles("admin", "evaluator"),
  getCommentByEvaluator
);
router.get(
  "/get-by-range",
  verifyToken,
  authorizeRoles("admin", "evaluator", "student"),
  getCommentByRangeForStudents
);
router.post(
  "/create",
  verifyToken,
  authorizeRoles("admin", "evaluator"),
  addComment
);
router.put(
  "/edit/:commentId",
  verifyToken,
  authorizeRoles("admin", "evaluator"),
  editComment
);
router.delete(
  "/delete/:commentId",
  verifyToken,
  authorizeRoles("admin", "evaluator"),
  deleteComment
);

module.exports = router;
