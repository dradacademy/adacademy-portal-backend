const mongoose = require("mongoose");
const liveClassModel = require("../models/liveClassModel");
const enrollmentModel = require("../models/enrollmentModel");
const { isEnrollmentActive } = require("../models/enrollmentModel");
const { LiveQuestion, LiveConfusion } = require("../models/liveQaModels");
const liveQuiz = require("./liveQuizController");

// Live Q&A during live classes (2026-10-28). The app asks for updates every
// few seconds while the live player (student) or the Live Q&A screen (admin)
// is open — no extra paid service needed.

const CONFUSION_WINDOW_MS = 2 * 60 * 1000; // "confused in the last 2 minutes"
const CONFUSION_COOLDOWN_MS = 60 * 1000; // one tap per student per minute
const ASK_COOLDOWN_MS = 10 * 1000; // one question per student per 10 seconds

const ok = (res, data) => res.status(200).json({ success: true, data });
const fail = (res, status, message) => res.status(status).json({ success: false, message });

// Same access rules as joining the live class (liveClassController.joinLiveClass).
const checkStudentAccess = async (user, liveClassId, { mustBeLive = true } = {}) => {
  if (!mongoose.isValidObjectId(liveClassId)) return { error: [404, "Live class not found."] };
  const liveClass = await liveClassModel.findById(liveClassId).select("category active endedAt title startedAt").lean();
  if (!liveClass) return { error: [404, "Live class not found."] };
  if (user.role === "admin") return { liveClass };
  if (!user.category || liveClass.category !== user.category) return { error: [403, "This live class is not for your course."] };
  if (mustBeLive && (!liveClass.active || liveClass.endedAt)) return { error: [409, "This live class has ended."] };
  const enrollment = await enrollmentModel.findOne({ userId: user._id, category: liveClass.category }).lean();
  if (!isEnrollmentActive(enrollment) || enrollment.accessLevel === "test_series_only") {
    return { error: [403, "Your plan doesn't include live classes."] };
  }
  return { liveClass };
};

const shape = (q, me, isAdmin) => ({
  _id: q._id,
  name: q.name,
  text: q.text,
  status: q.status,
  pinned: q.pinned,
  votes: (q.upvotes || []).length,
  votedByMe: (q.upvotes || []).some((u) => String(u) === String(me)),
  mine: String(q.userId) === String(me),
  reply: q.reply || "",
  repliedAt: q.repliedAt,
  createdAt: q.createdAt,
  ...(isAdmin ? { userId: q.userId } : {}),
});

const confusionSummary = async (liveClassId, me) => {
  const since = new Date(Date.now() - CONFUSION_WINDOW_MS);
  const recent = await LiveConfusion.find({ liveClassId, createdAt: { $gte: since } }).select("userId createdAt").lean();
  const students = new Set(recent.map((r) => String(r.userId)));
  const mine = recent.filter((r) => String(r.userId) === String(me)).sort((a, b) => b.createdAt - a.createdAt)[0];
  return {
    confusedNow: students.size,
    myLastConfusedAt: mine ? mine.createdAt : null,
  };
};

// GET /api/live-qa/:liveClassId — questions + "confused" count.
// Students see everything except hidden questions (they always see their own).
const getBoard = async (req, res) => {
  try {
    const isAdmin = req.user.role === "admin";
    const { liveClass, error } = await checkStudentAccess(req.user, req.params.liveClassId, { mustBeLive: false });
    if (error) return fail(res, error[0], error[1]);
    const filter = { liveClassId: liveClass._id };
    if (!isAdmin) filter.$or = [{ status: { $ne: "hidden" } }, { userId: req.user._id }];
    const questions = await LiveQuestion.find(filter).sort({ createdAt: 1 }).limit(500).lean();
    const conf = await confusionSummary(liveClass._id, req.user._id);
    const totalConfused = isAdmin ? await LiveConfusion.countDocuments({ liveClassId: liveClass._id }) : undefined;
    const quiz = await liveQuiz.quizStateFor(liveClass, req.user);
    return ok(res, {
      liveClass: { _id: liveClass._id, title: liveClass.title, live: liveClass.active && !liveClass.endedAt },
      questions: questions.map((q) => shape(q, req.user._id, isAdmin)),
      ...conf,
      ...(isAdmin ? { totalConfusedTaps: totalConfused } : {}),
      quiz,
      serverTime: new Date(),
    });
  } catch (err) {
    console.error("liveQa.getBoard", err);
    return fail(res, 500, "Could not load questions.");
  }
};

// POST /api/live-qa/:liveClassId/questions  { text }
const ask = async (req, res) => {
  try {
    const { liveClass, error } = await checkStudentAccess(req.user, req.params.liveClassId);
    if (error) return fail(res, error[0], error[1]);
    const text = String(req.body?.text || "").trim().slice(0, 500);
    if (text.length < 2) return fail(res, 400, "Type your question first.");
    const last = await LiveQuestion.findOne({ liveClassId: liveClass._id, userId: req.user._id }).sort({ createdAt: -1 }).select("createdAt").lean();
    if (last && Date.now() - new Date(last.createdAt).getTime() < ASK_COOLDOWN_MS) {
      return fail(res, 429, "Please wait a few seconds before asking again.");
    }
    const q = await LiveQuestion.create({
      liveClassId: liveClass._id,
      userId: req.user._id,
      name: req.user.username || "Student",
      text,
    });
    return ok(res, shape(q.toObject(), req.user._id, false));
  } catch (err) {
    console.error("liveQa.ask", err);
    return fail(res, 500, "Could not send your question.");
  }
};

// POST /api/live-qa/questions/:questionId/upvote — toggles "I have the same doubt".
const upvote = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.questionId)) return fail(res, 404, "Question not found.");
    const q = await LiveQuestion.findById(req.params.questionId).select("liveClassId upvotes status").lean();
    if (!q || q.status === "hidden") return fail(res, 404, "Question not found.");
    const { error } = await checkStudentAccess(req.user, q.liveClassId, { mustBeLive: false });
    if (error) return fail(res, error[0], error[1]);
    const voted = (q.upvotes || []).some((u) => String(u) === String(req.user._id));
    await LiveQuestion.updateOne({ _id: q._id }, voted ? { $pull: { upvotes: req.user._id } } : { $addToSet: { upvotes: req.user._id } });
    return ok(res, { votedByMe: !voted });
  } catch (err) {
    console.error("liveQa.upvote", err);
    return fail(res, 500, "Could not save.");
  }
};

// POST /api/live-qa/:liveClassId/confused — "I didn't understand".
const confused = async (req, res) => {
  try {
    const { liveClass, error } = await checkStudentAccess(req.user, req.params.liveClassId);
    if (error) return fail(res, error[0], error[1]);
    const recent = await LiveConfusion.findOne({
      liveClassId: liveClass._id,
      userId: req.user._id,
      createdAt: { $gte: new Date(Date.now() - CONFUSION_COOLDOWN_MS) },
    }).lean();
    if (!recent) await LiveConfusion.create({ liveClassId: liveClass._id, userId: req.user._id });
    return ok(res, await confusionSummary(liveClass._id, req.user._id));
  } catch (err) {
    console.error("liveQa.confused", err);
    return fail(res, 500, "Could not save.");
  }
};

// PATCH /api/live-qa/questions/:questionId  (admin) { status?, pinned?, reply? }
const moderate = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.questionId)) return fail(res, 404, "Question not found.");
    const set = {};
    if (["open", "answered", "hidden"].includes(req.body?.status)) set.status = req.body.status;
    if (typeof req.body?.pinned === "boolean") set.pinned = req.body.pinned;
    if (typeof req.body?.reply === "string") {
      set.reply = req.body.reply.trim().slice(0, 2000);
      set.repliedAt = set.reply ? new Date() : null;
      if (set.reply && !set.status) set.status = "answered";
    }
    const q = await LiveQuestion.findByIdAndUpdate(req.params.questionId, { $set: set }, { new: true }).lean();
    if (!q) return fail(res, 404, "Question not found.");
    return ok(res, shape(q, req.user._id, true));
  } catch (err) {
    console.error("liveQa.moderate", err);
    return fail(res, 500, "Could not save.");
  }
};

// GET /api/live-qa/admin/classes — recent live classes with question counts.
const listClasses = async (req, res) => {
  try {
    const since = new Date(Date.now() - 45 * 24 * 3600 * 1000);
    const classes = await liveClassModel
      .find({ startedAt: { $gte: since } })
      .select("title category active endedAt startedAt")
      .sort({ startedAt: -1 })
      .limit(100)
      .lean();
    const ids = classes.map((c) => c._id);
    const counts = await LiveQuestion.aggregate([
      { $match: { liveClassId: { $in: ids } } },
      { $group: { _id: { c: "$liveClassId", s: "$status" }, n: { $sum: 1 } } },
    ]);
    const by = new Map();
    for (const c of counts) {
      const k = String(c._id.c);
      if (!by.has(k)) by.set(k, { open: 0, answered: 0, hidden: 0 });
      by.get(k)[c._id.s] = c.n;
    }
    return ok(
      res,
      classes.map((c) => ({ ...c, live: c.active && !c.endedAt, counts: by.get(String(c._id)) || { open: 0, answered: 0, hidden: 0 } }))
    );
  } catch (err) {
    console.error("liveQa.listClasses", err);
    return fail(res, 500, "Could not load classes.");
  }
};

module.exports = {
  getBoard,
  ask,
  upvote,
  confused,
  moderate,
  listClasses,
  // Live quiz + leaderboard (controllers/liveQuizController.js)
  createPoll: liveQuiz.createPoll,
  closePoll: liveQuiz.closePoll,
  answerPoll: liveQuiz.makeAnswerHandler(checkStudentAccess),
  getLeaderboard: liveQuiz.getLeaderboard,
  getAttendanceChecks: liveQuiz.getAttendanceChecks,
};
