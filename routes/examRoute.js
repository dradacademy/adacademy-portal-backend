const express = require("express");
const {
  getAllExams,
  createExam,
  updateExam,
  deleteExam,
  getExamById,
  updateShuffleQuestion,
} = require("../controllers/examController");
const {
  verifyToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware");
const router = express.Router();

router.get("/getAll", verifyToken, authorizeRoles("admin"), getAllExams);
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

module.exports = router;
