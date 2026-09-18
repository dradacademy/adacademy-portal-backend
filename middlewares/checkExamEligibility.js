const examModel = require("../models/examModel");

const checkExamEligibility = async (req, res, next) => {
  try {
    const { userId } = req.body;
    const { examCode } = req.body;

    const exam = await examModel
      .findOne({ examCode })
      .populate({
        path: "subject",
        select: "name category subtopics",
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

    // Defense-in-depth category check: getEligibleExamForUser already only
    // ever hands a student exam codes within their own category, but this
    // endpoint can in principle be called directly with any examCode, so
    // the isolation guarantee has to be enforced here too, not just in the
    // listing endpoint.
    if (
      req.user.role === "student" &&
      exam.subject?.category !== req.user.category
    ) {
      return res.status(403).json({
        success: false,
        message: "You are not eligible to attend this exam.",
      });
    }

    const matchingSubtopic = exam.subject.subtopics.find(
      (subtopic) => subtopic._id.toString() === exam.subTopic.toString(),
    );

    exam.subjectName = exam.subject.name;
    exam.subtopicName = matchingSubtopic ? matchingSubtopic.name : null;

    // Every posted, active exam (set) is available to attend regardless of
    // order and regardless of whether other sets in the same
    // subject+subTopic have been completed or passed — there is no
    // sequential unlock anymore (previously order 1 was always open and any
    // later exam required the one immediately before it to be passed
    // first; removed per admin request 2026-09-17 so all sets are visible
    // and attemptable from the moment they're posted). The category check
    // above remains the real access-control gate.
    const isEligible = true;

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
