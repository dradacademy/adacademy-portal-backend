const multer = require("multer");

const storage = multer.memoryStorage();

// PDF/PPT/Word only, per the admin's request — a simple upload-and-view
// provision (no paid DRM/locking service): admin uploads, students view
// in-app, no download link is ever exposed in the UI. See
// controllers/attachmentController.js for the honest caveat on PPT/DOC
// preview support.
const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const ALLOWED_EXTENSIONS = [".pdf", ".ppt", ".pptx", ".doc", ".docx"];

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(
      new Error("Invalid file type. Only PDF, PPT, and Word files are allowed."),
      false
    );
  }

  const fileExtension = file.originalname
    .toLowerCase()
    .slice(file.originalname.lastIndexOf("."));

  if (!ALLOWED_EXTENSIONS.includes(fileExtension)) {
    return cb(
      new Error("Invalid file extension. Only .pdf, .ppt, .pptx, .doc, .docx files are allowed."),
      false
    );
  }

  cb(null, true);
};

const upload = multer({
  storage,
  limits: {
    fileSize: 30 * 1024 * 1024, // 30MB max — study material, not video
    files: 1,
  },
  fileFilter,
});

module.exports = upload;
