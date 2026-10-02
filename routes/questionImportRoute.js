const express = require("express");
const router = express.Router();
const {
  extractQuestionsFromPdf,
  extractQuestionsFromImages,
} = require("../controllers/pdfImportController");
const upload = require("../utils/pdfUploadMulterConfig");
const imageUpload = require("../utils/imageUploadMulterConfig");
const {
  verifyToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware");
const { pdfImportLimiter } = require("../middlewares/rateLimiter");

router.post(
  "/extract-from-pdf",
  verifyToken,
  authorizeRoles("admin"),
  pdfImportLimiter,
  (req, res, next) => {
    // "file" = the question paper PDF (required). "answerKeyFile" = an
    // optional, separately-uploaded answer key/solutions PDF for the same
    // question paper — when present, extractQuestionsFromPdf cross-
    // references it against "file" instead of guessing answers from the
    // question paper alone.
    upload.fields([
      { name: "file", maxCount: 1 },
      { name: "answerKeyFile", maxCount: 1 },
    ])(req, res, (err) => {
      if (err) {
        // Multer errors
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({
            success: false,
            message: "File too large. Maximum size is 15MB per file.",
          });
        }
        if (err.message && err.message.includes("Invalid file")) {
          return res.status(400).json({ success: false, message: err.message });
        }
        return res.status(400).json({ success: false, message: err.message });
      }
      next();
    });
  },
  extractQuestionsFromPdf
);

// Screenshots of a question paper, in order, as repeated "images" fields.
router.post(
  "/extract-from-images",
  verifyToken,
  authorizeRoles("admin"),
  pdfImportLimiter,
  (req, res, next) => {
    imageUpload.array("images", 40)(req, res, (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({
            success: false,
            message: "A screenshot is too large. Maximum size is 10MB per screenshot.",
          });
        }
        if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
          return res.status(400).json({
            success: false,
            message: "Too many screenshots. Please upload at most 40 at a time.",
          });
        }
        return res.status(400).json({ success: false, message: err.message });
      }
      next();
    });
  },
  extractQuestionsFromImages
);

module.exports = router;
