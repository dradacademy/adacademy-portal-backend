const express = require("express");
require("dotenv").config();
const cookieParser = require("cookie-parser");
const { connectWithRetry } = require("./config/db");
const cors = require("cors");
const {
  authLimiter,
  submissionLimiter,
  generalLimiter,
  leadLimiter,
} = require("./middlewares/rateLimiter");

// Import Node.js core modules for clustering
const cluster = require("cluster");
const { availableParallelism } = require("os");
const process = require("process");
const { default: mongoose } = require("mongoose");
const numCPUs = availableParallelism();

const PORT = process.env.PORT || 4000;
const app = express();

// Railway (and most hosts) sit the app behind a reverse proxy, which adds
// an X-Forwarded-For header. Express needs to be told to trust it,
// otherwise express-rate-limit throws on every request.
app.set("trust proxy", 1);

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

  // CLIENT_URL is the one canonical frontend URL (also used to build the
  // /portal/* login-redirect fallback below, so it must stay a single URL).
  // EXTRA_CLIENT_ORIGINS is optional and comma-separated — use it to allow
  // additional origins (e.g. the bare vercel.app URL, or a www vs. apex
  // domain) through CORS without needing another code change/deploy every
  // time a domain is added or changed.
  const extraOrigins = (process.env.EXTRA_CLIENT_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowedOrigins = [process.env.CLIENT_URL, ...extraOrigins].filter(
    Boolean,
  );

  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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
  app.use("/api/question-import", require("./routes/questionImportRoute"));
  app.use("/api/test-tracking", require("./routes/testTrackingRoute"));
  app.use(
    "/api/enrollment-leads",
    leadLimiter,
    require("./routes/enrollmentLeadRoute"),
  );
  app.use("/api/content", require("./routes/contentRoute"));
  app.use("/api/recorded-classes", require("./routes/recordedClassRoute"));
  app.use("/api/videos", require("./routes/videoRoute"));
  app.use("/api/live-classes", require("./routes/liveClassRoute"));
  app.use("/api/attendance", require("./routes/attendanceRoute"));
  app.use("/api/notifications", require("./routes/notificationRoute"));
  app.use("/api/enrollments", require("./routes/enrollmentRoute"));
  app.use("/api/attachments", require("./routes/attachmentRoute"));
  app.use("/api/answer-sheets", require("./routes/answerSheetRoute"));
  app.use("/api/student-progress", require("./routes/studentProgressRoute"));
  app.use("/api/student-profiles", require("./routes/studentProfileRoute"));
  app.use(
    "/api/performance-analytics",
    require("./routes/performanceAnalyticsRoute"),
  );
  // Public /careers application form — no login required, same spam-limit
  // reasoning as the enrollment-leads form above.
  app.use(
    "/api/career-applications",
    leadLimiter,
    require("./routes/careerApplicationRoute"),
  );

  // Plain server-side redirects (not under /api — these are meant to be
  // full-page browser navigations from a link/button click, not AJAX calls).
  // Each exam category's "test portal" is, for now, the same shared app —
  // see routes/portalRoute.js for the placeholder-URL env vars to swap in
  // once any category gets its own dedicated subdomain/engine.
  app.use("/portal", require("./routes/portalRoute"));

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
