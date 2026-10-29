const mongoose = require("mongoose");
const liveClassModel = require("../models/liveClassModel");
const userModel = require("../models/userModel");
const { LiveQuestion, LivePoll, LivePollAnswer } = require("../models/liveQaModels");

// Live quiz + live leaderboard during live classes (2026-10-28).
//
// POINTS
//   Correct answer      = the question's points (default 10)
//                         + speed bonus up to 5 (answer faster → more)
//   Wrong answer        = 1  (for trying)
//   Asked a question    = 2 each, max 3 questions per class (hidden ones don't count)
//   "Same doubt" votes  = 1 per vote on your questions, max 5 per class
//
// Leaderboards: this class (live, beside the video) and today (all of the
// day's live classes in the same course).

const SCORE = { speedBonusMax: 5, wrongAnswer: 1, perQuestion: 2, maxQuestions: 3, maxVotePoints: 5 };
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

const ok = (res, data) => res.status(200).json({ success: true, data });
const fail = (res, status, message) => res.status(status).json({ success: false, message });

const isOpen = (poll, now = Date.now()) => !poll.closedAt && new Date(poll.closesAt).getTime() > now;

// What a student may see of a poll (no answer until it closes).
const shapePoll = (poll, myAnswer, { isAdmin = false } = {}) => {
  const open = isOpen(poll);
  const reveal = isAdmin || !open;
  return {
    _id: poll._id,
    kind: poll.kind,
    text: poll.text,
    options: poll.options,
    points: poll.points,
    timeLimitSec: poll.timeLimitSec,
    startedAt: poll.startedAt,
    closesAt: poll.closedAt || poll.closesAt,
    open,
    ...(reveal ? { correctIndex: poll.correctIndex, correctValue: poll.correctValue, tolerance: poll.tolerance } : {}),
    myAnswer: myAnswer
      ? {
          choice: myAnswer.choice,
          value: myAnswer.value,
          ...(reveal ? { correct: myAnswer.correct, points: myAnswer.points } : {}),
        }
      : null,
  };
};

// Scores for one or more live classes → sorted rows.
const computeLeaderboard = async (liveClassIds) => {
  const ids = liveClassIds.map((id) => new mongoose.Types.ObjectId(String(id)));
  const [answers, questions] = await Promise.all([
    LivePollAnswer.find({ liveClassId: { $in: ids } }).select("userId name liveClassId points correct").lean(),
    LiveQuestion.find({ liveClassId: { $in: ids }, status: { $ne: "hidden" } }).select("userId name liveClassId upvotes").lean(),
  ]);
  const rows = new Map();
  const row = (uid, name) => {
    const k = String(uid);
    if (!rows.has(k)) rows.set(k, { userId: k, name: name || "", points: 0, answered: 0, correct: 0, asked: 0, votes: 0 });
    const r = rows.get(k);
    if (!r.name && name) r.name = name;
    return r;
  };
  for (const a of answers) {
    const r = row(a.userId, a.name);
    r.points += a.points || 0;
    r.answered += 1;
    if (a.correct) r.correct += 1;
  }
  // Question points are capped per class.
  const perClass = new Map();
  for (const q of questions) {
    const k = `${q.userId}|${q.liveClassId}`;
    if (!perClass.has(k)) perClass.set(k, { userId: q.userId, name: q.name, asked: 0, votes: 0 });
    const c = perClass.get(k);
    c.asked += 1;
    c.votes += (q.upvotes || []).length;
  }
  for (const c of perClass.values()) {
    const r = row(c.userId, c.name);
    r.asked += c.asked;
    r.votes += c.votes;
    r.points += Math.min(c.asked, SCORE.maxQuestions) * SCORE.perQuestion + Math.min(c.votes, SCORE.maxVotePoints);
  }
  const missing = [...rows.values()].filter((r) => !r.name).map((r) => r.userId);
  if (missing.length) {
    const users = await userModel.find({ _id: { $in: missing } }).select("username").lean();
    const names = new Map(users.map((u) => [String(u._id), u.username]));
    for (const r of rows.values()) if (!r.name) r.name = names.get(r.userId) || "Student";
  }
  const list = [...rows.values()].sort((a, b) => b.points - a.points || b.correct - a.correct || a.name.localeCompare(b.name));
  let rank = 0;
  let prev = null;
  list.forEach((r, i) => {
    if (r.points !== prev) rank = i + 1;
    prev = r.points;
    r.rank = rank;
  });
  return list;
};

// IST calendar day of the class → every live class of that day in that course.
const sameDayClassIds = async (liveClass) => {
  const start = new Date(liveClass.startedAt || Date.now());
  const ymd = new Date(start.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${ymd}T00:00:00Z`) - IST_OFFSET_MS);
  const to = new Date(from.getTime() + 24 * 3600 * 1000);
  const list = await liveClassModel.find({ category: liveClass.category, startedAt: { $gte: from, $lt: to } }).select("_id").lean();
  return { ymd, ids: list.map((c) => c._id) };
};

// Called by liveQaController.getBoard — quiz + leaderboard part of the board.
const quizStateFor = async (liveClass, user) => {
  const isAdmin = user.role === "admin";
  const polls = await LivePoll.find({ liveClassId: liveClass._id }).sort({ startedAt: -1 }).limit(isAdmin ? 50 : 5).lean();
  const now = Date.now();
  const current = polls.find((p) => isOpen(p, now)) || null;
  const lastClosed = polls.find((p) => !isOpen(p, now)) || null;

  const myAnswers = isAdmin
    ? []
    : await LivePollAnswer.find({ pollId: { $in: polls.map((p) => p._id) }, userId: user._id }).lean();
  const mine = new Map(myAnswers.map((a) => [String(a.pollId), a]));

  const board = await computeLeaderboard([liveClass._id]);
  const meRow = board.find((r) => r.userId === String(user._id)) || null;

  const out = {
    scoring: SCORE,
    currentPoll: current ? shapePoll(current, mine.get(String(current._id)), { isAdmin }) : null,
    lastPoll: lastClosed ? shapePoll(lastClosed, mine.get(String(lastClosed._id)), { isAdmin }) : null,
    leaderboard: {
      top: board.slice(0, 5).map(({ userId, ...r }) => ({ ...r, me: userId === String(user._id) })),
      me: meRow ? { rank: meRow.rank, points: meRow.points, of: board.length, aheadBy: (() => {
        const above = board.filter((r) => r.points > meRow.points).pop();
        return above ? above.points - meRow.points : 0;
      })() } : null,
    },
  };

  if (isAdmin) {
    const pollIds = polls.map((p) => p._id);
    const stats = await LivePollAnswer.aggregate([
      { $match: { pollId: { $in: pollIds } } },
      { $group: { _id: { p: "$pollId", c: "$choice" }, n: { $sum: 1 }, right: { $sum: { $cond: ["$correct", 1, 0] } } } },
    ]);
    const byPoll = new Map();
    for (const s of stats) {
      const k = String(s._id.p);
      if (!byPoll.has(k)) byPoll.set(k, { answered: 0, correct: 0, choices: {} });
      const b = byPoll.get(k);
      b.answered += s.n;
      b.correct += s.right;
      if (s._id.c !== null && s._id.c !== undefined) b.choices[s._id.c] = s.n;
    }
    out.polls = polls.map((p) => ({ ...shapePoll(p, null, { isAdmin: true }), stats: byPoll.get(String(p._id)) || { answered: 0, correct: 0, choices: {} } }));
    out.fullLeaderboard = board;
  }
  return out;
};

// POST /api/live-qa/:liveClassId/polls (admin)
// { kind: "mcq"|"numeric", text, options[], correctIndex, correctValue, tolerance, points, timeLimitSec }
const createPoll = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.liveClassId)) return fail(res, 404, "Live class not found.");
    const liveClass = await liveClassModel.findById(req.params.liveClassId).select("_id").lean();
    if (!liveClass) return fail(res, 404, "Live class not found.");
    const b = req.body || {};
    const kind = b.kind === "numeric" ? "numeric" : "mcq";
    const timeLimitSec = Math.min(1800, Math.max(10, Math.round(Number(b.timeLimitSec) || 60)));
    const points = Math.min(100, Math.max(1, Math.round(Number(b.points) || 10)));
    const doc = { liveClassId: liveClass._id, kind, text: String(b.text || "").slice(0, 1000), points, timeLimitSec };
    if (kind === "mcq") {
      const n = Math.min(6, Math.max(2, Number(b.optionCount) || (Array.isArray(b.options) ? b.options.length : 4) || 4));
      doc.options = Array.from({ length: n }, (_, i) => String((b.options || [])[i] || "").slice(0, 200));
      const ci = Number(b.correctIndex);
      if (!Number.isInteger(ci) || ci < 0 || ci >= n) return fail(res, 400, "Choose the correct option.");
      doc.correctIndex = ci;
    } else {
      const v = Number(b.correctValue);
      if (!Number.isFinite(v)) return fail(res, 400, "Enter the correct numeric answer.");
      doc.correctValue = v;
      doc.tolerance = Math.max(0, Number(b.tolerance) || 0);
    }
    // Only one question open at a time — close any open one.
    await LivePoll.updateMany({ liveClassId: liveClass._id, closedAt: null, closesAt: { $gt: new Date() } }, { $set: { closedAt: new Date() } });
    const now = new Date();
    const poll = await LivePoll.create({ ...doc, startedAt: now, closesAt: new Date(now.getTime() + timeLimitSec * 1000) });
    return ok(res, shapePoll(poll.toObject(), null, { isAdmin: true }));
  } catch (err) {
    console.error("liveQuiz.createPoll", err);
    return fail(res, 500, "Could not start the question.");
  }
};

// POST /api/live-qa/polls/:pollId/close (admin)
const closePoll = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.pollId)) return fail(res, 404, "Question not found.");
    await LivePoll.updateOne({ _id: req.params.pollId, closedAt: null }, { $set: { closedAt: new Date() } });
    return ok(res, { closed: true });
  } catch (err) {
    console.error("liveQuiz.closePoll", err);
    return fail(res, 500, "Could not close.");
  }
};

// POST /api/live-qa/polls/:pollId/answer (student) { choice } | { value }
// `checkAccess` is liveQaController's student access check (passed in to avoid a require loop).
const makeAnswerHandler = (checkAccess) => async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.pollId)) return fail(res, 404, "Question not found.");
    const poll = await LivePoll.findById(req.params.pollId).lean();
    if (!poll) return fail(res, 404, "Question not found.");
    const { error } = await checkAccess(req.user, poll.liveClassId);
    if (error) return fail(res, error[0], error[1]);
    if (!isOpen(poll)) return fail(res, 409, "Time is up for this question.");

    let correct = false;
    const doc = { pollId: poll._id, liveClassId: poll.liveClassId, userId: req.user._id, name: req.user.username || "Student" };
    if (poll.kind === "mcq") {
      const c = Number(req.body?.choice);
      if (!Number.isInteger(c) || c < 0 || c >= poll.options.length) return fail(res, 400, "Pick an option.");
      doc.choice = c;
      correct = c === poll.correctIndex;
    } else {
      const v = Number(String(req.body?.value ?? "").replace(/,/g, ""));
      if (!Number.isFinite(v)) return fail(res, 400, "Type a number.");
      doc.value = v;
      correct = Math.abs(v - poll.correctValue) <= (poll.tolerance || 0) + 1e-9;
    }
    const limitMs = poll.timeLimitSec * 1000;
    const ms = Math.max(0, Date.now() - new Date(poll.startedAt).getTime());
    doc.ms = ms;
    doc.correct = correct;
    doc.points = correct ? poll.points + Math.max(0, Math.round(SCORE.speedBonusMax * (1 - ms / limitMs))) : SCORE.wrongAnswer;
    try {
      await LivePollAnswer.create(doc);
    } catch (e) {
      if (e && e.code === 11000) return fail(res, 409, "You have already answered this question.");
      throw e;
    }
    return ok(res, { saved: true });
  } catch (err) {
    console.error("liveQuiz.answer", err);
    return fail(res, 500, "Could not save your answer.");
  }
};

// GET /api/live-qa/:liveClassId/leaderboard?scope=class|day (admin) — full table
const getLeaderboard = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.liveClassId)) return fail(res, 404, "Live class not found.");
    const liveClass = await liveClassModel.findById(req.params.liveClassId).select("title category startedAt").lean();
    if (!liveClass) return fail(res, 404, "Live class not found.");
    if (req.query.scope === "day") {
      const { ymd, ids } = await sameDayClassIds(liveClass);
      return ok(res, { scope: "day", day: ymd, classes: ids.length, rows: await computeLeaderboard(ids) });
    }
    return ok(res, { scope: "class", title: liveClass.title, rows: await computeLeaderboard([liveClass._id]) });
  } catch (err) {
    console.error("liveQuiz.getLeaderboard", err);
    return fail(res, 500, "Could not load the leaderboard.");
  }
};

module.exports = { SCORE, quizStateFor, createPoll, closePoll, makeAnswerHandler, getLeaderboard, computeLeaderboard };
