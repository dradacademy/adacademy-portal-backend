const express = require("express");
const { getPopularVideos } = require("../controllers/publicVideoController");

// Public website: the academy's popular YouTube videos (no login).
const router = express.Router();
router.get("/", getPopularVideos);

module.exports = router;
