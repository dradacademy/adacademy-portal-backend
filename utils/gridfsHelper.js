const mongoose = require("mongoose");

// A single shared GridFS bucket for every "large binary blob living inside
// Mongo" need in this app — attachment files (PDF/PPT/DOC) and answer-sheet
// images. Chosen specifically to avoid standing up a new paid storage
// service/account/env var for this feature: it reuses the exact MongoDB
// Atlas connection this app already has (see config/db.js), the same way
// multer's memoryStorage pattern (utils/pdfUploadMulterConfig.js) already
// buffers uploads in this codebase before handing them off. Real tradeoff to
// flag to the admin: Atlas's free/shared tiers have a small total storage
// cap, so this is fine for PDFs/PPTs/answer-sheet photos at a modest scale,
// but isn't meant for large video files (which is exactly why recorded
// classes stay on YouTube instead of going through this bucket).
let bucket = null;

const getBucket = () => {
  if (!bucket) {
    if (mongoose.connection.readyState !== 1) {
      throw new Error("Database connection is not ready yet.");
    }
    bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: "appFiles",
    });
  }
  return bucket;
};

// Buffers a Buffer (as produced by multer's memoryStorage) into GridFS and
// resolves with the new file's ObjectId.
const uploadBufferToGridFs = (buffer, filename, contentType) => {
  return new Promise((resolve, reject) => {
    const uploadStream = getBucket().openUploadStream(filename, {
      contentType,
    });
    uploadStream.once("finish", () => resolve(uploadStream.id));
    uploadStream.once("error", reject);
    uploadStream.end(buffer);
  });
};

// Streams a stored file straight to an Express response (used for in-app
// "view" endpoints — never exposes a direct download URL, since the route
// itself is what's authenticated/access-checked before this is called).
const streamFileToResponse = (fileId, res) => {
  return new Promise((resolve, reject) => {
    const downloadStream = getBucket().openDownloadStream(
      new mongoose.Types.ObjectId(fileId)
    );
    downloadStream.on("error", reject);
    downloadStream.on("end", resolve);
    downloadStream.pipe(res);
  });
};

const deleteFile = async (fileId) => {
  try {
    await getBucket().delete(new mongoose.Types.ObjectId(fileId));
  } catch (error) {
    // A missing file (already deleted, or never fully uploaded) shouldn't
    // block the metadata-row delete that called this.
    console.error("GridFS delete failed (continuing):", error.message);
  }
};

module.exports = {
  getBucket,
  uploadBufferToGridFs,
  streamFileToResponse,
  deleteFile,
};
