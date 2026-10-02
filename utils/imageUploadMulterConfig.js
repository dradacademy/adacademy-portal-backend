const multer = require("multer");

const storage = multer.memoryStorage();

// Screenshots of question papers: PNG / JPEG / WebP only (what a screen
// capture or the clipboard produces).
const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new Error("Invalid file type. Only PNG, JPG or WebP screenshots are allowed."), false);
  }
  cb(null, true);
};

const imageUpload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per screenshot (the admin page also shrinks big ones first)
    files: 40, // keep in step with MAX_IMAGES in pdfImportController.js
  },
  fileFilter,
});

module.exports = imageUpload;
