const express = require("express");
require("dotenv").config();
const cookieParser = require("cookie-parser");
const { connectWithRetry } = require("./config/db");
const cors = require("cors");
const {
  authLimiter,
  submissionLimiter,
  generalLimiter,
} = require("./middlewares/rateLimiter");

// Import Node.js core modules for clustering
const cluster = require("cluster");
const { availableParallelism } = require("os");
const process = require("process");
const { default: mongoose } = require("mongoose");
const numCPUs = availableParallelism();

const PORT = process.env.PORT || 4000;
const app = express();

// if (cluster.isPrimary) {
//   console.log(`Primary ${process.pid} is running`);

//   // Fork workers for each available CPU core.
//   for (let i = 0; i < numCPUs; i++) {
//     cluster.fork();
//   }

//   // If a worker process dies, log it and fork a new one to replace it.
//   cluster.on("exit", (worker, code, signal) => {
//     console.log(`Worker ${worker.process.pid} died. Restarting...`);
//     cluster.fork();
//   });
// } else {
  app.use(cookieParser());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const allowedOrigins = [process.env.CLIENT_URL];

  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );

  app.use(generalLimiter);

  app.use("/api/users", authLimiter, require("./routes/userRoute"));
  app.use("/api/subjects", require("./routes/subjectRoute"));
  app.use("/api/exams", require("./routes/examRoute"));
  app.use("/api/exam-function", require("./routes/examFunctionRoute"));
  app.use(
    "/api/exam-submission",
    submissionLimiter,
    require("./routes/examSubmissionRoute"),
  );
  app.use("/api/admin", require("./routes/adminRoute"));
  app.use("/api/review", require("./routes/reviewRoute"));
  app.use("/api/duration", require("./routes/durationRoute"));
  app.use("/api/mark", require("./routes/markRoute"));
  app.use("/api/dashboard", require("./routes/dashboardRoute"));

  if (require.main === module) {
    connectWithRetry();
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  }

  // --- Graceful Shutdown ---
  process.on("SIGINT", async () => {
    if (!cluster.isPrimary) {
      console.log(`Worker ${process.pid} shutting down gracefully...`);
      try {
        await mongoose.connection.close();
        console.log("MongoDB connection closed.");
      } catch (err) {
        console.error("Error closing MongoDB:", err);
      }
    }
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    if (!cluster.isPrimary) {
      console.log(`Worker ${process.pid} shutting down gracefully...`);
      try {
        await mongoose.connection.close();
        console.log("MongoDB connection closed.");
      } catch (err) {
        console.error("Error closing MongoDB:", err);
      }
    }
    process.exit(0);
  });
// }

module.exports = app;
