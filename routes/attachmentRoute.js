const express = require("express");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
const requireCompletedProfile = require("../middlewares/requireCompletedProfile");
const upload = require("../utils/attachmentUploadMulterConfig");
const {
  uploadAttachment,
  listAttachments,
  updateAttachment,
  deleteAttachment,
  listAvailableAttachments,
  viewAttachmentFile,
} = require("../controllers/attachmentController");

const router = express.Router();

// Wraps multer's single-file upload so a rejected file (too large, or the
// wrong type per fileFilter in attachmentUploadMulterConfig.js) reaches the
// admin as a real, readable reason instead of falling through to Express's
// default error handler — which returns an HTML error page, not JSON, so
// the frontend's `error?.response?.data?.message` read finds nothing and
// falls back to its generic "Failed to save the material." toast. Same
// pattern already used for the bulk user-upload route in userRoute.js.
const uploadSingleFile = (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          success: false,
          message: "File too large. Maximum size is 30MB.",
        });
      }
      return res.status(400).json({ success: false, message: err.message });
    }
    next();
  });
};

// Student-facing routes, registered first with explicit per-route auth
// (rather than a blanket router.use(authorizeRoles("admin"))) so they don't
// collide with the admin-only routes below on the same base path.
// requireCompletedProfile no-ops for non-students, so admin/evaluator
// access here is unaffected.
router.get("/available", verifyToken, requireCompletedProfile, listAvailableAttachments);
router.get("/:id/view", verifyToken, requireCompletedProfile, viewAttachmentFile);

// Admin-only management routes.
router.post("/", verifyToken, authorizeRoles("admin"), uploadSingleFile, uploadAttachment);
router.get("/", verifyToken, authorizeRoles("admin"), listAttachments);
router.patch(
  "/:id",
  verifyToken,
  authorizeRoles("admin"),
  uploadSingleFile,
  updateAttachment
);
router.delete("/:id", verifyToken, authorizeRoles("admin"), deleteAttachment);

module.exports = router;
