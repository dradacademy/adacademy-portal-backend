const express = require("express");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
const {
  startLiveClass,
  endLiveClass,
  listLiveClasses,
  listCurrentLiveClasses,
  joinLiveClass,
} = require("../controllers/liveClassController");

const router = express.Router();

router.use(verifyToken);

// Admin-only management.
router.post("/", authorizeRoles("admin"), startLiveClass);
router.patch("/:id/end", authorizeRoles("admin"), endLiveClass);
router.get("/", authorizeRoles("admin"), listLiveClasses);

// Student-facing (admins can also hit these, same as recorded-class
// playback, e.g. to preview).
router.get("/current", authorizeRoles("admin", "student"), listCurrentLiveClasses);
router.get("/:id/join", authorizeRoles("admin", "student"), joinLiveClass);

module.exports = router;
