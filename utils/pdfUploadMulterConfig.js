const multer = require("multer");

const storage = multer.memoryStorage();

// File filter for security — only PDF question papers are accepted here.
const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = ["application/pdf"];

  if (!allowedMimeTypes.includes(file.mimetype)) {
    return cb(new Error("Invalid file type. Only PDF files are allowed."), false);
  }

  const allowedExtensions = [".pdf"];
  const fileExtension = file.originalname
    .toLowerCase()
    .slice(file.originalname.lastIndexOf("."));

  if (!allowedExtensions.includes(fileExtension)) {
    return cb(
      new Error("Invalid file extension. Only .pdf files are allowed."),
      false,
    );
  }

  cb(null, true);
};

const upload = multer({
  storage,
  limits: {
    fileSize: 15 * 1024 * 1024, // 15MB max file size, per file
    // Up to 2 files: the question-import endpoint accepts the question
    // paper PDF ("file") plus an optional separate answer-key PDF
    // ("answerKeyFile") via upload.fields([...]) — see questionImportRoute.js.
    files: 2,
  },
  fileFilter,
});

module.exports = upload;
