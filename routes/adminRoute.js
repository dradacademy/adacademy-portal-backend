const express = require("express");
const {
  triggerMail,
  deleteUserEntirely,
} = require("../controllers/adminController");
const {
  verifyToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware");
const router = express.Router();

router.post("/trigger-mail", verifyToken, authorizeRoles("admin"), triggerMail);
router.delete(
  "/delete-user/:userId",
  verifyToken,
  authorizeRoles("admin"),
  deleteUserEntirely
);

module.exports = router;
