const express = require("express");
const router = express.Router();
const {
  getPublicContent,
  listContentAdmin,
  createContent,
  updateContent,
  deleteContent,
  seedDefaults,
} = require("../controllers/contentController");
const {
  verifyToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware");

// Public — read by the homepage sections (Achievers, Testimonials,
// Gallery, Announcements). No auth: this is public marketing content.
router.get("/public/:type", getPublicContent);

// Admin-only — the Content Management dashboard page.
router.get(
  "/admin/:type",
  verifyToken,
  authorizeRoles("admin"),
  listContentAdmin
);
router.post("/admin", verifyToken, authorizeRoles("admin"), createContent);
router.post(
  "/admin/seed-defaults",
  verifyToken,
  authorizeRoles("admin"),
  seedDefaults
);
router.put("/admin/:id", verifyToken, authorizeRoles("admin"), updateContent);
router.delete(
  "/admin/:id",
  verifyToken,
  authorizeRoles("admin"),
  deleteContent
);

module.exports = router;
