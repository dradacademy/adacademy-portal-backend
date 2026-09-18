const multer = require("multer");

const storage = multer.memoryStorage();

// Handwritten answer-sheet photos — images only.
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"];
const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".heic"];

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(
      new Error("Invalid file type. Only image files (JPG/PNG/WEBP/HEIC) are allowed."),
      false
    );
  }

  const fileExtension = file.originalname
    .toLowerCase()
    .slice(file.originalname.lastIndexOf("."));

  if (!ALLOWED_EXTENSIONS.includes(fileExtension)) {
    return cb(new Error("Invalid file extension for an answer sheet photo."), false);
  }

  cb(null, true);
};

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per photo
    files: 10, // up to 10 pages per submission
  },
  fileFilter,
});

module.exports = upload;
