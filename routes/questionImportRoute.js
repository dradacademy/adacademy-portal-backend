const express = require("express");
const router = express.Router();
const { extractQuestionsFromPdf } = require("../controllers/pdfImportController");
const upload = require("../utils/pdfUploadMulterConfig");
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

module.exports = router;
