const express = require("express");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
const upload = require("../utils/answerSheetUploadMulterConfig");
const {
  uploadAnswerSheet,
  listMyAnswerSheets,
  listForExam,
  listForStudent,
  getAnswerSheetDetail,
  getAnswerSheetImage,
  addMistake,
  removeMistake,
  markReviewed,
  deleteAnswerSheet,
} = require("../controllers/answerSheetController");

const router = express.Router();

router.use(verifyToken);

// Student routes — registered before the admin-only "/exam/:examId" and
// "/student/:userId" routes below so "mine" is never treated as a param.
router.post("/", upload.array("images", 10), uploadAnswerSheet);
router.get("/mine", listMyAnswerSheets);

// Admin-only listing routes.
router.get("/exam/:examId", authorizeRoles("admin"), listForExam);
router.get("/student/:userId", authorizeRoles("admin"), listForStudent);

// Shared (ownership-checked inside the controller).
router.get("/:id", getAnswerSheetDetail);
router.get("/:id/image/:imageIndex", getAnswerSheetImage);
router.delete("/:id", deleteAnswerSheet);

// Admin-only mistake-marking + review.
router.post("/:id/mistakes", authorizeRoles("admin"), addMistake);
router.delete("/:id/mistakes/:mistakeId", authorizeRoles("admin"), removeMistake);
router.patch("/:id/review", authorizeRoles("admin"), markReviewed);

module.exports = router;
