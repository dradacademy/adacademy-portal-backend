const getAnswerStatus = ({ questionType, correctAnswers, studentAnswer }) => {
  if (
    !studentAnswer ||
    (Array.isArray(studentAnswer) && studentAnswer.length === 0)
  ) {
    return "Skipped";
  }

  const normalize = (str) => str.toLowerCase().trim();
  const normalizeNoSpace = (str) => str.toLowerCase().replace(/\s+/g, "");

  switch (questionType) {
    case "MCQ": {
      const isCorrect = correctAnswers
        .map(normalize)
        .includes(normalize(studentAnswer));

      return isCorrect ? "Correct" : "Incorrect";
    }

    case "Fill in the Blanks": {
      const isCorrect = correctAnswers.some(
        (ans) => normalizeNoSpace(ans) === normalizeNoSpace(studentAnswer),
      );

      return isCorrect ? "Correct" : "Incorrect";
    }

    case "MSQ": {
      const correctSet = new Set(correctAnswers.map(normalize));
      const studentSet = new Set(studentAnswer.map(normalize));

      const correctCount = [...studentSet].filter((a) =>
        correctSet.has(a),
      ).length;

      const hasWrong = [...studentSet].some((a) => !correctSet.has(a));

      if (correctCount === correctSet.size) return "Correct";
      return "Incorrect";
    }

    case "Short Answer": {
      const matchCount = correctAnswers.filter((word) =>
        studentAnswer.toLowerCase().includes(word.toLowerCase()),
      ).length;

      if (matchCount === 0) return "Incorrect";
      if (matchCount === correctAnswers.length) return "Correct";

      return "Partially Correct";
    }

    default:
      return "Skipped";
  }
};

const evaluateQuestion = (question, studQuestion) => {
  const status = studQuestion.isAnswered
    ? getAnswerStatus({
        questionType: question.questionType,
        correctAnswers: question.correctAnswers,
        studentAnswer: studQuestion.studentAnswer,
      })
    : "Skipped";

  return {
    ...studQuestion,
    isRight: status,
    correctAnswer: question.correctAnswers,
  };
};

const calculateMarks = (question, studQuestion, positiveMark, negativeMark) => {
  const { questionType, correctAnswers } = question;
  const studentAnswer = studQuestion.studentAnswer;

  if (
    !studentAnswer ||
    (Array.isArray(studentAnswer) && studentAnswer.length === 0)
  ) {
    return 0;
  }

  const normalize = (str) => str.toLowerCase().trim();

  switch (questionType) {
    case "MCQ": {
      const isCorrect = correctAnswers
        .map(normalize)
        .includes(normalize(studentAnswer));
      return isCorrect ? positiveMark : -negativeMark;
    }

    case "Fill in the Blanks": {
      const normalizeNoSpace = (str) => str.toLowerCase().replace(/\s+/g, "");

      const isCorrect = correctAnswers.some(
        (ans) => normalizeNoSpace(ans) === normalizeNoSpace(studentAnswer),
      );
      return isCorrect ? positiveMark : 0;
    }

    case "MSQ": {
      const correctSet = new Set(correctAnswers.map(normalize));
      const studentSet = new Set(studentAnswer.map(normalize));

      const hasWrong = [...studentSet].some((a) => !correctSet.has(a));
      const correctCount = [...studentSet].filter((a) =>
        correctSet.has(a),
      ).length;

      if (!hasWrong && correctCount === correctSet.size) {
        return (correctCount / correctSet.size) * positiveMark;
      }
      return 0;
    }

    case "Short Answer": {
      const matchCount = correctAnswers.filter((word) =>
        studentAnswer.toLowerCase().includes(word.toLowerCase()),
      ).length;

      return matchCount > 0
        ? (matchCount / correctAnswers.length) * positiveMark
        : 0;
    }

    default:
      return 0;
  }
};

const getMarksByLevel = (mark, level) => {
  return {
    positive: mark[`level${level}Mark`],
    negative: mark[`level${level}NegativeMark`],
  };
};

/**
 * Calculate total possible marks for an exam
 * @param {Number} questionCount - Number of questions in exam
 * @param {Number} positiveMark - Marks per correct answer
 * @returns {Number} Total possible marks
 */
const calculateTotalPossibleMarks = (questionCount, positiveMark) => {
  return questionCount * positiveMark;
};

/**
 * Validate and constrain marks within valid range
 * @param {Number} obtainedMarks - Marks obtained by student
 * @param {Number} maximumMarks - Maximum possible marks
 * @returns {Number} Validated marks (0 <= marks <= maximum)
 */
const validateMarks = (obtainedMarks, maximumMarks) => {
  // Floor at 0 (prevent negative total)
  if (obtainedMarks < 0) {
    console.warn(`Marks below zero detected: ${obtainedMarks}, setting to 0`);
    return 0;
  }

  // Cap at maximum (prevent exceeding total)
  if (obtainedMarks > maximumMarks) {
    console.error(
      `Marks exceed maximum! Obtained: ${obtainedMarks}, Maximum: ${maximumMarks}, capping at maximum`,
    );
    return maximumMarks;
  }

  return obtainedMarks;
};

module.exports = {
  evaluateQuestion,
  calculateMarks,
  getMarksByLevel,
  calculateTotalPossibleMarks,
  validateMarks,
};
