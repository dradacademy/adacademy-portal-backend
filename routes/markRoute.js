const express = require("express");
const {
  getMarkData,
  updateMarkData,
} = require("../controllers/markController");
const {
  verifyToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware");
const router = express.Router();

// Public — same reasoning as durationRoute.js's /get.
router.get("/get", getMarkData);
router.put("/update", verifyToken, authorizeRoles("admin"), updateMarkData);

module.exports = router;
