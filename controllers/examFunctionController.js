const examModel = require("../models/examModel");
const examSubmissionSchema = require("../models/examSubmissionSchema");
const markModel = require("../models/markModel");
const questionModel = require("../models/questionModel");
const Subject = require("../models/subjectModel");
const examPassModel = require("../models/examPassModel");
const { ensureMarkConfigExists } = require("./markController");
const { retryTransaction } = require("../utils/transactionHelper");
const {
  calculateTotalPossibleMarks,
} = require("../utils/ExamSubmissionHelper");

const getEligibleExamForUser = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User ID is required.",
      });
    }

    if (req.user._id.toString() !== userId && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You do not have the required permissions",
      });
    }

    // Fetch user's passed exams (order-based progression now, not level-based)
    const userProgress = await examPassModel
      .find({ userId, pass: true })
      .select("subject subTopic order");

    // Group passed orders by subject+subTopic for quick lookup
    const passedOrdersByKey = new Map(); // `${subject}-${subTopic}` -> Set(order)
    for (const p of userProgress) {
      const key = `${p.subject}-${p.subTopic}`;
      if (!passedOrdersByKey.has(key)) passedOrdersByKey.set(key, new Set());
      passedOrdersByKey.get(key).add(p.order);
    }

    // A student only ever sees exams within their own exam category — this
    // is the main chokepoint that keeps (say) a TNPSC AE student from ever
    // seeing GATE exams, since this endpoint is what the student dashboard
    // uses to list "Available" exams in the first place. An admin viewing
    // this (e.g. via the "attend as any user" path) is not restricted.
    const subjectFilter = {};
    if (req.user.role === "student") {
      if (!req.user.category) {
        // A student with no category assigned yet has nothing to see —
        // fail closed, not open.
        return res.status(200).json([]);
      }
      subjectFilter.category = req.user.category;
    }

    const allSubjects = await Subject.find(subjectFilter).select(
      "_id name subtopics"
    );

    const flattenedExams = [];

    // For every subject+subTopic, the "next eligible" exam is the first
    // (lowest-order) exam not yet passed, provided its predecessor (order-1)
    // has been passed (order 1 is always open).
    for (const subject of allSubjects) {
      for (const subTopic of subject.subtopics) {
        const key = `${subject._id}-${subTopic._id}`;
        const passedOrders = passedOrdersByKey.get(key) || new Set();

        const exams = await examModel
          .find({
            subject: subject._id,
            subTopic: subTopic._id,
            status: "active",
          })
          .sort({ order: 1 });

        for (const exam of exams) {
          if (passedOrders.has(exam.order)) continue; // already passed, keep scanning

          const isEligible =
            exam.order === 1 || passedOrders.has(exam.order - 1);

          if (isEligible) {
            flattenedExams.push({
              _id: exam._id,
              subjectId: exam.subject,
              subjectName: subject.name,
              subTopicId: exam.subTopic,
              subTopicName: subTopic.name,
              questions: exam.questions,
              order: exam.order,
              status: exam.status,
              createdAt: exam.createdAt,
              updatedAt: exam.updatedAt,
              __v: exam.__v,
              examCode: exam.examCode,
              passPercentage: exam.passPercentage,
            });
          }

          // Only the first not-yet-passed exam in the sequence can ever be
          // eligible — stop scanning further orders in this subtopic.
          break;
        }
      }
    }

    res.status(200).json(flattenedExams);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to get eligible exams for the user",
      error: error.message,
    });
  }
};

const manuallyPassExam = async (req, res) => {
  try {
    const { userId, subjectId, subTopicId, examId } = req.body;

    if (!userId || !subjectId || !subTopicId || !examId) {
      return res.status(400).json({
        success: false,
        message: "userId, subjectId, subTopicId and examId are required.",
      });
    }

    let markData = await markModel.findById("mark-based-on-levels");
    if (!markData) {
      await ensureMarkConfigExists();
      markData = await markModel.findById("mark-based-on-levels");
    }

    const existingPass = await examPassModel.findOne({
      userId,
      examId,
      pass: true,
    });

    if (existingPass) {
      return res.status(400).json({
        success: false,
        message: "User has already passed this exam.",
      });
    }

    const exam = await examModel
      .findOne({
        _id: examId,
        subject: subjectId,
        subTopic: subTopicId,
        status: "active",
      })
      .populate("questions");

    if (!exam) {
      return res.status(404).json({
        success: false,
        message:
          "Exam not found for the specified subject, subtopic, and exam.",
      });
    }

    const enhancedExamData = await Promise.all(
      exam.questions.map(async (questionData) => {
        if (!questionData) return null;

        if (questionData.questionType === "MCQ") {
          return {
            questionId: questionData._id,
            studentAnswer: questionData.correctAnswers[0],
            correctAnswer: questionData.correctAnswers,
          };
        } else if (questionData.questionType === "MSQ") {
          return {
            questionId: questionData._id,
            studentAnswer: questionData.correctAnswers.sort(),
            correctAnswer: questionData.correctAnswers,
          };
        } else {
          const studentAnswer =
            questionData.correctAnswers.length > 0
              ? questionData.correctAnswers.join(", ")
              : "";

          return {
            questionId: questionData._id,
            studentAnswer: studentAnswer,
            correctAnswer: questionData.correctAnswers,
          };
        }
      })
    );

    const obtainedMark = calculateTotalPossibleMarks(exam.questions, markData);

    await examSubmissionSchema.create({
      userId,
      examId: exam._id,
      attemptNumber: 1,
      obtainedMark,
      examData: enhancedExamData,
      pass: true,
      completedAt: new Date(),
    });

    await examPassModel.findOneAndUpdate(
      { userId, examId: exam._id },
      {
        pass: true,
        subject: subjectId,
        subTopic: subTopicId,
        order: exam.order,
      },
      { upsert: true }
    );

    res.status(200).json({
      success: true,
      message: "Exam manually marked as passed.",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to manually pass exam",
      error: error.message,
    });
  }
};

const deletePassedExam = async (req, res) => {
  try {
    const { userId, examId } = req.body;

    if (!userId || !examId) {
      return res.status(400).json({
        success: false,
        message: "userId and examId are required.",
      });
    }

    const existingPass = await examPassModel.findOne({
      userId,
      examId,
      pass: true,
    });

    if (!existingPass) {
      return res.status(404).json({
        success: false,
        message: "No passed exam found for the specified user and exam.",
      });
    }

    // Delete both ExamPass and ExamSubmission in a transaction
    await retryTransaction(async (session) => {
      await examPassModel.deleteOne({ _id: existingPass._id }, { session });

      await examSubmissionSchema.deleteOne(
        {
          userId,
          examId,
          pass: true,
        },
        { session }
      );
    });

    res.status(200).json({
      success: true,
      message: "Written exam deleted successfully.",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to delete written exam.",
      error: error.message,
    });
  }
};

module.exports = {
  getEligibleExamForUser,
  manuallyPassExam,
  deletePassedExam,
};

