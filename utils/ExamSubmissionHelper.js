// A strict "is this whole string a plain number" check — plain integers/
// decimals ("7", "-3.2") and JS's own exponential notation ("7e-7",
// "1.2E+3"). Deliberately stricter than plain `Number()`/`parseFloat()`
// (which both accept things like "", " ", "0x1F", or silently truncate
// trailing garbage) so it only ever matches a fully-numeric string.
const PLAIN_NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

// "<coefficient> <x|×|*> <base> <^|**> <exponent>" scientific/power
// notation, coefficient optional (defaults to 1) — e.g. "10^-7",
// "10**-7", "1.5 x 10^-7", "1.5*10^-7", "2^3". Captures: [1]=coefficient
// (without its trailing x/×/* — stripped by the group above it),
// [2]=base, [3]=exponent.
const POWER_NOTATION_RE =
  /^(?:([+-]?(?:\d+\.?\d*|\.\d+))\s*[x×*]\s*)?([+-]?(?:\d+\.?\d*|\.\d+))\s*(?:\^|\*\*)\s*([+-]?(?:\d+\.?\d*|\.\d+))$/i;

// Parses a numeric answer string into a plain JS number, accepting several
// equivalent notations an admin (setting the correct answer) or a student
// (typing an answer) might use for the same value:
//   "0.0000007"          -> 7e-7  (plain decimal — always worked)
//   "7e-7" / "7E-7"       -> 7e-7  (JS exponential notation — always worked)
//   "10^-7"               -> 1e-7  (caret power notation — plain
//                                    `parseFloat` stops at the "^" and
//                                    silently returns 10, which is the bug
//                                    this fixes: "10^-7" and "0.0000007"
//                                    must both be accepted as the same
//                                    answer)
//   "10**-7"              -> 1e-7  (double-star power notation)
//   "1.5 x 10^-7" / "1.5*10^-7" / "1.5×10^-7" -> 1.5e-7 (coefficient ×
//                                    base^exponent scientific notation)
// Returns NaN for anything not recognizably numeric, same contract as
// parseFloat, so existing NaN handling around this function keeps working.
const parseNumericAnswer = (raw) => {
  if (raw === null || raw === undefined) return NaN;
  const str = String(raw).trim();
  if (str === "") return NaN;

  if (PLAIN_NUMBER_RE.test(str)) {
    return Number(str);
  }

  const powerMatch = str.replace(/\s+/g, " ").match(POWER_NOTATION_RE);
  if (powerMatch) {
    const [, coefficientRaw, baseRaw, exponentRaw] = powerMatch;
    const coefficient = coefficientRaw === undefined ? 1 : Number(coefficientRaw);
    const base = Number(baseRaw);
    const exponent = Number(exponentRaw);
    if (!Number.isNaN(coefficient) && !Number.isNaN(base) && !Number.isNaN(exponent)) {
      return coefficient * Math.pow(base, exponent);
    }
  }

  return NaN;
};

// Shared by getAnswerStatus/calculateMarks for a "Fill in the Blanks"
// question flagged isNumericAnswer (the GATE-style Numerical Answer Type
// keypad — see NumericKeypad.jsx). Compares by VALUE rather than by exact
// string, so "2.3", "2.30", and "2.300" all match a stored correct answer
// of "2.3" — an exact-string comparison (the non-numeric path below) would
// wrongly mark those Incorrect just for formatting/trailing-zero
// differences. Also accepts equivalent notations on either side via
// `parseNumericAnswer` above — e.g. an admin-entered correct answer of
// "10^-7" matches a student-entered "0.0000007" and vice versa. A small
// epsilon absorbs floating-point rounding, not intended as an
// answer-tolerance/range feature.
const NUMERIC_MATCH_EPSILON = 1e-9;
const isNumericMatch = (correctAnswers, studentAnswer) => {
  const studentNum = parseNumericAnswer(studentAnswer);
  if (Number.isNaN(studentNum)) return false;
  return correctAnswers.some((ans) => {
    const ansNum = parseNumericAnswer(ans);
    return !Number.isNaN(ansNum) && Math.abs(ansNum - studentNum) < NUMERIC_MATCH_EPSILON;
  });
};

const getAnswerStatus = ({
  questionType,
  correctAnswers,
  studentAnswer,
  isNumericAnswer,
}) => {
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
      const isCorrect = isNumericAnswer
        ? isNumericMatch(correctAnswers, studentAnswer)
        : correctAnswers.some(
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
        isNumericAnswer: question.isNumericAnswer,
      })
    : "Skipped";

  return {
    ...studQuestion,
    isRight: status,
    correctAnswer: question.correctAnswers,
  };
};

const calculateMarks = (question, studQuestion, positiveMark, negativeMark) => {
  const { questionType, correctAnswers, isNumericAnswer } = question;
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

      const isCorrect = isNumericAnswer
        ? isNumericMatch(correctAnswers, studentAnswer)
        : correctAnswers.some(
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

/**
 * Calculate Speed % and Accuracy % for a completed submission.
 * Speed % = (questions attended / total questions) * 100.
 * Accuracy % = (correct answers / questions attended) * 100, or null when
 * zero questions were attended (avoids a divide-by-zero / misleading 0%).
 *
 * Deliberate scoping decision: only `isRight === "Correct"` counts toward
 * accuracy's numerator — a "Partially Correct" answer counts as attended
 * (it wasn't skipped) but not correct. This matches the admin's stated
 * formula literally.
 * @param {Array} enhancedExamData - submission.examData after evaluateQuestion (each has isRight)
 * @param {Number} totalQuestions - total question count for the exam
 * @returns {{questionsAttended: Number, speedPercent: Number, accuracyPercent: (Number|null)}}
 */
const calculateSpeedAndAccuracy = (enhancedExamData, totalQuestions) => {
  const attended = enhancedExamData.filter((q) => q.isRight !== "Skipped").length;
  const correct = enhancedExamData.filter((q) => q.isRight === "Correct").length;

  return {
    questionsAttended: attended,
    speedPercent: totalQuestions > 0 ? (attended / totalQuestions) * 100 : 0,
    accuracyPercent: attended > 0 ? (correct / attended) * 100 : null,
  };
};

module.exports = {
  evaluateQuestion,
  calculateMarks,
  parseNumericAnswer,
  getMarksByLevel,
  resolveQuestionMarks,
  resolveQuestionDuration,
  calculateTotalPossibleMarks,
  validateMarks,
  calculateSpeedAndAccuracy,
};
