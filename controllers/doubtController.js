const mongoose = require("mongoose");
const Doubt = require("../models/doubtModel");
const ExamSubmission = require("../models/examSubmissionSchema");
const userModel = require("../models/userModel");
const { getDoubtEligibility } = require("../utils/doubtEligibility");
const { createNotification } = require("./notificationController");

// "Ask a doubt" (2026-10-08). Students who qualify (utils/doubtEligibility)
// ask about one question of a test they completed; the admin answers from
// the Doubts inbox and the student gets a personal notification.

const MAX_OPEN_PER_STUDENT = parseInt(process.env.DOUBT_MAX_OPEN, 10) || 10;

const loadUser = (id) =>
  userModel.findById(id).select("role category accountType doubtAccess username email").lean();

// GET /api/doubts/eligibility (student)
const myEligibility = async (req, res) => {
  try {
    const result = await getDoubtEligibility(await loadUser(req.user._id));
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to check eligibility.", error: error.message });
  }
};

// POST /api/doubts { examSubmissionId, questionId, message } (student)
const askDoubt = async (req, res) => {
  try {
    const { examSubmissionId, questionId, message } = req.body || {};
    const text = String(message || "").trim();
    if (!mongoose.Types.ObjectId.isValid(examSubmissionId) || !mongoose.Types.ObjectId.isValid(questionId)) {
      return res.status(400).json({ success: false, message: "Invalid question." });
    }
    if (text.length < 5) {
      return res.status(400).json({ success: false, message: "Please describe your doubt (at least a few words)." });
    }
    if (text.length > 2000) {
      return res.status(400).json({ success: false, message: "Please keep your doubt under 2000 characters." });
    }

    const user = await loadUser(req.user._id);
    const eligibility = await getDoubtEligibility(user);
    if (!eligibility.eligible) {
      return res.status(403).json({ success: false, message: eligibility.reason });
    }

    const submission = await ExamSubmission.findOne({
      _id: examSubmissionId,
      userId: req.user._id,
      status: "completed",
      "examData.questionId": questionId,
    }).select("examId");
    if (!submission) {
      return res.status(403).json({ success: false, message: "You can ask doubts only on tests you have completed." });
    }

    const openCount = await Doubt.countDocuments({ userId: req.user._id, status: "open" });
    if (openCount >= MAX_OPEN_PER_STUDENT) {
      return res.status(429).json({
        success: false,
        message: `You already have ${openCount} unanswered doubts. Please wait for replies before asking more.`,
      });
    }

    const doubt = await Doubt.create({
      userId: req.user._id,
      questionId,
      examId: submission.examId,
      examSubmissionId,
      category: user.category || null,
      message: text,
    });
    res.status(201).json({ success: true, data: doubt });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to send your doubt.", error: error.message });
  }
};

// GET /api/doubts/mine (student)
const myDoubts = async (req, res) => {
  try {
    const doubts = await Doubt.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(200)
      .populate("questionId", "questionText image questionType")
      .populate({ path: "examId", select: "examCode" })
      .lean();
    res.status(200).json({ success: true, data: doubts });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to load your doubts.", error: error.message });
  }
};

// GET /api/doubts?status=open|answered|closed|all&category= (admin)
const listDoubts = async (req, res) => {
  try {
    const { status = "open", category } = req.query;
    const filter = {};
    if (status !== "all") filter.status = status;
    if (category) filter.category = category;
    const [doubts, counts] = await Promise.all([
      Doubt.find(filter)
        .sort({ status: 1, createdAt: status === "open" ? 1 : -1 })
        .limit(300)
        .populate("userId", "username email category")
        .populate("questionId", "questionText image options questionType correctAnswers answerKeyText answerKeyImage")
        .populate({ path: "examId", select: "examCode" })
        .populate("repliedBy", "username")
        .lean(),
      Doubt.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    // The student's own answer to that question, for context.
    const subIds = [...new Set(doubts.map((d) => String(d.examSubmissionId)))];
    const subs = await ExamSubmission.find({ _id: { $in: subIds } })
      .select("examData.questionId examData.studentAnswer examData.isRight")
      .lean();
    const answerOf = new Map();
    for (const s of subs) {
      for (const d of s.examData || []) {
        answerOf.set(`${s._id}|${d.questionId}`, { studentAnswer: d.studentAnswer, isRight: d.isRight });
      }
    }
    const data = doubts.map((d) => ({
      ...d,
      studentAttempt: answerOf.get(`${d.examSubmissionId}|${d.questionId?._id || d.questionId}`) || null,
    }));
    res.status(200).json({
      success: true,
      data,
      counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to load doubts.", error: error.message });
  }
};

// PATCH /api/doubts/:id/reply { reply } (admin)
const replyToDoubt = async (req, res) => {
  try {
    const reply = String(req.body?.reply || "").trim();
    if (!reply) return res.status(400).json({ success: false, message: "Reply cannot be empty." });
    const doubt = await Doubt.findByIdAndUpdate(
      req.params.id,
      { $set: { reply, status: "answered", repliedBy: req.user._id, repliedAt: new Date() } },
      { new: true }
    );
    if (!doubt) return res.status(404).json({ success: false, message: "Doubt not found." });

    createNotification({
      userId: doubt.userId,
      type: "doubt",
      title: "Your doubt has been answered",
      message: reply.length > 140 ? `${reply.slice(0, 140)}…` : reply,
      refId: doubt.examSubmissionId,
      refModel: "ExamSubmission",
      createdBy: req.user._id,
    }).catch((err) => console.error("Doubt reply notification failed:", err.message));

    res.status(200).json({ success: true, data: doubt });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to save reply.", error: error.message });
  }
};

// PATCH /api/doubts/:id/status { status } (admin) — close / reopen
const setDoubtStatus = async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!["open", "answered", "closed"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status." });
    }
    const doubt = await Doubt.findByIdAndUpdate(req.params.id, { $set: { status } }, { new: true });
    if (!doubt) return res.status(404).json({ success: false, message: "Doubt not found." });
    res.status(200).json({ success: true, data: doubt });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to update.", error: error.message });
  }
};

// GET /api/doubts/access/:userId (admin) — current override + live eligibility
const getDoubtAccess = async (req, res) => {
  try {
    const user = await loadUser(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    res.status(200).json({ success: true, data: await getDoubtEligibility(user) });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to check.", error: error.message });
  }
};

// PATCH /api/doubts/access/:userId { doubtAccess: auto|allow|block } (admin)
const setDoubtAccess = async (req, res) => {
  try {
    const { doubtAccess } = req.body || {};
    if (!["auto", "allow", "block"].includes(doubtAccess)) {
      return res.status(400).json({ success: false, message: "doubtAccess must be auto, allow or block." });
    }
    const user = await userModel.findByIdAndUpdate(
      req.params.userId,
      { $set: { doubtAccess } },
      { new: true }
    ).select("role category accountType doubtAccess");
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    res.status(200).json({ success: true, data: await getDoubtEligibility(user.toObject()) });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to update.", error: error.message });
  }
};

module.exports = {
  myEligibility,
  askDoubt,
  myDoubts,
  listDoubts,
  replyToDoubt,
  setDoubtStatus,
  getDoubtAccess,
  setDoubtAccess,
};
