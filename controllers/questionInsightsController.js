const ExamSubmission = require("../models/examSubmissionSchema");
const NotebookEntry = require("../models/notebookEntryModel");
const Doubt = require("../models/doubtModel");
const userModel = require("../models/userModel");
const { getLatestAttemptsOnly } = require("../utils/latestAttemptHelper");
const { getDoubtEligibility } = require("../utils/doubtEligibility");

// Question-level analysis (2026-10-08), MADE EASY-style, for one completed
// submission's review page:
//   - rank of this attempt among everyone who took the test, and the
//     topper's score/time (topper name is never revealed);
//   - for every question: your time, topper's time, average time, and
//     "% of students who got it right" with an Easy/Medium/Hard label.
// Everyone's LATEST completed attempt is used, same "last attempt only"
// rule as the rest of the app. Times exist only for attempts made after
// per-question timing was added; older attempts simply have no time.
// For the student who owns the submission it also returns their bookmarks
// and their doubt status/threads for this test.

const MIN_STUDENTS_FOR_DIFFICULTY = 3;

const difficultyLabel = (percentCorrect, totalStudents) => {
  if (totalStudents < MIN_STUDENTS_FOR_DIFFICULTY) return null;
  if (percentCorrect >= 60) return "Easy";
  if (percentCorrect >= 30) return "Medium";
  return "Hard";
};

const better = (a, b) =>
  (b.obtainedMark || 0) - (a.obtainedMark || 0) || (a.timetaken || 0) - (b.timetaken || 0);

const getQuestionInsights = async (req, res) => {
  try {
    const { examSubmissionId } = req.params;
    const submission = await ExamSubmission.findById(examSubmissionId)
      .select("userId examId examData obtainedMark timetaken status attemptNumber")
      .lean();
    if (!submission) {
      return res.status(404).json({ success: false, message: "Submission not found." });
    }
    const isOwner = String(submission.userId) === String(req.user._id);
    if (req.user.role === "student" && !isOwner) {
      return res.status(403).json({ success: false, message: "Forbidden." });
    }

    const all = await ExamSubmission.find({ examId: submission.examId, status: "completed" })
      .select("userId attemptNumber obtainedMark timetaken completedAt createdAt examData.questionId examData.isRight examData.timeSpentSeconds")
      .lean();
    const latest = getLatestAttemptsOnly(all);
    const ranked = [...latest].sort(better);
    const topper = ranked[0] || null;

    // Rank of THIS submission against everyone else's latest attempt.
    const others = latest.filter((s) => String(s.userId) !== String(submission.userId));
    const rank = 1 + others.filter((s) => better(s, submission) < 0).length;
    const totalStudents = others.length + 1;

    const perQuestion = new Map();
    for (const s of latest) {
      for (const item of s.examData || []) {
        const key = String(item.questionId);
        if (!perQuestion.has(key)) perQuestion.set(key, { attempted: 0, correct: 0, partial: 0, times: [] });
        const q = perQuestion.get(key);
        if (item.isRight && item.isRight !== "Skipped") q.attempted++;
        if (item.isRight === "Correct") q.correct++;
        if (item.isRight === "Partially Correct") q.partial++;
        if (item.timeSpentSeconds > 0) q.times.push(item.timeSpentSeconds);
      }
    }
    const topperTimes = new Map(
      (topper?.examData || []).map((i) => [String(i.questionId), i.timeSpentSeconds || null])
    );

    const questions = {};
    for (const item of submission.examData || []) {
      const key = String(item.questionId);
      const q = perQuestion.get(key) || { attempted: 0, correct: 0, partial: 0, times: [] };
      const pool = latest.length || 1;
      const percentCorrect = Math.round((q.correct / pool) * 1000) / 10;
      questions[key] = {
        yourTimeSeconds: item.timeSpentSeconds || null,
        topperTimeSeconds: topperTimes.get(key) || null,
        averageTimeSeconds: q.times.length
          ? Math.round(q.times.reduce((a, b) => a + b, 0) / q.times.length)
          : null,
        percentCorrect,
        percentAttempted: Math.round((q.attempted / pool) * 1000) / 10,
        difficulty: difficultyLabel(percentCorrect, latest.length),
      };
    }

    const data = {
      rank,
      totalStudents,
      topperMark: topper ? topper.obtainedMark : null,
      topperTimeSeconds: topper ? topper.timetaken : null,
      yourMark: submission.obtainedMark,
      questions,
      isOwner,
      bookmarkedQuestionIds: [],
      doubt: null,
      isFreeTrial: false,
    };

    if (isOwner && req.user.role === "student") {
      const qids = (submission.examData || []).map((i) => i.questionId);
      const [entries, doubts, user] = await Promise.all([
        NotebookEntry.find({ userId: req.user._id, questionId: { $in: qids }, bookmarked: true })
          .select("questionId")
          .lean(),
        Doubt.find({ userId: req.user._id, examSubmissionId: submission._id })
          .sort({ createdAt: 1 })
          .select("questionId message status reply repliedAt createdAt")
          .lean(),
        userModel.findById(req.user._id).select("role category accountType doubtAccess").lean(),
      ]);
      data.bookmarkedQuestionIds = entries.map((e) => String(e.questionId));
      const eligibility = await getDoubtEligibility(user);
      data.doubt = { eligible: eligibility.eligible, reason: eligibility.reason, threads: doubts };
      data.isFreeTrial = user?.accountType === "free_trial";
    }

    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("Question insights failed:", error.message);
    res.status(500).json({ success: false, message: "Failed to load question analysis.", error: error.message });
  }
};

module.exports = { getQuestionInsights };
