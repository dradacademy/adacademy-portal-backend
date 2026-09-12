// const mongoose = require("mongoose");

const examModel = require("../models/examModel");

const migrateExams = async () => {
  try {
    // if (!process.env.MONGO_URI) {
    //   console.error("MONGO_URI not found in .env");
    //   process.exit(1);
    // }

    // await mongoose.connect(process.env.MONGO_URI);
    // console.log("Connected to MongoDB");

    const exams = await examModel.find({
      $or: [
        { questionSets: { $exists: false } },
        { questionSets: { $size: 0 } },
      ],
    });

    console.log(`Found ${exams.length} exams to migrate.`);

    for (const exam of exams) {
      if (exam.questions && exam.questions.length > 0) {
        console.log(`Migrating exam: ${exam.name || exam._id}`);

        const defaultSet = {
          name: "Legacy Default Set",
          selectionType: "manual",
          questions: exam.questions, // Use existing question IDs
          config: {
            MCQ: { count: 0 },
            MSQ: { count: 0 },
            "Fill in the Blanks": { count: 0 },
            "Short Answer": { count: 0 },
          },
        };

        exam.questionSets = [defaultSet];
        // We need to save to generate the subdocument ID
        await exam.save();
        
        // Now set it as active
        if (exam.questionSets[0]) {
            exam.activeQuestionSetId = exam.questionSets[0]._id;
            await exam.save();
        }
        
        console.log(`Migrated exam ${exam._id} successfully.`);
      } else {
        console.log(`Skipping exam ${exam._id} (no questions).`);
      }
    }

    console.log("Migration completed.");
    process.exit(0);
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
};

module.exports = { migrateExams };