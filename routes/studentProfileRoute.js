const express = require("express");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
const upload = require("../utils/profilePhotoUploadMulterConfig");
const {
  getMyProfile,
  saveMyProfile,
  uploadMyPhoto,
  getProfilePhoto,
  listProfilesAdmin,
  getProfileAdmin,
} = require("../controllers/studentProfileController");

const router = express.Router();

router.use(verifyToken);

// Student's own profile — registered before the admin "/:userId" routes
// below so "me" is never parsed as a userId.
router.get("/me", authorizeRoles("student"), getMyProfile);
router.patch("/me", authorizeRoles("student"), saveMyProfile);
router.post("/me/photo", authorizeRoles("student"), upload.single("photo"), uploadMyPhoto);

// Admin-only listing routes.
router.get("/", authorizeRoles("admin"), listProfilesAdmin);
router.get("/:userId", authorizeRoles("admin"), getProfileAdmin);

// Shared (ownership-checked inside the controller: the owning student, or
// an admin).
router.get("/:userId/photo", getProfilePhoto);

module.exports = router;
