const express = require("express");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
const {
  listStudentProgress,
  getStudentProgressDetail,
  getMyProgress,
  getWeights,
  updateWeights,
} = require("../controllers/studentProgressController");

const router = express.Router();

router.use(verifyToken);

// Student's own progress — must be registered before the admin-only
// "/:studentId" route below, otherwise "me" would be parsed as a studentId.
router.get("/me", getMyProgress);

router.get("/weights", authorizeRoles("admin"), getWeights);
router.patch("/weights", authorizeRoles("admin"), updateWeights);

router.get("/", authorizeRoles("admin"), listStudentProgress);
router.get("/:studentId", authorizeRoles("admin"), getStudentProgressDetail);

module.exports = router;
