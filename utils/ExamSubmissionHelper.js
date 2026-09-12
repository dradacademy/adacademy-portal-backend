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
 * Resolve the effective positive/negative marks for a single question.
 * A question's own `marks`/`negativeMark` (set individually by the admin)
 * take priority; when either is null/undefined, fall back to the global
 * level-based Mark config for that question's level.
 * @param {Object} question - Question doc/subdoc (needs level, marks, negativeMark)
 * @param {Object} markConfig - Global Mark config (level1Mark, level1NegativeMark, ...)
 * @returns {{positive: Number, negative: Number}}
 */
const resolveQuestionMarks = (question, markConfig) => {
  const fallback = markConfig
    ? getMarksByLevel(markConfig, question.level)
    : { positive: 0, negative: 0 };

  return {
    positive: question.marks ?? fallback.positive,
    negative: question.negativeMark ?? fallback.negative,
  };
};

/**
 * Resolve the effective duration (in seconds) for a single question.
 * A question's own `duration` takes priority; otherwise falls back to the
 * global level-based Duration config for that question's level, and
 * finally to a hardcoded 3600s safety default if even that is missing.
 * @param {Object} question - Question doc/subdoc (needs level, duration)
 * @param {Object} durationConfig - Global Duration config (level1Duration, ...)
 * @returns {Number} duration in seconds
 */
const resolveQuestionDuration = (question, durationConfig) => {
  const fallback = durationConfig
    ? durationConfig[`level${question.level}Duration`]
    : null;

  return question.duration ?? fallback ?? 3600;
};

/**
 * Calculate total possible marks for an exam by summing each question's own
 * resolved positive marks (per-question override, or level-based fallback).
 * @param {Array} questions - Array of question docs/subdocs
 * @param {Object} markConfig - Global Mark config
 * @returns {Number} Total possible marks
 */
const calculateTotalPossibleMarks = (questions, markConfig) => {
  return questions.reduce(
    (sum, q) => sum + resolveQuestionMarks(q, markConfig).positive,
    0
  );
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
  resolveQuestionMarks,
  resolveQuestionDuration,
  calculateTotalPossibleMarks,
  validateMarks,
};
