const multer = require("multer");

const storage = multer.memoryStorage();

// File filter for security
const fileFilter = (req, file, cb) => {
  // Only allow Excel files
  const allowedMimeTypes = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
    'application/vnd.ms-excel' // .xls (legacy)
  ];
  
  if (!allowedMimeTypes.includes(file.mimetype)) {
    return cb(new Error('Invalid file type. Only Excel files (.xlsx, .xls) are allowed.'), false);
  }
  
  // Additional check: file extension
  const allowedExtensions = ['.xlsx', '.xls'];
  const fileExtension = file.originalname.toLowerCase().slice(file.originalname.lastIndexOf('.'));
  
  if (!allowedExtensions.includes(fileExtension)) {
    return cb(new Error('Invalid file extension. Only .xlsx and .xls files are allowed.'), false);
  }
  
  cb(null, true);
};

const upload = multer({ 
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max file size
    files: 1 // Only 1 file per upload
  },
  fileFilter
});

module.exports = upload;
