const mongoose = require("mongoose");
const ExamSubmission = require("../models/examSubmissionSchema");
const NotebookEntry = require("../models/notebookEntryModel");
const Question = require("../models/questionModel");
const Exam = require("../models/examModel");
const { getLatestAttemptsOnly } = require("../utils/latestAttemptHelper");
const { getAnswerStatus } = require("../utils/ExamSubmissionHelper");

// "My Mistakes" notebook (2026-10-08): every question the student got wrong
// or partly wrong in their LATEST completed attempt of each test, plus every
// question they bookmarked, grouped by subject/topic on the page. They can
// re-attempt a question (checked by the same grading code as real tests)
// and mark a mistake as "mastered". Correct answers are only ever returned
// for questions from tests the student has already completed.

const studentHasCompletedQuestion = (userId, questionId) =>
  ExamSubmission.exists({ userId, status: "completed", "examData.questionId": questionId });

const toId = (v) => (mongoose.Types.ObjectId.isValid(v) ? new mongoose.Types.ObjectId(v) : null);

const getNotebook = async (req, res) => {
  try {
    const userId = req.user._id;
    const [submissions, entries] = await Promise.all([
      ExamSubmission.find({ userId, status: "completed" })
        .select("examId attemptNumber completedAt createdAt examData userId")
        .lean(),
      NotebookEntry.find({ userId }).lean(),
    ]);
    const latest = getLatestAttemptsOnly(submissions);

    const items = new Map(); // questionId -> item
    for (const sub of latest) {
      for (const d of sub.examData || []) {
        const key = String(d.questionId);
        const isMistake = d.isRight === "Incorrect" || d.isRight === "Partially Correct";
        if (!isMistake) continue;
        items.set(key, {
          questionId: key,
          examId: String(sub.examId),
          isMistake: true,
          result: d.isRight,
          yourAnswer: d.studentAnswer ?? null,
          yourAnswerIndexes: d.studentAnswerIndexes || null,
          completedAt: sub.completedAt || sub.createdAt,
        });
      }
    }
    const entryByQ = new Map(entries.map((e) => [String(e.questionId), e]));
    for (const e of entries) {
      if (!e.bookmarked) continue;
      const key = String(e.questionId);
      if (!items.has(key)) {
        // Bookmarked but not a mistake: show their latest answer if any.
        let found = null;
        for (const sub of latest) {
          const d = (sub.examData || []).find((x) => String(x.questionId) === key);
          if (d) found = { sub, d };
        }
        items.set(key, {
          questionId: key,
          examId: found ? String(found.sub.examId) : e.examId ? String(e.examId) : null,
          isMistake: false,
          result: found?.d?.isRight || null,
          yourAnswer: found?.d?.studentAnswer ?? null,
          yourAnswerIndexes: found?.d?.studentAnswerIndexes || null,
          completedAt: found ? found.sub.completedAt || found.sub.createdAt : e.createdAt,
        });
      }
    }

    const questionIds = [...items.keys()].map(toId).filter(Boolean);
    const examIds = [...new Set([...items.values()].map((i) => i.examId).filter(Boolean))].map(toId).filter(Boolean);
    const [questions, exams] = await Promise.all([
      Question.find({ _id: { $in: questionIds } })
        .select("questionType questionText image options correctAnswers correctOptionIndexes isNumericAnswer natAnswerMode rangeMin rangeMax answerKeyText answerKeyImage answerKeyImages")
        .lean(),
      Exam.find({ _id: { $in: examIds } })
        .select("examCode order subject subTopic")
        .populate({ path: "subject", select: "name subtopics" })
        .lean(),
    ]);
    const qById = new Map(questions.map((q) => [String(q._id), q]));
    const examById = new Map(exams.map((x) => [String(x._id), x]));

    const data = [];
    for (const item of items.values()) {
      const q = qById.get(item.questionId);
      if (!q) continue;
      const exam = item.examId ? examById.get(item.examId) : null;
      const subTopic = exam?.subject?.subtopics?.find((s) => String(s._id) === String(exam.subTopic));
      const entry = entryByQ.get(item.questionId);
      data.push({
        ...item,
        examCode: exam?.examCode || null,
        subjectName: exam?.subject?.name || "Other",
        subTopicName: subTopic?.name || "General",
        bookmarked: !!entry?.bookmarked,
        mastered: !!entry?.mastered,
        practiceCount: entry?.practiceCount || 0,
        lastPracticeCorrect: entry?.lastPracticeCorrect ?? null,
        question: q,
      });
    }
    data.sort((a, b) =>
      a.subjectName.localeCompare(b.subjectName) ||
      a.subTopicName.localeCompare(b.subTopicName) ||
      new Date(b.completedAt || 0) - new Date(a.completedAt || 0)
    );

    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("Notebook load failed:", error.message);
    res.status(500).json({ success: false, message: "Failed to load your notebook.", error: error.message });
  }
};

// POST /api/notebook/bookmark { questionId, examId, bookmarked }
const setBookmark = async (req, res) => {
  try {
    const { questionId, examId, bookmarked } = req.body || {};
    if (!toId(questionId)) return res.status(400).json({ success: false, message: "questionId is required." });
    if (!(await studentHasCompletedQuestion(req.user._id, questionId))) {
      return res.status(403).json({ success: false, message: "You can bookmark questions from tests you have completed." });
    }
    const entry = await NotebookEntry.findOneAndUpdate(
      { userId: req.user._id, questionId },
      { $set: { bookmarked: !!bookmarked, ...(toId(examId) ? { examId } : {}) } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.status(200).json({ success: true, data: { questionId, bookmarked: entry.bookmarked } });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to update bookmark.", error: error.message });
  }
};

// POST /api/notebook/practice { questionId, studentAnswer, studentAnswerIndexes }
// Re-attempt: graded with the same getAnswerStatus as real tests.
const practiceQuestion = async (req, res) => {
  try {
    const { questionId, studentAnswer, studentAnswerIndexes } = req.body || {};
    if (!toId(questionId)) return res.status(400).json({ success: false, message: "questionId is required." });
    if (!(await studentHasCompletedQuestion(req.user._id, questionId))) {
      return res.status(403).json({ success: false, message: "Not available." });
    }
    const q = await Question.findById(questionId).lean();
    if (!q) return res.status(404).json({ success: false, message: "Question not found." });
    // Same override as real grading: a test set to "all numeric keypad"
    // grades its Fill-in-the-Blanks questions as numeric (NAT).
    if (q.questionType === "Fill in the Blanks" && !q.isNumericAnswer) {
      const numericExam = await Exam.exists({ questions: q._id, allNumericAnswerKeypad: true });
      if (numericExam) q.isNumericAnswer = true;
    }

    const status = getAnswerStatus({
      questionType: q.questionType,
      correctAnswers: q.correctAnswers,
      studentAnswer,
      isNumericAnswer: q.isNumericAnswer,
      natAnswerMode: q.natAnswerMode,
      rangeMin: q.rangeMin,
      rangeMax: q.rangeMax,
      correctOptionIndexes: q.correctOptionIndexes,
      studentAnswerIndexes: Array.isArray(studentAnswerIndexes) ? studentAnswerIndexes : undefined,
    });
    const correct = status === "Correct";
    await NotebookEntry.findOneAndUpdate(
      { userId: req.user._id, questionId },
      {
        $inc: { practiceCount: 1 },
        $set: { lastPracticeCorrect: correct, lastPracticedAt: new Date() },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
    res.status(200).json({ success: true, data: { status, correct } });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to check your answer.", error: error.message });
  }
};

// POST /api/notebook/mastered { questionId, mastered }
const setMastered = async (req, res) => {
  try {
    const { questionId, mastered } = req.body || {};
    if (!toId(questionId)) return res.status(400).json({ success: false, message: "questionId is required." });
    if (!(await studentHasCompletedQuestion(req.user._id, questionId))) {
      return res.status(403).json({ success: false, message: "Not available." });
    }
    await NotebookEntry.findOneAndUpdate(
      { userId: req.user._id, questionId },
      { $set: { mastered: !!mastered } },
      { upsert: true, setDefaultsOnInsert: true }
    );
    res.status(200).json({ success: true, data: { questionId, mastered: !!mastered } });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to update.", error: error.message });
  }
};

module.exports = { getNotebook, setBookmark, practiceQuestion, setMastered };
