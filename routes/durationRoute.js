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

router.get(
  "/get",
  verifyToken,
  authorizeRoles("admin", "evaluator", "student"),
  getDurationData
);
router.put("/update", verifyToken, authorizeRoles("admin"), updateDurationData);

module.exports = router;
