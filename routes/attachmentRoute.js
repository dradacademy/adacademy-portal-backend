const express = require("express");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
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

// Student-facing routes, registered first with explicit per-route auth
// (rather than a blanket router.use(authorizeRoles("admin"))) so they don't
// collide with the admin-only routes below on the same base path.
router.get("/available", verifyToken, listAvailableAttachments);
router.get("/:id/view", verifyToken, viewAttachmentFile);

// Admin-only management routes.
router.post("/", verifyToken, authorizeRoles("admin"), upload.single("file"), uploadAttachment);
router.get("/", verifyToken, authorizeRoles("admin"), listAttachments);
router.patch(
  "/:id",
  verifyToken,
  authorizeRoles("admin"),
  upload.single("file"),
  updateAttachment
);
router.delete("/:id", verifyToken, authorizeRoles("admin"), deleteAttachment);

module.exports = router;
