const examModel = require("../models/examModel");
const questionModel = require("../models/questionModel");
const examSubmissionSchema = require("../models/examSubmissionSchema");
const examPassModel = require("../models/examPassModel");
const markModel = require("../models/markModel");
const { ensureMarkConfigExists } = require("../controllers/markController");
const {
  getAnswerStatus,
  calculateMarks,
  resolveQuestionMarks,
  calculateTotalPossibleMarks,
  validateMarks,
  calculateSpeedAndAccuracy,
} = require("./ExamSubmissionHelper");

/**
 * Re-grades every COMPLETED submission for one exam against that exam's
 * CURRENT question data (answer keys, NAT range settings, per-question
 * marks, pass percentage) instead of whatever was in effect the moment
 * each student submitted.
 *
 * Why this exists: an admin can edit an exam's answer key at any time —
 * e.g. switching a "Fill in the Blanks" NAT question from an exact value
 * to a range, or correcting a wrong answer key — even after students have
 * already completed it (see updateExam). Without this, a student's stored
 * marks/pass-fail/per-question isRight would silently keep reflecting the
 * OLD answer key forever, since they're computed once at submission time
 * and never touched again.
 *
 * Called automatically after every updateExam save (so an answer-key edit
 * retroactively corrects already-completed attempts, per the admin's
 * standing requirement that a change apply to already-completed exams,
 * not just new ones) and also exposed as an on-demand admin action, for
 * exams edited before this existed.
 *
 * Deliberately does NOT touch: attemptNumber, timetaken, completedAt,
 * status, reviews — only the graded fields. Submissions still "started"
 * (in progress, not yet submitted) are left alone entirely.
 *
 * Regrades against the exam's FULL question pool (poolQuestions), not
 * just its currently-active question set — a question the admin has
 * since removed from rotation may still be sitting inside an older
 * submission's examData, and it should still be regraded correctly.
 * Total-possible-marks / the pass mark are computed from the exam's
 * CURRENT active question set (mirroring submitExam's own formula) so a
 * regraded attempt is judged exactly as a fresh attempt would be today.
 *
 * @param {String|mongoose.Types.ObjectId} examId
 * @returns {Promise<Object>} summary: { totalChecked, marksChanged, passChanged, changes }
 */
const regradeExamSubmissions = async (examId) => {
  const examDetails = await examModel
    .findById(examId)
    .populate("questions")
    .lean();

  if (!examDetails) {
    return { totalChecked: 0, marksChanged: 0, passChanged: 0, changes: [] };
  }

  const allQuestions =
    Array.isArray(examDetails.poolQuestions) && examDetails.poolQuestions.length
      ? await questionModel.find({ _id: { $in: examDetails.poolQuestions } }).lean()
      : examDetails.questions || [];

  // Same allNumericAnswerKeypad override submitExam applies at grading
  // time, so regrading stays consistent with how each question was
  // actually presented/graded to the student.
  if (examDetails.allNumericAnswerKeypad) {
    allQuestions.forEach((q) => {
      if (q.questionType === "Fill in the Blanks") q.isNumericAnswer = true;
    });
    (examDetails.questions || []).forEach((q) => {
      if (q.questionType === "Fill in the Blanks") q.isNumericAnswer = true;
    });
  }

  const questionMap = new Map(allQuestions.map((q) => [q._id.toString(), q]));

  let mark = await markModel.findById("mark-based-on-levels");
  if (!mark) {
    await ensureMarkConfigExists();
    mark = await markModel.findById("mark-based-on-levels");
  }

  const totalPossibleMarks = calculateTotalPossibleMarks(
    examDetails.questions || [],
    mark,
  );
  const passMark = (examDetails.passPercentage / 100) * totalPossibleMarks;

  const submissions = await examSubmissionSchema.find({
    examId,
    status: "completed",
  });

  const changes = [];
  let marksChanged = 0;
  let passChanged = 0;

  for (const submission of submissions) {
    const priorExamData = submission.examData.map((sq) =>
      sq.toObject ? sq.toObject() : sq,
    );

    const enhancedExamData = priorExamData.map((studQuestion) => {
      const question = questionMap.get(String(studQuestion.questionId));
      if (!question) return studQuestion;

      const studentAnswer = studQuestion.studentAnswer;
      const hasAnswer = !(
        studentAnswer === null ||
        studentAnswer === undefined ||
        studentAnswer === "" ||
        (Array.isArray(studentAnswer) && studentAnswer.length === 0)
      );

      const status = hasAnswer
        ? getAnswerStatus({
            questionType: question.questionType,
            correctAnswers: question.correctAnswers,
            studentAnswer,
            isNumericAnswer: question.isNumericAnswer,
            natAnswerMode: question.natAnswerMode,
            rangeMin: question.rangeMin,
            rangeMax: question.rangeMax,
          })
        : "Skipped";

      return {
        ...studQuestion,
        isRight: status,
        correctAnswer: question.correctAnswers,
      };
    });

    const newObtainedMarksRaw = priorExamData.reduce((total, studQuestion) => {
      const question = questionMap.get(String(studQuestion.questionId));
      if (!question) return total;
      const { positive, negative } = resolveQuestionMarks(question, mark);
      return total + calculateMarks(question, studQuestion, positive, negative);
    }, 0);

    const newObtainedMarks = Number(
      validateMarks(newObtainedMarksRaw, totalPossibleMarks).toFixed(2),
    );
    const newPass = newObtainedMarks >= passMark;

    const { speedPercent, accuracyPercent } = calculateSpeedAndAccuracy(
      enhancedExamData,
      (examDetails.questions || []).length,
    );

    const oldObtainedMarks = submission.obtainedMark ?? 0;
    const oldPass = submission.pass;

    const marksDiffers = Math.abs(oldObtainedMarks - newObtainedMarks) > 1e-9;
    const passDiffers = oldPass !== newPass;
    const isRightDiffers = enhancedExamData.some((q, i) => {
      const prior = priorExamData[i];
      return prior && prior.isRight !== q.isRight;
    });

    if (!marksDiffers && !passDiffers && !isRightDiffers) continue;

    submission.examData = enhancedExamData;
    submission.obtainedMark = newObtainedMarks;
    submission.pass = newPass;
    submission.speedPercent = Number(speedPercent.toFixed(2));
    submission.accuracyPercent =
      accuracyPercent === null ? null : Number(accuracyPercent.toFixed(2));

    await submission.save();

    if (marksDiffers) marksChanged += 1;
    if (passDiffers) passChanged += 1;

    changes.push({
      submissionId: submission._id,
      userId: submission.userId,
      attemptNumber: submission.attemptNumber,
      oldObtainedMark: oldObtainedMarks,
      newObtainedMark: newObtainedMarks,
      oldPass,
      newPass,
    });

    // Mirrors submitExam's own behaviour: a submission that now passes
    // gets (or keeps) an ExamPass record. Deliberately not reversed on a
    // flip to failing — submitExam itself never revokes a prior pass
    // either, so regrading stays consistent with that existing rule
    // rather than inventing a stricter one here.
    if (newPass) {
      await examPassModel.findOneAndUpdate(
        { userId: submission.userId, examId: examDetails._id },
        {
          pass: true,
          subject: examDetails.subject,
          subTopic: examDetails.subTopic,
          order: examDetails.order,
        },
        { upsert: true },
      );
    }
  }

  return {
    totalChecked: submissions.length,
    marksChanged,
    passChanged,
    changes,
  };
};

module.exports = { regradeExamSubmissions };
