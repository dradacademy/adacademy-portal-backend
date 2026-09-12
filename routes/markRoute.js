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

router.get(
  "/get",
  verifyToken,
  authorizeRoles("admin", "evaluator", "student"),
  getMarkData
);
router.put("/update", verifyToken, authorizeRoles("admin"), updateMarkData);

module.exports = router;
