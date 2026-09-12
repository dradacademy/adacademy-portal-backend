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
    upload.single("file")(req, res, (err) => {
      if (err) {
        // Multer errors
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({
            success: false,
            message: "File too large. Maximum size is 15MB.",
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
