const multer = require("multer");

const storage = multer.memoryStorage();

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new Error("Invalid file type. Only JPG, PNG, or WEBP photos are allowed."), false);
  }
  const fileExtension = file.originalname
    .toLowerCase()
    .slice(file.originalname.lastIndexOf("."));
  if (!ALLOWED_EXTENSIONS.includes(fileExtension)) {
    return cb(new Error("Invalid file extension for a profile photo."), false);
  }
  cb(null, true);
};

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB — a passport-size photo, not a document scan
    files: 1,
  },
  fileFilter,
});

module.exports = upload;
