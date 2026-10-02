const { looksNumericAnswerKey } = require("./ExamSubmissionHelper");

// Marks, IN MEMORY ONLY (nothing is saved), every "Fill in the Blanks"
// question whose correct answer(s) are all numbers as a numeric (NAT) question,
// so the student's exam page shows the on-screen number pad for it without
// anyone having to tick a box. A blank that expects words (a non-numeric or
// mixed answer key) keeps its normal text box - the number pad can only type
// digits, ".", "-" and "x10^", so it could never accept a word.
// An explicit isNumericAnswer already set by the admin is left as it is.
const markNumericKeypadQuestions = (questions) => {
  if (!Array.isArray(questions)) return questions;
  questions.forEach((q) => {
    if (
      q &&
      typeof q === "object" &&
      q.questionType === "Fill in the Blanks" &&
      !q.isNumericAnswer &&
      looksNumericAnswerKey(q.correctAnswers)
    ) {
      q.isNumericAnswer = true;
    }
  });
  return questions;
};

// What a student is allowed to receive for the questions of an exam they are
// about to attend: the derived number-pad flag above, then the answer key
// (correctAnswers) removed - exactly what the old `select: "-correctAnswers"`
// did, only now AFTER the flag has been worked out from it. Flagging and
// stripping live in one function so the answer key can never be left in.
const prepareQuestionsForStudent = (questions) => {
  if (!Array.isArray(questions)) return questions;
  markNumericKeypadQuestions(questions);
  questions.forEach((q) => {
    if (q && typeof q === "object") delete q.correctAnswers;
  });
  return questions;
};

module.exports = { markNumericKeypadQuestions, prepareQuestionsForStudent };
