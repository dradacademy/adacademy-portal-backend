const { default: mongoose } = require("mongoose");
const {
  ensureDurationConfigExists,
} = require("../controllers/durationController");
const { ensureMarkConfigExists } = require("../controllers/markController");

const connectWithRetry = (retryCount = 4) => {
  mongoose
    .connect(process.env.MONGO_URI)
    .then(async () => {
      await ensureDurationConfigExists();
      await ensureMarkConfigExists();
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
