const express = require("express");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
const {
  myEligibility,
  askDoubt,
  myDoubts,
  listDoubts,
  replyToDoubt,
  setDoubtStatus,
  getDoubtAccess,
  setDoubtAccess,
} = require("../controllers/doubtController");

const router = express.Router();
router.use(verifyToken);

// Student
router.get("/eligibility", authorizeRoles("student"), myEligibility);
router.get("/mine", authorizeRoles("student"), myDoubts);
router.post("/", authorizeRoles("student"), askDoubt);

// Admin
router.get("/", authorizeRoles("admin"), listDoubts);
router.get("/access/:userId", authorizeRoles("admin"), getDoubtAccess);
router.patch("/access/:userId", authorizeRoles("admin"), setDoubtAccess);
router.patch("/:id/reply", authorizeRoles("admin"), replyToDoubt);
router.patch("/:id/status", authorizeRoles("admin"), setDoubtStatus);

module.exports = router;
