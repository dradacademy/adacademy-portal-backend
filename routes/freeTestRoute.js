const express = require("express");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
const { leadLimiter } = require("../middlewares/rateLimiter");
const {
  getFreeTestOptions,
  registerForFreeTest,
  listRegistrations,
  convertToStudent,
} = require("../controllers/freeTestController");

const router = express.Router();

// Public
router.get("/options", getFreeTestOptions);
router.post("/register", leadLimiter, registerForFreeTest);

// Admin
router.get("/registrations", verifyToken, authorizeRoles("admin"), listRegistrations);
router.patch("/registrations/:userId/convert", verifyToken, authorizeRoles("admin"), convertToStudent);

module.exports = router;
