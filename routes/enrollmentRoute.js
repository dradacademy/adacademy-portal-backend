const express = require("express");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
const {
  setEnrollment,
  getEnrollmentsForStudent,
} = require("../controllers/enrollmentController");

const router = express.Router();

router.use(verifyToken, authorizeRoles("admin"));

router.get("/:userId", getEnrollmentsForStudent);
router.patch("/:userId", setEnrollment);

module.exports = router;
