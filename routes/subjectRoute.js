const express = require("express");
const router = express.Router();
const {
  createSubject,
  getSubjects,
  deleteSubject,
  editSubjects,
} = require("../controllers/subjectController");
const {
  verifyToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware");

router.get(
  "/get",
  verifyToken,
  authorizeRoles("admin", "evaluator", "student"),
  getSubjects
);
router.post("/create", verifyToken, authorizeRoles("admin"), createSubject);
router.put("/update/:id", verifyToken, authorizeRoles("admin"), editSubjects);
router.delete(
  "/delete/:id",
  verifyToken,
  authorizeRoles("admin"),
  deleteSubject
);

module.exports = router;
