const express = require("express");
const router = express.Router();
const {
  createSubject,
  getSubjects,
  deleteSubject,
  editSubjects,
  getSyllabus,
  importSyllabus,
  quickAdd,
} = require("../controllers/subjectController");
const {
  verifyToken,
  authorizeRoles,
  optionalAuth,
} = require("../middlewares/authMiddleware");

// Public — the homepage's course/subject listing loads for every visitor,
// logged in or not. optionalAuth still identifies a logged-in student (so
// their category-filtered view keeps working); getSubjects handles
// req.user being unset for anonymous visitors.
router.get("/get", optionalAuth, getSubjects);
router.post("/create", verifyToken, authorizeRoles("admin"), createSubject);
// Built-in syllabus + quick add from class forms (2026-10-31).
router.get("/syllabus", verifyToken, authorizeRoles("admin"), getSyllabus);
router.post("/import-syllabus", verifyToken, authorizeRoles("admin"), importSyllabus);
router.post("/quick-add", verifyToken, authorizeRoles("admin"), quickAdd);
router.put("/update/:id", verifyToken, authorizeRoles("admin"), editSubjects);
router.delete(
  "/delete/:id",
  verifyToken,
  authorizeRoles("admin"),
  deleteSubject
);

module.exports = router;
