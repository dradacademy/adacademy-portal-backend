const express = require("express");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
const {
  createAnnouncement,
  listNotifications,
  markNotificationsSeen,
} = require("../controllers/notificationController");

const router = express.Router();

router.use(verifyToken);

router.get("/", authorizeRoles("admin", "student"), listNotifications);
router.post("/mark-seen", authorizeRoles("admin", "student"), markNotificationsSeen);
router.post("/announcement", authorizeRoles("admin"), createAnnouncement);

module.exports = router;
