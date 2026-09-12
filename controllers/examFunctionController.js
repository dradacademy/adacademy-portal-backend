const examModel = require("../models/examModel");
const examSubmissionSchema = require("../models/examSubmissionSchema");
const markModel = require("../models/markModel");
const questionModel = require("../models/questionModel");
const Subject = require("../models/subjectModel");
const userPassSchema = require("../models/userPassSchema");
const { ensureMarkConfigExists } = require("./markController");
const { retryTransaction } = require("../utils/transactionHelper");

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

    // Fetch user's passed exams
    const userProgress = await userPassSchema
      .find({ userId, pass: true })
      .select("subject subTopic level");

    let eligibleExams = new Map();

    // Build a set of already passed exams for quick lookup
    const passedSet = new Set(
      userProgress.map((p) => `${p.subject}-${p.subTopic}-${p.level}`)
    );

    for (let progress of userProgress) {
      const subjectId = progress.subject;
      const subTopicId = progress.subTopic;

      const levelsToCheck = [
        progress.level - 2,
        progress.level - 1,
        progress.level + 1,
      ];

      for (let level of levelsToCheck) {
        if (level >= 1 && level <= 4) {
          const key = `${subjectId}-${subTopicId}-${level}`;
          if (!passedSet.has(key)) {
            eligibleExams.set(key, {
              subjectId,
              subTopicId,
              level,
            });
          }
        }
      }
    }

    // For subjects/subtopics the user has never touched, show level 1
    const allSubjects = await Subject.find().select("_id name subtopics");

    for (let subject of allSubjects) {
      for (let subTopic of subject.subtopics) {
        const key = `${subject._id}-${subTopic._id}-1`;

        // Check if the user has passed anything in this subject-subtopic
        const hasProgress = userProgress.some(
          (p) =>
            p.subject.toString() === subject._id.toString() &&
            p.subTopic.toString() === subTopic._id.toString()
        );

        if (!hasProgress && !eligibleExams.has(key)) {
          eligibleExams.set(key, {
            subjectId: subject._id,
            subTopicId: subTopic._id,
            level: 1,
          });
        }
      }
    }

    // Fetch exam documents
    const eligibleExamList = await Promise.all(
      Array.from(eligibleExams.values()).map(async (item) => {
        return examModel.find({
          subject: item.subjectId,
          subTopic: item.subTopicId,
          level: item.level,
          status: "active",
        });
      })
    );

    let flattenedExams = eligibleExamList.flat();

    // Add readable names
    flattenedExams = flattenedExams.map((exam) => {
      const subject = allSubjects.find((sub) => sub._id.equals(exam.subject));
      let subTopicName = "";
      if (subject) {
        const subTopic = subject.subtopics.find((st) =>
          st._id.equals(exam.subTopic)
        );
        if (subTopic) subTopicName = subTopic.name;
      }

      return {
        _id: exam._id,
        subjectId: exam.subject,
        subjectName: subject ? subject.name : null,
        subTopicId: exam.subTopic,
        subTopicName: subTopicName || null,
        questions: exam.questions,
        level: exam.level,
        status: exam.status,
        createdAt: exam.createdAt,
        updatedAt: exam.updatedAt,
        __v: exam.__v,
        examCode: exam.examCode,
        passPercentage: exam.passPercentage,
      };
    });

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
    const { userId, subjectId, subTopicId, level } = req.body;

    let markData = await markModel.findById("mark-based-on-levels");
    if (!markData) {
      await ensureMarkConfigExists();
      markData = await markModel.findById("mark-based-on-levels");
    }

    let positiveMark = markData.level1Mark;

    if (level === 2) {
      positiveMark = markData.level2Mark;
    } else if (level === 3) {
      positiveMark = markData.level3Mark;
    } else if (level === 4) {
      positiveMark = markData.level4Mark;
    }

    const existingPass = await userPassSchema.findOne({
      userId,
      subject: subjectId,
      subTopic: subTopicId,
      level,
      pass: true,
    });

    if (existingPass) {
      return res.status(400).json({
        success: false,
        message: "User has already passed this exam.",
      });
    }

    const exam = await examModel.findOne({
      subject: subjectId,
      subTopic: subTopicId,
      level,
      status: "active",
    });

    if (!exam) {
      return res.status(404).json({
        success: false,
        message:
          "Exam not found for the specified subject, subtopic, and level.",
      });
    }

    const enhancedExamData = await Promise.all(
      exam.questions.map(async (questionId) => {
        const questionData = await questionModel.findById(questionId);
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

    const obtainedMark = exam.questions.length * positiveMark;

    await examSubmissionSchema.create({
      userId,
      examId: exam._id,
      attemptNumber: 1,
      obtainedMark,
      examData: enhancedExamData,
      pass: true,
    });

    const newPass = new userPassSchema({
      userId,
      subject: subjectId,
      subTopic: subTopicId,
      level,
      pass: true,
    });

    await newPass.save();

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
    const { userId, subjectId, subTopicId, level } = req.body;

    if (!userId || !subjectId || !subTopicId || !level) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields.",
      });
    }

    const existingPass = await userPassSchema.findOne({
      userId,
      subject: subjectId,
      subTopic: subTopicId,
      level,
      pass: true,
    });

    if (!existingPass) {
      return res.status(404).json({
        success: false,
        message:
          "No passed exam found for the specified user, subject, subtopic, and level.",
      });
    }

    const examData = await examModel.findOne({
      subject: subjectId,
      subTopic: subTopicId,
      level,
      status: "active",
    });

    // Delete both UserPass and ExamSubmission in a transaction
    await retryTransaction(async (session) => {
      await userPassSchema.deleteOne({ _id: existingPass._id }, { session });

      await examSubmissionSchema.deleteOne(
        {
          userId,
          examId: examData._id,
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

// const getEligibleExamForUser = async (req, res) => {
//   try {
//     const { userId } = req.params;

//     const userProgress = await userPassSchema
//       .find({ userId, pass: true })
//       .select("subject subTopic level");

//     let eligibleExams = new Map();

//     for (let progress of userProgress) {
//       const nextLevel = progress.level + 1;
//       const prevLevel = progress.level - 1;
//       const prevPrevLevel = progress.level - 2;
//       if (prevLevel > 1 && prevLevel <= 4) {
//         const data = await userPassSchema.findOne({
//           userId,
//           subject: progress.subject,
//           subTopic: progress.subTopic,
//           level: prevLevel,
//           pass: true,
//         });
//         if (!data) {
//           eligibleExams.set(`${progress.subject}-${progress.subTopic}`, {
//             subjectId: progress.subject,
//             subTopicId: progress.subTopic,
//             level: prevLevel,
//           });
//         }
//       }
//       if (prevPrevLevel > 1 && prevPrevLevel <= 4) {
//         const data = await userPassSchema.findOne({
//           userId,
//           subject: progress.subject,
//           subTopic: progress.subTopic,
//           level: prevPrevLevel,
//           pass: true,
//         });
//         if (!data) {
//           eligibleExams.set(`${progress.subject}-${progress.subTopic}`, {
//             subjectId: progress.subject,
//             subTopicId: progress.subTopic,
//             level: prevPrevLevel,
//           });
//         }
//       }
//       if (nextLevel <= 4) {
//         eligibleExams.set(`${progress.subject}-${progress.subTopic}`, {
//           subjectId: progress.subject,
//           subTopicId: progress.subTopic,
//           level: nextLevel,
//         });
//       }
//     }

//     const allSubjects = await Subject.find().select("_id name subtopics");

//     for (let subject of allSubjects) {
//       for (let subTopic of subject.subtopics) {
//         const key = `${subject._id}-${subTopic._id}`;
//         if (!eligibleExams.has(key)) {
//           eligibleExams.set(key, {
//             subjectId: subject._id,
//             subTopicId: subTopic._id,
//             level: 1,
//           });
//         }
//       }
//     }

//     const eligibleExamList = await Promise.all(
//       Array.from(eligibleExams.values()).map(async (item) => {
//         return examModel.find({
//           subject: item.subjectId,
//           subTopic: item.subTopicId,
//           level: item.level,
//           status: "active",
//         });
//       })
//     );

//     let flattenedExams = eligibleExamList.flat();

//     flattenedExams = flattenedExams.map((exam) => {
//       const subject = allSubjects.find((sub) => sub._id.equals(exam.subject));
//       let subTopicName = "";
//       if (subject) {
//         const subTopic = subject.subtopics.find((st) =>
//           st._id.equals(exam.subTopic)
//         );
//         if (subTopic) subTopicName = subTopic.name;
//       }
//       return {
//         _id: exam._id,
//         subjectId: exam.subject,
//         subjectName: subject ? subject.name : null,
//         subTopicId: exam.subTopic,
//         subTopicName: subTopicName || null,
//         questions: exam.questions,
//         level: exam.level,
//         status: exam.status,
//         createdAt: exam.createdAt,
//         updatedAt: exam.updatedAt,
//         __v: exam.__v,
//         examCode: exam.examCode,
//         passPercentage: exam.passPercentage,
//       };
//     });

//     res.status(200).json(flattenedExams);
//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       message: "Failed to get eligible exams for the user",
//       error: error.message,
//     });
//   }
// };
