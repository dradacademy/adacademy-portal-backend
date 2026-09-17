const express = require("express");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
const {
  listAvailableVideos,
  getPlaybackToken,
  recordProgress,
} = require("../controllers/videoPlaybackController");

const router = express.Router();

// Student-facing recorded-class playback endpoints. Admins can also use
// these (e.g. to preview a recording) since authorizeRoles allows both.
router.use(verifyToken, authorizeRoles("admin", "student"));

router.get("/available", listAvailableVideos);
router.get("/:id/playback-token", getPlaybackToken);
router.post("/:id/progress", recordProgress);

module.exports = router;
