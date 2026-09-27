const express = require("express");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
const {
  deleteExamHistory,
  deleteStudentHistory,
} = require("../controllers/dataDeletionController");

const router = express.Router();

// Both routes are highly destructive (permanent, irreversible deletes of
// marks/history) — admin-only, and additionally gated on `confirm: true`
// in the body (see dataDeletionController.js) as a server-side backstop
// behind the admin frontend's own two sequential Yes/No confirmations.
router.post(
  "/delete-exam-history",
  verifyToken,
  authorizeRoles("admin"),
  deleteExamHistory
);
router.post(
  "/delete-student-history",
  verifyToken,
  authorizeRoles("admin"),
  deleteStudentHistory
);

module.exports = router;
