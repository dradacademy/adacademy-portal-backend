const mongoose = require("mongoose");
const User = require("../../models/userModel");
const Exam = require("../../models/examModel");
const ExamSubmission = require("../../models/examSubmissionSchema");
const Subject = require("../../models/subjectModel");
const Question = require("../../models/questionModel");
require("dotenv").config({ path: "../../.env" });

/**
 * Test Data Generator
 * Creates 100+ students, exams, and submissions for performance testing
 */

async function generateTestData() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected successfully\n");

    // 1. Create test subject and subtopic
    console.log("Creating test subject...");
    let subject = await Subject.findOne({ name: "Performance Test Subject" });
    
    if (!subject) {
      subject = await Subject.create({
        name: "Performance Test Subject",
        subtopics: [
          { name: "Test Subtopic 1" },
          { name: "Test Subtopic 2" },
          { name: "Test Subtopic 3" },
        ],
      });
      console.log("✓ Subject created");
    } else {
      console.log("✓ Subject already exists");
    }

    const subtopicId = subject.subtopics[0]._id;

    // 2. Create 150 test students
    console.log("\nCreating 150 test students...");
    const existingStudents = await User.countDocuments({
      email: /^teststudent\d+@test\.com$/,
    });

    if (existingStudents < 150) {
      const studentsToCreate = 150 - existingStudents;
      const students = [];

      for (let i = existingStudents + 1; i <= 150; i++) {
        students.push({
          username: `TestStudent${i}`,
          email: `teststudent${i}@test.com`,
          registerNumber: `TS${i.toString().padStart(4, "0")}`,
          password: "$2b$10$abcdefghijklmnopqrstuvwxyz123456", // Pre-hashed dummy password
          role: "student",
        });
      }

      await User.insertMany(students);
      console.log(`✓ Created ${studentsToCreate} students`);
    } else {
      console.log("✓ 150 students already exist");
    }

    // 3. Create test questions
    console.log("\nCreating test questions...");
    const existingQuestions = await Question.countDocuments({
      questionText: /^Performance Test Question/,
    });

    if (existingQuestions < 50) {
      const questions = [];
      for (let i = existingQuestions + 1; i <= 50; i++) {
        questions.push({
          subject: subject._id,
          subTopic: subtopicId,
          level: (i % 4) + 1,
          questionType: "MCQ",
          questionText: `Performance Test Question ${i}?`,
          options: ["Option A", "Option B", "Option C", "Option D"],
          correctAnswer: "Option A",
        });
      }

      const createdQuestions = await Question.insertMany(questions);
      console.log(`✓ Created ${createdQuestions.length} questions`);
    } else {
      console.log("✓ 50 questions already exist");
    }

    // 4. Create test exams
    console.log("\nCreating test exams...");
    const existingExams = await Exam.countDocuments({
      examCode: /^PERFTEST/,
    });

    if (existingExams < 10) {
      const questions = await Question.find({
        questionText: /^Performance Test Question/,
      }).limit(20);

      const exams = [];
      for (let i = existingExams + 1; i <= 10; i++) {
        exams.push({
          subject: subject._id,
          subTopic: subtopicId,
          level: (i % 4) + 1,
          examCode: `PERFTEST${i}`,
          passPercentage: 70,
          status: "active",
          shuffleQuestion: false,
          questionSelection: "manual",
          questions: questions.slice(0, 10 + i).map((q) => q._id),
        });
      }

      await Exam.insertMany(exams);
      console.log(`✓ Created ${exams.length} exams`);
    } else {
      console.log("✓ 10 exams already exist");
    }

    // 5. Create exam submissions for students
    console.log("\nCreating exam submissions...");
    const students = await User.find({
      email: /^teststudent\d+@test\.com$/,
    }).limit(150);
    const exams = await Exam.find({ examCode: /^PERFTEST/ }).populate(
      "questions"
    );

    let submissionsCreated = 0;

    for (let i = 0; i < students.length; i++) {
      const student = students[i];
      const numExams = Math.min(3, exams.length); // Each student takes 3 exams

      for (let j = 0; j < numExams; j++) {
        const exam = exams[j];

        // Check if submission already exists
        const exists = await ExamSubmission.findOne({
          userId: student._id,
          examId: exam._id,
        });

        if (!exists) {
          const examData = exam.questions.map((q) => ({
            questionId: q._id,
            studentAnswer: "Option A",
            correctAnswer: q.correctAnswer,
            isRight: "Option A" === q.correctAnswer ? "Correct" : "Incorrect",
          }));

          const obtainedMark = examData.filter((q) => q.isRight === "Correct")
            .length;
          const pass = (obtainedMark / examData.length) * 100 >= exam.passPercentage;

          await ExamSubmission.create({
            userId: student._id,
            examId: exam._id,
            attemptNumber: 1,
            examData: examData,
            timetaken: 1800,
            obtainedMark: obtainedMark,
            pass: pass,
            status: "completed",
          });

          submissionsCreated++;
        }
      }

      if ((i + 1) % 10 === 0) {
        console.log(`  Processed ${i + 1}/${students.length} students...`);
      }
    }

    console.log(`✓ Created ${submissionsCreated} new submissions`);

    // Summary
    console.log("\n=== Test Data Summary ===");
    const totalStudents = await User.countDocuments({
      email: /^teststudent\d+@test\.com$/,
    });
    const totalExams = await Exam.countDocuments({ examCode: /^PERFTEST/ });
    const totalSubmissions = await ExamSubmission.countDocuments({});

    console.log(`Students: ${totalStudents}`);
    console.log(`Exams: ${totalExams}`);
    console.log(`Submissions: ${totalSubmissions}`);

    console.log("\n✓ Test data generation complete!");
    process.exit(0);
  } catch (error) {
    console.error("Error generating test data:", error);
    process.exit(1);
  }
}

generateTestData();
