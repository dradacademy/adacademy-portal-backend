const mongoose = require("mongoose");
const userModel = require("../models/userModel");
const Subject = require("../models/subjectModel");
const Question = require("../models/questionModel");
const Exam = require("../models/examModel");
const ExamSubmission = require("../models/examSubmissionSchema");
const {
  StudyTrackerConfig,
  StudyPlan,
  StudyEntry,
  StudyQuizAttempt,
  StudyStudentState,
} = require("../models/studyTrackerModels");
const {
  TRACKER_CATEGORY,
  SUBJECTS,
  SUBJECT_LABELS,
  UNITS,
  MATERIALS,
  POOL_FALLBACK,
  PROGRESS_STEPS,
  ALL_PLAN_KEYS,
  poolKey,
  isValidUnit,
  isValidMaterial,
  CIVIL_TRACKS,
  civilTrackOf,
  unitsFor,
  planKeysFor,
} = require("../constants/studyTracker");
const {
  istYmd,
  istHm,
  buildStudentProgress,
} = require("../utils/studyTracker");
const { getAnswerStatus } = require("../utils/ExamSubmissionHelper");
const { getLatestAttemptsOnly } = require("../utils/latestAttemptHelper");

// Daily Study Tracker (TNPSC JDO) — 2026-10-28.
//
// Student: every day from the reminder time (default 5:30 PM IST) a popup
// asks what they studied. They pick subject → unit → material → how much
// (¼ ½ ¾ full), then answer a short random check (default 10 questions)
// drawn from the questions linked to that unit. The report only counts when
// they score at least the pass mark (default 75%). Target dates are set by
// the admin only.
//
// Admin: whole-class summary (screenshot-ready), per-student detail, target
// date editor, question-source links, settings and the one-time import of
// the old tracker page's data.

const STUDENT_FIELDS = "username email registerNumber category batch isDisabled accountType";
const TEST_TYPES = ["GS", "Civil", "Apt & Lang"];
const ymdRe = /^\d{4}-\d{2}-\d{2}$/;

const ok = (res, data) => res.status(200).json({ success: true, data });
const fail = (res, status, message) => res.status(status).json({ success: false, message });

const getConfig = async () => {
  const cfg = await StudyTrackerConfig.findByIdAndUpdate(
    "study-tracker-config",
    {},
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return cfg;
};

// Who gets the feature: the admin's ticked list once saved; until then every
// TNPSC JDO student.
const hasChosenList = (config) => Array.isArray(config.studentIds);

const isTrackedStudent = (user, config) => {
  if (!user || user.role !== "student" || user.accountType === "free_trial" || user.isDisabled) return false;
  if (hasChosenList(config)) return config.studentIds.some((id) => String(id) === String(user._id));
  return user.category === TRACKER_CATEGORY;
};

const trackedStudents = (config) =>
  userModel
    .find({
      role: "student",
      accountType: { $ne: "free_trial" },
      isDisabled: { $ne: true },
      ...(hasChosenList(config) ? { _id: { $in: config.studentIds } } : { category: TRACKER_CATEGORY }),
    })
    .select(STUDENT_FIELDS)
    .sort({ username: 1 })
    .lean();

const planDatesOf = (plan) => {
  const out = {};
  for (const d of (plan && plan.dates) || []) if (d && d.key && d.date) out[d.key] = d.date;
  return out;
};
const toDateList = (obj) => Object.entries(obj).map(([key, date]) => ({ key, date }));

const poolsOf = (config) => {
  const out = {};
  for (const p of config.questionPools || []) {
    if (p && p.key) out[p.key] = (p.refs || []).map((r) => ({ subject: String(r.subject), subTopic: String(r.subTopic) }));
  }
  return out;
};

// ── Test averages ───────────────────────────────────────────────────────
// Latest completed attempt per exam. Every test is written as 50 marks
// (config.testTotalMarks), so % = obtained / 50.
const loadTestAverages = async (userIds, config) => {
  const typeBySubject = config.testSubjectTypes instanceof Map
    ? Object.fromEntries(config.testSubjectTypes)
    : { ...(config.testSubjectTypes || {}) };
  const subjectIds = Object.keys(typeBySubject).filter((id) => TEST_TYPES.includes(typeBySubject[id]));
  const result = new Map(userIds.map((id) => [String(id), { GS: [], Civil: [], "Apt & Lang": [] }]));
  if (!subjectIds.length || !userIds.length) return result;

  const exams = await Exam.find({ subject: { $in: subjectIds } }).select("_id subject").lean();
  if (!exams.length) return result;
  const examType = new Map(exams.map((e) => [String(e._id), typeBySubject[String(e.subject)]]));

  const subs = await ExamSubmission.find({
    userId: { $in: userIds },
    examId: { $in: exams.map((e) => e._id) },
    status: "completed",
  })
    .select("userId examId attemptNumber obtainedMark completedAt createdAt")
    .lean();
  const latest = getLatestAttemptsOnly(subs);

  const totalMarks = Number(config.testTotalMarks) || 50;
  for (const s of latest) {
    const pct = Math.max(0, Math.min(100, ((Number(s.obtainedMark) || 0) / totalMarks) * 100));
    const type = examType.get(String(s.examId));
    const bucket = result.get(String(s.userId));
    if (bucket && type) bucket[type].push({ pct, at: s.completedAt || s.createdAt });
  }
  return result;
};

const summarizeTests = (bucket) => {
  const out = {};
  for (const t of TEST_TYPES) {
    const list = (bucket && bucket[t]) || [];
    out[t] = list.length
      ? { average: Math.round(list.reduce((a, x) => a + x.pct, 0) / list.length), count: list.length }
      : { average: null, count: 0 };
  }
  return out;
};

// ── Student ────────────────────────────────────────────────────────────

const PLAN_LABEL = (key) => (key === "Language" ? "Tamil (all units)" : key === "Aptitude" ? "Aptitude (all topics)" : key);
const maxDateFor = (config, subject, track) =>
  subject === "Civil" ? (track === "draughtsman" ? config.draughtsmanExamDate || "2026-11-24" : config.civilExamDate) : config.gsExamDate;

const trackOf = (plan) => civilTrackOf(plan && plan.civilTrack);
const missingDatesOf = (planDates, config, track) =>
  planKeysFor(track).filter((p) => !planDates[p.key]).map((p) => ({
    key: p.key,
    subject: p.subject,
    label: PLAN_LABEL(p.key),
    maxDate: maxDateFor(config, p.subject, track),
  }));

// A check the student failed and hasn't passed since — they must clear it
// before reporting anything else.
const findPendingCheck = async (userId) => {
  const failed = await StudyQuizAttempt.find({ userId, submittedAt: { $ne: null }, passed: false })
    .select("subject unit material claimedPercent topics scorePercent passPercent submittedAt")
    .sort({ submittedAt: -1 })
    .limit(20)
    .lean();
  for (const f of failed) {
    const passedLater = await StudyQuizAttempt.exists({
      userId,
      subject: f.subject,
      unit: f.unit,
      material: f.material,
      passed: true,
      submittedAt: { $gt: f.submittedAt },
    });
    if (!passedLater) return f;
  }
  return null;
};

// GET /api/study-tracker/me
const getMine = async (req, res) => {
  try {
    const user = req.user;
    const config = await getConfig();
    if (!config.enabled || !isTrackedStudent(user, config)) return ok(res, { enabled: false });

    const today = istYmd();
    const [plan, entries, state, attemptsToday, tests, pendingCheck] = await Promise.all([
      StudyPlan.findOne({ userId: user._id }).lean(),
      StudyEntry.find({ userId: user._id }).select("subject unit material percent day source topics createdAt").lean(),
      StudyStudentState.findOne({ userId: user._id }).lean(),
      StudyQuizAttempt.find({ userId: user._id, day: today, submittedAt: { $ne: null } })
        .select("subject unit material claimedPercent scorePercent passed submittedAt")
        .sort({ submittedAt: -1 })
        .lean(),
      loadTestAverages([user._id], config),
      findPendingCheck(user._id),
    ]);

    const planDates = planDatesOf(plan);
    const civilTrack = trackOf(plan);
    const progress = buildStudentProgress({ entries, planDates, today, civilTrack });
    const entriesToday = entries.filter((e) => e.day === today);
    const now = istHm();

    return ok(res, {
      enabled: true,
      today,
      nowIst: now,
      reminderTime: config.reminderTime,
      reminderDue: now >= config.reminderTime && entriesToday.length === 0,
      introSeen: Boolean(state?.introSeenAt),
      missingDates: missingDatesOf(planDates, config, civilTrack),
      civilTrack,
      civilLabel: CIVIL_TRACKS[civilTrack].label,
      civilExamDate: maxDateFor(config, "Civil", civilTrack),
      pendingCheck,
      testTotalMarks: config.testTotalMarks,
      quizQuestionCount: config.quizQuestionCount,
      passPercent: config.passPercent,
      syllabus: { subjects: SUBJECTS, labels: { ...SUBJECT_LABELS, Civil: CIVIL_TRACKS[civilTrack].label }, units: unitsFor(civilTrack), materials: MATERIALS, steps: PROGRESS_STEPS },
      planDates,
      progress,
      todayLog: {
        entries: entriesToday,
        attempts: attemptsToday,
      },
      tests: summarizeTests(tests.get(String(user._id))),
    });
  } catch (err) {
    console.error("studyTracker.getMine", err);
    return fail(res, 500, "Could not load your study plan.");
  }
};

// POST /api/study-tracker/me/intro-seen
const markIntroSeen = async (req, res) => {
  try {
    await StudyStudentState.findOneAndUpdate(
      { userId: req.user._id },
      { $set: { introSeenAt: new Date() } },
      { upsert: true }
    );
    return ok(res, { introSeen: true });
  } catch (err) {
    console.error("studyTracker.markIntroSeen", err);
    return fail(res, 500, "Could not save.");
  }
};

// POST /api/study-tracker/me/plan  { dates: { key: "YYYY-MM-DD" } }
// The student may fill only dates that are still EMPTY. Dates already set
// can only be changed by the admin.
const fillMyMissingDates = async (req, res) => {
  try {
    const user = req.user;
    const config = await getConfig();
    if (!config.enabled || !isTrackedStudent(user, config)) return fail(res, 403, "The study tracker is not open for you.");
    const plan = await StudyPlan.findOne({ userId: user._id }).lean();
    const current = planDatesOf(plan);
    const track = trackOf(plan);
    const today = istYmd();
    const subjectOf = new Map(planKeysFor(track).map((p) => [p.key, p.subject]));
    let added = 0;
    for (const [k, v] of Object.entries(req.body?.dates || {})) {
      if (!subjectOf.has(k) || current[k] || !v) continue;
      if (!ymdRe.test(v)) return fail(res, 400, `Please pick a proper date for ${PLAN_LABEL(k)}.`);
      const max = maxDateFor(config, subjectOf.get(k), track);
      if (v < today || v > max) return fail(res, 400, `${PLAN_LABEL(k)}: choose a date between today and ${max}.`);
      current[k] = v;
      added += 1;
    }
    await StudyPlan.findOneAndUpdate({ userId: user._id }, { $set: { dates: toDateList(current) } }, { upsert: true });
    return ok(res, { added, missingDates: missingDatesOf(current, config, track) });
  } catch (err) {
    console.error("studyTracker.fillMyMissingDates", err);
    return fail(res, 500, "Could not save your dates.");
  }
};

const poolRefsFor = (config, subject, unit, material) => {
  const pools = poolsOf(config);
  let refs = pools[poolKey(subject, unit, material)] || [];
  if (!refs.length && POOL_FALLBACK[material]) refs = pools[poolKey(subject, unit, POOL_FALLBACK[material])] || [];
  return refs;
};

// Only tap-to-answer questions are used in the check.
const CHECK_TYPES = ["MCQ", "MSQ"];

const countPool = async (refs) => {
  if (!refs.length) return 0;
  return Question.countDocuments({
    $or: refs.map((r) => ({ subject: new mongoose.Types.ObjectId(r.subject), subTopic: new mongoose.Types.ObjectId(r.subTopic) })),
    questionType: { $in: CHECK_TYPES },
  });
};

// POST /api/study-tracker/me/check/start  { subject, unit, material, percent, topics }
const startCheck = async (req, res) => {
  try {
    const user = req.user;
    const config = await getConfig();
    if (!config.enabled || !isTrackedStudent(user, config)) return fail(res, 403, "The study tracker is not open for you.");
    const { subject, unit, material, topics = "" } = req.body || {};
    const percent = Number(req.body?.percent);
    const myPlan = await StudyPlan.findOne({ userId: user._id }).select("civilTrack").lean();
    if (!isValidUnit(subject, unit, trackOf(myPlan)) || !isValidMaterial(subject, material) || !PROGRESS_STEPS.includes(percent)) {
      return fail(res, 400, "Please choose the subject, unit, material and how much you finished.");
    }
    const pending = await findPendingCheck(user._id);
    if (pending && !(pending.subject === subject && pending.unit === unit && pending.material === material)) {
      return fail(res, 409, `First clear your pending check: ${pending.unit} · ${pending.material}.`);
    }
    const today = istYmd();
    const refs = poolRefsFor(config, subject, unit, material);
    const available = await countPool(refs);
    const minNeeded = Math.min(5, config.quizQuestionCount);

    // No questions linked yet: accept the report, marked "no check" for the admin.
    if (available < minNeeded) {
      const entry = await StudyEntry.create({
        userId: user._id,
        day: today,
        subject,
        unit,
        material,
        percent,
        topics: String(topics).slice(0, 300),
        source: "no_quiz",
      });
      return ok(res, { noQuestions: true, saved: true, entryId: entry._id });
    }

    const picked = await Question.aggregate([
      {
        $match: {
          $or: refs.map((r) => ({ subject: new mongoose.Types.ObjectId(String(r.subject)), subTopic: new mongoose.Types.ObjectId(String(r.subTopic)) })),
          questionType: { $in: CHECK_TYPES },
        },
      },
      { $sample: { size: config.quizQuestionCount } },
      { $project: { questionText: 1, questionType: 1, options: 1, image: 1 } },
    ]);

    const attempt = await StudyQuizAttempt.create({
      userId: user._id,
      day: today,
      subject,
      unit,
      material,
      claimedPercent: percent,
      topics: String(topics).slice(0, 300),
      questionIds: picked.map((q) => q._id),
      total: picked.length,
      passPercent: config.passPercent,
    });

    return ok(res, {
      attemptId: attempt._id,
      passPercent: config.passPercent,
      questions: picked.map((q) => ({
        _id: q._id,
        questionText: q.questionText,
        questionType: q.questionType,
        options: q.options || [],
        image: q.image || null,
      })),
    });
  } catch (err) {
    console.error("studyTracker.startCheck", err);
    return fail(res, 500, "Could not start the check. Please try again.");
  }
};

// POST /api/study-tracker/me/check/submit  { attemptId, answers: [{ questionId, indexes: [n] }] }
const submitCheck = async (req, res) => {
  try {
    const user = req.user;
    const attempt = await StudyQuizAttempt.findOne({ _id: req.body?.attemptId, userId: user._id });
    if (!attempt) return fail(res, 404, "This check was not found. Please start again.");
    if (attempt.submittedAt) return fail(res, 409, "This check is already submitted.");

    const questions = await Question.find({ _id: { $in: attempt.questionIds } }).lean();
    const byId = new Map(questions.map((q) => [String(q._id), q]));
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    const ansById = new Map(answers.map((a) => [String(a.questionId), a]));

    let correct = 0;
    const review = [];
    for (const qid of attempt.questionIds) {
      const q = byId.get(String(qid));
      if (!q) continue;
      const a = ansById.get(String(qid));
      const indexes = Array.isArray(a?.indexes) ? a.indexes.map(Number).filter((n) => Number.isInteger(n)) : [];
      const optText = (i) => {
        const o = (q.options || [])[i];
        return typeof o === "object" && o !== null ? o.text : o;
      };
      const studentAnswer = q.questionType === "MSQ" ? indexes.map(optText) : indexes.length ? optText(indexes[0]) : undefined;
      const status = indexes.length
        ? getAnswerStatus({
            questionType: q.questionType,
            correctAnswers: q.correctAnswers,
            studentAnswer,
            correctOptionIndexes: q.correctOptionIndexes,
            studentAnswerIndexes: indexes,
          })
        : "Skipped";
      if (status === "Correct") correct += 1;
      let correctIndexes = Array.isArray(q.correctOptionIndexes) && q.correctOptionIndexes.length
        ? q.correctOptionIndexes
        : (q.options || []).map((o, i) => ((q.correctAnswers || []).includes(typeof o === "object" && o !== null ? o.text : o) ? i : -1)).filter((i) => i >= 0);
      review.push({ questionId: q._id, chosen: indexes, correctIndexes, status });
    }

    const total = attempt.questionIds.length || 1;
    const scorePercent = Math.round((correct / total) * 100);
    const passed = scorePercent >= attempt.passPercent;

    attempt.answers = review;
    attempt.correct = correct;
    attempt.scorePercent = scorePercent;
    attempt.passed = passed;
    attempt.submittedAt = new Date();
    await attempt.save();

    if (passed) {
      await StudyEntry.create({
        userId: user._id,
        day: attempt.day,
        subject: attempt.subject,
        unit: attempt.unit,
        material: attempt.material,
        percent: attempt.claimedPercent,
        topics: attempt.topics,
        source: "quiz",
        quizAttempt: attempt._id,
      });
    }

    return ok(res, { correct, total, scorePercent, passPercent: attempt.passPercent, passed, review });
  } catch (err) {
    console.error("studyTracker.submitCheck", err);
    return fail(res, 500, "Could not submit the check. Please try again.");
  }
};

// ── Admin ──────────────────────────────────────────────────────────────

const buildClassSummary = async (day) => {
  const config = await getConfig();
  const students = await trackedStudents(config);
  const ids = students.map((s) => s._id);
  const [plans, entries, attempts, tests] = await Promise.all([
    StudyPlan.find({ userId: { $in: ids } }).lean(),
    StudyEntry.find({ userId: { $in: ids } }).select("userId subject unit material percent day source").lean(),
    StudyQuizAttempt.find({ userId: { $in: ids }, day, submittedAt: { $ne: null } })
      .select("userId subject unit material claimedPercent scorePercent passed")
      .lean(),
    loadTestAverages(ids, config),
  ]);
  const planBy = new Map(plans.map((p) => [String(p.userId), planDatesOf(p)]));
  const trackBy = new Map(plans.map((p) => [String(p.userId), trackOf(p)]));
  const entriesBy = new Map();
  for (const e of entries) {
    const k = String(e.userId);
    if (!entriesBy.has(k)) entriesBy.set(k, []);
    entriesBy.get(k).push(e);
  }
  const attemptsBy = new Map();
  for (const a of attempts) {
    const k = String(a.userId);
    if (!attemptsBy.has(k)) attemptsBy.set(k, []);
    attemptsBy.get(k).push(a);
  }

  const rows = students.map((s) => {
    const k = String(s._id);
    const mine = entriesBy.get(k) || [];
    const civilTrack = trackBy.get(k) || "jdo";
    const progress = buildStudentProgress({ entries: mine, planDates: planBy.get(k) || {}, today: day, civilTrack });
    const todayEntries = mine.filter((e) => e.day === day);
    const todayAttempts = attemptsBy.get(k) || [];
    const lastDay = mine.map((e) => e.day).filter((d) => d <= day).sort().pop() || null;
    return {
      student: s,
      updatedToday: todayEntries.length > 0,
      todayEntries: todayEntries.length,
      checksToday: { passed: todayAttempts.filter((a) => a.passed).length, failed: todayAttempts.filter((a) => !a.passed).length },
      lastUpdate: lastDay,
      hasPlan: Object.keys(planBy.get(k) || {}).length > 0,
      civilTrack,
      progress,
      tests: summarizeTests(tests.get(k)),
    };
  });

  return {
    day,
    exams: { gs: config.gsExamDate, civil: config.civilExamDate, draughtsman: config.draughtsmanExamDate || "2026-11-24" },
    config: { passPercent: config.passPercent, quizQuestionCount: config.quizQuestionCount, reminderTime: config.reminderTime, enabled: config.enabled },
    syllabus: { subjects: SUBJECTS, labels: SUBJECT_LABELS, units: UNITS, civilTracks: CIVIL_TRACKS, materials: MATERIALS },
    rows,
  };
};

// GET /api/study-tracker/admin/summary?day=YYYY-MM-DD
const getSummary = async (req, res) => {
  try {
    const day = ymdRe.test(req.query.day || "") ? req.query.day : istYmd();
    return ok(res, await buildClassSummary(day));
  } catch (err) {
    console.error("studyTracker.getSummary", err);
    return fail(res, 500, "Could not load the summary.");
  }
};

// GET /api/study-tracker/admin/student/:studentId
const getStudent = async (req, res) => {
  try {
    const student = await userModel.findById(req.params.studentId).select(STUDENT_FIELDS).lean();
    if (!student) return fail(res, 404, "Student not found.");
    const config = await getConfig();
    const [plan, entries, attempts, tests] = await Promise.all([
      StudyPlan.findOne({ userId: student._id }).lean(),
      StudyEntry.find({ userId: student._id }).sort({ day: -1, createdAt: -1 }).lean(),
      StudyQuizAttempt.find({ userId: student._id, submittedAt: { $ne: null } })
        .select("day subject unit material claimedPercent correct total scorePercent passed submittedAt")
        .sort({ submittedAt: -1 })
        .limit(200)
        .lean(),
      loadTestAverages([student._id], config),
    ]);
    return ok(res, {
      student,
      planDates: planDatesOf(plan),
      civilTrack: trackOf(plan),
      progress: buildStudentProgress({ entries, planDates: planDatesOf(plan), civilTrack: trackOf(plan) }),
      entries,
      attempts,
      tests: summarizeTests(tests.get(String(student._id))),
    });
  } catch (err) {
    console.error("studyTracker.getStudent", err);
    return fail(res, 500, "Could not load the student.");
  }
};

// PUT /api/study-tracker/admin/plan/:studentId  { dates: { key: "YYYY-MM-DD" | "" } }
const savePlan = async (req, res) => {
  try {
    const student = await userModel.findById(req.params.studentId).select("_id").lean();
    if (!student) return fail(res, 404, "Student not found.");
    const valid = new Set(ALL_PLAN_KEYS.map((p) => p.key));
    const dates = {};
    for (const [k, v] of Object.entries(req.body?.dates || {})) {
      if (!valid.has(k)) continue;
      if (v && !ymdRe.test(v)) return fail(res, 400, `"${k}" has a wrong date. Use the date picker.`);
      if (v) dates[k] = v;
    }
    const set = { dates: toDateList(dates), updatedBy: req.user._id };
    if (CIVIL_TRACKS[req.body?.civilTrack]) set.civilTrack = req.body.civilTrack;
    const plan = await StudyPlan.findOneAndUpdate(
      { userId: student._id },
      { $set: set },
      { upsert: true, new: true }
    ).lean();
    return ok(res, { planDates: planDatesOf(plan), civilTrack: trackOf(plan) });
  } catch (err) {
    console.error("studyTracker.savePlan", err);
    return fail(res, 500, "Could not save the target dates.");
  }
};

// POST /api/study-tracker/admin/entry  { studentId, day, subject, unit, material, percent }
// Admin correction (e.g. a report the employee missed). Counts like a passed check.
const addAdminEntry = async (req, res) => {
  try {
    const { studentId, subject, unit, material } = req.body || {};
    const percent = Number(req.body?.percent);
    const day = ymdRe.test(req.body?.day || "") ? req.body.day : istYmd();
    if (!isValidUnit(subject, unit) || !isValidMaterial(subject, material) || !PROGRESS_STEPS.includes(percent)) {
      return fail(res, 400, "Choose subject, unit, material and amount.");
    }
    const student = await userModel.findById(studentId).select("_id").lean();
    if (!student) return fail(res, 404, "Student not found.");
    const entry = await StudyEntry.create({ userId: student._id, day, subject, unit, material, percent, source: "admin" });
    return ok(res, entry);
  } catch (err) {
    console.error("studyTracker.addAdminEntry", err);
    return fail(res, 500, "Could not save.");
  }
};

// DELETE /api/study-tracker/admin/entry/:entryId
const deleteEntry = async (req, res) => {
  try {
    await StudyEntry.deleteOne({ _id: req.params.entryId });
    return ok(res, { deleted: true });
  } catch (err) {
    console.error("studyTracker.deleteEntry", err);
    return fail(res, 500, "Could not delete.");
  }
};

// GET /api/study-tracker/admin/config — settings + question sources + test subjects
const getAdminConfig = async (req, res) => {
  try {
    const config = await getConfig();
    const subjects = await Subject.find({ category: TRACKER_CATEGORY }).select("name subtopics._id subtopics.name").sort({ name: 1 }).lean();
    const counts = await Question.aggregate([
      { $match: { subject: { $in: subjects.map((s) => s._id) }, questionType: { $in: CHECK_TYPES } } },
      { $group: { _id: { subject: "$subject", subTopic: "$subTopic" }, n: { $sum: 1 } } },
    ]);
    const countBy = new Map(counts.map((c) => [`${c._id.subject}|${c._id.subTopic}`, c.n]));
    return ok(res, {
      settings: {
        enabled: config.enabled,
        quizQuestionCount: config.quizQuestionCount,
        passPercent: config.passPercent,
        reminderTime: config.reminderTime,
        testTotalMarks: config.testTotalMarks,
        gsExamDate: config.gsExamDate,
        civilExamDate: config.civilExamDate,
        draughtsmanExamDate: config.draughtsmanExamDate || "2026-11-24",
      },
      syllabus: { subjects: SUBJECTS, labels: SUBJECT_LABELS, units: { ...UNITS, Civil: [...CIVIL_TRACKS.jdo.units, ...CIVIL_TRACKS.draughtsman.units] }, civilTracks: CIVIL_TRACKS, materials: MATERIALS, poolFallback: POOL_FALLBACK },
      questionPools: poolsOf(config),
      chosenList: hasChosenList(config),
      studentIds: hasChosenList(config) ? config.studentIds.map(String) : (await trackedStudents(config)).map((u) => String(u._id)),
      candidates: await userModel
        .find({ role: "student", accountType: { $ne: "free_trial" }, isDisabled: { $ne: true } })
        .select("username email category batch")
        .sort({ category: 1, username: 1 })
        .lean(),
      testSubjectTypes: config.testSubjectTypes instanceof Map ? Object.fromEntries(config.testSubjectTypes) : config.testSubjectTypes || {},
      sources: subjects.map((s) => ({
        _id: s._id,
        name: s.name,
        subtopics: (s.subtopics || []).map((t) => ({ _id: t._id, name: t.name, questions: countBy.get(`${s._id}|${t._id}`) || 0 })),
      })),
    });
  } catch (err) {
    console.error("studyTracker.getAdminConfig", err);
    return fail(res, 500, "Could not load the settings.");
  }
};

// PUT /api/study-tracker/admin/config  { settings?, questionPools?, testSubjectTypes? }
const saveAdminConfig = async (req, res) => {
  try {
    const config = await getConfig();
    const { settings, questionPools, testSubjectTypes, studentIds } = req.body || {};
    if (Array.isArray(studentIds)) {
      config.studentIds = studentIds.filter((id) => mongoose.isValidObjectId(id));
    }
    if (settings) {
      if (typeof settings.enabled === "boolean") config.enabled = settings.enabled;
      const n = Number(settings.quizQuestionCount);
      if (Number.isInteger(n) && n >= 3 && n <= 30) config.quizQuestionCount = n;
      const p = Number(settings.passPercent);
      if (Number.isFinite(p) && p >= 1 && p <= 100) config.passPercent = Math.round(p);
      if (/^\d{2}:\d{2}$/.test(settings.reminderTime || "")) config.reminderTime = settings.reminderTime;
      const t = Number(settings.testTotalMarks);
      if (Number.isFinite(t) && t >= 1 && t <= 1000) config.testTotalMarks = t;
      if (ymdRe.test(settings.gsExamDate || "")) config.gsExamDate = settings.gsExamDate;
      if (ymdRe.test(settings.civilExamDate || "")) config.civilExamDate = settings.civilExamDate;
      if (ymdRe.test(settings.draughtsmanExamDate || "")) config.draughtsmanExamDate = settings.draughtsmanExamDate;
    }
    if (questionPools && typeof questionPools === "object") {
      const validKeys = new Set();
      for (const s of SUBJECTS) for (const u of (s === "Civil" ? [...CIVIL_TRACKS.jdo.units, ...CIVIL_TRACKS.draughtsman.units] : UNITS[s])) for (const m of MATERIALS[s]) validKeys.add(poolKey(s, u, m));
      const next = [];
      for (const [k, refs] of Object.entries(questionPools)) {
        if (!validKeys.has(k) || !Array.isArray(refs)) continue;
        const clean = refs
          .filter((r) => mongoose.isValidObjectId(r?.subject) && mongoose.isValidObjectId(r?.subTopic))
          .map((r) => ({ subject: r.subject, subTopic: r.subTopic }));
        if (clean.length) next.push({ key: k, refs: clean });
      }
      config.questionPools = next;
    }
    if (testSubjectTypes && typeof testSubjectTypes === "object") {
      const next = new Map();
      for (const [id, t] of Object.entries(testSubjectTypes)) {
        if (mongoose.isValidObjectId(id) && TEST_TYPES.includes(t)) next.set(id, t);
      }
      config.testSubjectTypes = next;
    }
    await config.save();
    return ok(res, { saved: true });
  } catch (err) {
    console.error("studyTracker.saveAdminConfig", err);
    return fail(res, 500, "Could not save the settings.");
  }
};

// POST /api/study-tracker/admin/import
// { mapping: { "<old name>": "<studentId>" }, plans: [{student, dates}], entries: [{s, d, sub, unit, mat, pct, topics}] }
// One-time copy of the old tracker page's data. Re-running replaces earlier
// imported rows for the same students (never touches students' own reports).
const importOld = async (req, res) => {
  try {
    const { mapping = {}, plans = [], entries = [] } = req.body || {};
    const idFor = (name) => (mongoose.isValidObjectId(mapping[name]) ? mapping[name] : null);
    const ids = [...new Set(Object.values(mapping).filter((v) => mongoose.isValidObjectId(v)))];
    if (!ids.length) return fail(res, 400, "Match at least one student first.");
    const existing = await userModel.find({ _id: { $in: ids } }).select("_id").lean();
    const known = new Set(existing.map((u) => String(u._id)));

    const validPlanKeys = new Set(ALL_PLAN_KEYS.map((p) => p.key));
    let planCount = 0;
    for (const p of plans) {
      const uid = idFor(p.student);
      if (!uid || !known.has(String(uid))) continue;
      const dates = {};
      for (const [k, v] of Object.entries(p.dates || {})) if (validPlanKeys.has(k) && ymdRe.test(v)) dates[k] = v;
      const set = { dates: toDateList(dates), updatedBy: req.user._id };
      if (CIVIL_TRACKS[p.civilTrack]) set.civilTrack = p.civilTrack;
      await StudyPlan.findOneAndUpdate({ userId: uid }, { $set: set }, { upsert: true });
      planCount += 1;
    }

    await StudyEntry.deleteMany({ userId: { $in: ids }, source: "migrated" });
    const docs = [];
    for (const e of entries) {
      const uid = idFor(e.s);
      if (!uid || !known.has(String(uid))) continue;
      const pct = Number(e.pct);
      if (!isValidUnit(e.sub, e.unit) || !isValidMaterial(e.sub, e.mat) || !PROGRESS_STEPS.includes(pct) || !ymdRe.test(e.d || "")) continue;
      docs.push({ userId: uid, day: e.d, subject: e.sub, unit: e.unit, material: e.mat, percent: pct, topics: String(e.topics || "").slice(0, 300), source: "migrated" });
    }
    if (docs.length) await StudyEntry.insertMany(docs);
    return ok(res, { plans: planCount, entries: docs.length, skipped: entries.length - docs.length });
  } catch (err) {
    console.error("studyTracker.importOld", err);
    return fail(res, 500, "Import failed.");
  }
};

// Used by GET /api/users/me so the app can show the "My Study Plan" link.
const studentGetsTracker = async (user) => {
  try {
    const config = await getConfig();
    return Boolean(config.enabled && isTrackedStudent(user, config));
  } catch {
    return false;
  }
};

module.exports = {
  studentGetsTracker,
  getMine,
  markIntroSeen,
  fillMyMissingDates,
  startCheck,
  submitCheck,
  getSummary,
  getStudent,
  savePlan,
  addAdminEntry,
  deleteEntry,
  getAdminConfig,
  saveAdminConfig,
  importOld,
  // exported for tests
  buildClassSummary,
};
