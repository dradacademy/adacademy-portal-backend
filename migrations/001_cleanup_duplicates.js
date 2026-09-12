const mongoose = require("mongoose");
require("dotenv").config();

/**
 * Migration Script: Clean Duplicate Records
 * 
 * This script identifies and removes duplicate records before applying unique constraints.
 * Run with --dry-run flag to see what would be deleted without actually deleting.
 */

const isDryRun = process.argv.includes("--dry-run");

async function cleanDuplicateExamSubmissions() {
  console.log("\n=== Cleaning Duplicate ExamSubmission Records ===");

  const ExamSubmission = mongoose.model(
    "ExamSubmission",
    new mongoose.Schema({}, { strict: false })
  );

  // Find duplicates: same userId + examId + attemptNumber
  const duplicates = await ExamSubmission.aggregate([
    {
      $group: {
        _id: {
          userId: "$userId",
          examId: "$examId",
          attemptNumber: "$attemptNumber",
        },
        count: { $sum: 1 },
        ids: { $push: "$_id" },
        dates: { $push: "$createdAt" },
      },
    },
    {
      $match: { count: { $gt: 1 } },
    },
  ]);

  console.log(`Found ${duplicates.length} duplicate groups`);

  let totalDeleted = 0;

  for (const dup of duplicates) {
    // Keep the most recent submission, delete others
    const sortedIds = dup.ids
      .map((id, index) => ({ id, date: dup.dates[index] }))
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    const toDelete = sortedIds.slice(1).map((item) => item.id);

    console.log(
      `  Group: userId=${dup._id.userId}, examId=${dup._id.examId}, attempt=${dup._id.attemptNumber}`
    );
    console.log(`    Keeping: ${sortedIds[0].id} (${sortedIds[0].date})`);
    console.log(`    Deleting: ${toDelete.length} record(s)`);

    if (!isDryRun) {
      const result = await ExamSubmission.deleteMany({
        _id: { $in: toDelete },
      });
      totalDeleted += result.deletedCount;
    }
  }

  console.log(
    `Total ExamSubmission records ${isDryRun ? "would be" : ""} deleted: ${isDryRun ? duplicates.reduce((sum, d) => sum + (d.count - 1), 0) : totalDeleted}`
  );
}

async function cleanDuplicateUserPass() {
  console.log("\n=== Cleaning Duplicate UserPass Records ===");

  const UserPass = mongoose.model(
    "UserPass",
    new mongoose.Schema({}, { strict: false })
  );

  // Find duplicates: same userId + subject + subTopic + level
  const duplicates = await UserPass.aggregate([
    {
      $group: {
        _id: {
          userId: "$userId",
          subject: "$subject",
          subTopic: "$subTopic",
          level: "$level",
        },
        count: { $sum: 1 },
        ids: { $push: "$_id" },
        dates: { $push: "$createdAt" },
      },
    },
    {
      $match: { count: { $gt: 1 } },
    },
  ]);

  console.log(`Found ${duplicates.length} duplicate groups`);

  let totalDeleted = 0;

  for (const dup of duplicates) {
    // Keep the most recent pass record, delete others
    const sortedIds = dup.ids
      .map((id, index) => ({ id, date: dup.dates[index] }))
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    const toDelete = sortedIds.slice(1).map((item) => item.id);

    console.log(
      `  Group: userId=${dup._id.userId}, subject=${dup._id.subject}, subTopic=${dup._id.subTopic}, level=${dup._id.level}`
    );
    console.log(`    Keeping: ${sortedIds[0].id} (${sortedIds[0].date})`);
    console.log(`    Deleting: ${toDelete.length} record(s)`);

    if (!isDryRun) {
      const result = await UserPass.deleteMany({ _id: { $in: toDelete } });
      totalDeleted += result.deletedCount;
    }
  }

  console.log(
    `Total UserPass records ${isDryRun ? "would be" : ""} deleted: ${isDryRun ? duplicates.reduce((sum, d) => sum + (d.count - 1), 0) : totalDeleted}`
  );
}

async function main() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected successfully");

    if (isDryRun) {
      console.log("\n*** DRY RUN MODE - No changes will be made ***\n");
    }

    await cleanDuplicateExamSubmissions();
    await cleanDuplicateUserPass();

    console.log("\n=== Migration Complete ===");
    if (isDryRun) {
      console.log(
        "Run without --dry-run flag to actually delete duplicate records"
      );
    }

    process.exit(0);
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
}

main();
