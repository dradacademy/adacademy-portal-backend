const { default: mongoose } = require("mongoose");
const {
  ensureDurationConfigExists,
} = require("../controllers/durationController");
const { ensureMarkConfigExists } = require("../controllers/markController");
const recordedClassModel = require("../models/recordedClassModel");

const connectWithRetry = (retryCount = 4) => {
  mongoose
    .connect(process.env.MONGO_URI)
    .then(async () => {
      await ensureDurationConfigExists();
      await ensureMarkConfigExists();

      // One-time self-heal: this collection went through an earlier draft
      // (built on Cloudflare Stream, with its own required+indexed fields
      // like cloudflareVideoUid) before the admin switched to the current
      // YouTube-link based design. Changing a Mongoose schema never drops
      // indexes MongoDB already built for fields the schema no longer has
      // — so a leftover unique index from that draft silently rejects
      // every new recording after the first (a duplicate-key error on
      // "missing field" once a second document also lacks it), with no
      // validation error to explain why. syncIndexes() reconciles the
      // live collection to exactly what the current schema declares —
      // safe to run on every boot; it's a no-op once indexes already
      // match.
      try {
        const droppedIndexes = await recordedClassModel.syncIndexes();
        if (droppedIndexes.length > 0) {
          console.log(
            "Synced RecordedClass indexes — removed stale indexes:",
            droppedIndexes
          );
        }
      } catch (syncError) {
        console.error("Failed to sync RecordedClass indexes:", syncError.message);
      }

      console.log("MongoDB connection established...");
    })
    .catch((error) => {
      console.error(`MongoDB connection failed: ${error.message}`);
      if (retryCount > 0) {
        console.log(`Retrying to connect... Attempts left: ${retryCount}`);
        setTimeout(() => connectWithRetry(retryCount - 1), 10000);
      } else {
        console.error("Failed to connect to MongoDB after multiple attempts.");
      }
    });
};

module.exports = {
  connectWithRetry,
};
