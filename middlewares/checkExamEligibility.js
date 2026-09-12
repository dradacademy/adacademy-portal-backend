const examPassModel = require("../models/examPassModel");
const examModel = require("../models/examModel");

const checkExamEligibility = async (req, res, next) => {
  try {
    const { userId } = req.body;
    const { examCode } = req.body;

    const exam = await examModel
      .findOne({ examCode })
      .populate({
        path: "subject",
        select: "name subtopics",
      })
      .populate({
        path: "questions",
        select: "-correctAnswers",
      })
      .lean();

    if (!exam) {
      return res.status(404).json({
        success: false,
        message: "Exam not found",
      });
    }

    const matchingSubtopic = exam.subject.subtopics.find(
      (subtopic) => subtopic._id.toString() === exam.subTopic.toString(),
    );

    exam.subjectName = exam.subject.name;
    exam.subtopicName = matchingSubtopic ? matchingSubtopic.name : null;

    // Progression is now order-based: exam order 1 is always open; any
    // later exam requires the exam immediately before it (order - 1, in
    // the same subject+subTopic) to have been passed.
    let isEligible = exam.order === 1;

    if (!isEligible) {
      const previousExam = await examModel
        .findOne({
          subject: exam.subject._id,
          subTopic: exam.subTopic,
          order: exam.order - 1,
        })
        .lean();

      isEligible =
        !previousExam || // previous slot missing (e.g. deleted) — fail open
        !!(await examPassModel.findOne({
          userId,
          examId: previousExam._id,
          pass: true,
        }));
    }

    if (isEligible) {
      //  if (
      //       exam.questionSelection &&
      //       exam.questions &&
      //       exam.questions.length > 0
      //     ) {
      //       const questionsByType = exam.questions.reduce((acc, question) => {
      //         const type = question.questionType;
      //         if (!acc[type]) {
      //           acc[type] = [];
      //         }
      //         acc[type].push(question);
      //         return acc;
      //       }, {});

      //       const selectedQuestions = [];

      //       Object.keys(exam.questionSelection).forEach((questionType) => {
      //         const typeQuestions = questionsByType[questionType] || [];
      //         const { startIndex, count } = exam.questionSelection[questionType];

      //         if (count > 0 && typeQuestions.length > startIndex) {
      //           const selected = typeQuestions.slice(
      //             startIndex,
      //             startIndex + count
      //           );
      //           selectedQuestions.push(...selected);
      //         }
      //       });

      //       exam.questions = selectedQuestions;
      //     }

      req.exam = exam;
      return next();
    } else {
      return res.status(403).json({
        success: false,
        message: "You are not eligible to attend this exam.",
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error checking exam eligibility",
      error: error.message,
    });
  }
};

module.exports = checkExamEligibility;
