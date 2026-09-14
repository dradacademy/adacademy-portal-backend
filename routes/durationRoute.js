const express = require("express");
const {
  getDurationData,
  updateDurationData,
} = require("../controllers/durationController");
const {
  verifyToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware");
const router = express.Router();

// Public — the homepage/exam pages need this to display durations even
// before a visitor logs in.
router.get("/get", getDurationData);
router.put("/update", verifyToken, authorizeRoles("admin"), updateDurationData);

module.exports = router;
