const mongoose = require("mongoose");
require("dotenv").config();

/**
 * Migration Script: Apply Database Indexes
 * 
 * This script applies all unique constraints and performance indexes
 * to the database. Run this AFTER cleaning duplicates.
 */

async function applyIndexes() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected successfully\n");

    const db = mongoose.connection.db;

    // ===== ExamSubmission Indexes =====
    console.log("=== Applying ExamSubmission Indexes ===");

    try {
      await db
        .collection("examsubmissions")
        .createIndex(
          { userId: 1, examId: 1, attemptNumber: 1 },
          { unique: true }
        );
      console.log(
        "✓ Created unique index on (userId, examId, attemptNumber)"
      );
    } catch (error) {
      if (error.code === 11000) {
        console.error(
          "✗ Failed: Duplicate records exist. Run 001_cleanup_duplicates.js first"
        );
      } else {
        throw error;
      }
    }

    await db
      .collection("examsubmissions")
      .createIndex({ examId: 1, status: 1 });
    console.log("✓ Created index on (examId, status)");

    await db.collection("examsubmissions").createIndex({ userId: 1, pass: 1 });
    console.log("✓ Created index on (userId, pass)");

    // ===== UserPass Indexes =====
    console.log("\n=== Applying UserPass Indexes ===");

    try {
      await db
        .collection("userpasses")
        .createIndex(
          { userId: 1, subject: 1, subTopic: 1, level: 1 },
          { unique: true }
        );
      console.log(
        "✓ Created unique index on (userId, subject, subTopic, level)"
      );
    } catch (error) {
      if (error.code === 11000) {
        console.error(
          "✗ Failed: Duplicate records exist. Run 001_cleanup_duplicates.js first"
        );
      } else {
        throw error;
      }
    }

    // ===== Exam Indexes =====
    console.log("\n=== Applying Exam Indexes ===");

    await db.collection("exams").createIndex({ subject: 1, subTopic: 1, level: 1 });
    console.log("✓ Created index on (subject, subTopic, level)");

    await db.collection("exams").createIndex({ status: 1 });
    console.log("✓ Created index on (status)");

    // ===== AttemptCounter Indexes =====
    console.log("\n=== Applying AttemptCounter Indexes ===");

    await db
      .collection("attemptcounters")
      .createIndex({ userId: 1, examId: 1 }, { unique: true });
    console.log("✓ Created unique index on (userId, examId)");

    // ===== Verify All Indexes =====
    console.log("\n=== Verifying Indexes ===");

    const examSubmissionIndexes = await db
      .collection("examsubmissions")
      .indexes();
    console.log(
      `ExamSubmission indexes: ${examSubmissionIndexes.length} total`
    );

    const userPassIndexes = await db.collection("userpasses").indexes();
    console.log(`UserPass indexes: ${userPassIndexes.length} total`);

    const examIndexes = await db.collection("exams").indexes();
    console.log(`Exam indexes: ${examIndexes.length} total`);

    const attemptCounterIndexes = await db
      .collection("attemptcounters")
      .indexes();
    console.log(`AttemptCounter indexes: ${attemptCounterIndexes.length} total`);

    console.log("\n=== Migration Complete ===");
    console.log("All indexes applied successfully!");

    process.exit(0);
  } catch (error) {
    console.error("\nMigration failed:", error);
    process.exit(1);
  }
}

applyIndexes();
