const Subject = require("../models/subjectModel");
const Exam = require("../models/examModel");
const ExamSubmission = require("../models/examSubmissionSchema");
const User = require("../models/userModel");
const markModel = require("../models/markModel");
const VideoProgress = require("../models/videoProgressModel");
const AttachmentProgress = require("../models/attachmentProgressModel");
const { calculateTotalPossibleMarks } = require("./ExamSubmissionHelper");
const { EXAM_CATEGORIES, EXAM_CATEGORY_LABELS } = require("../constants/examCategories");

// How recent counts as "engaged" for the Engagement-to-Performance
// correlation on the admin Category Rollup — watched at least one video or
// opened at least one attachment within this many days. A fixed window
// rather than an admin-configurable one for now (kept simple, same
// discipline as everything else in this file not inventing a config model
// until there's a real need to tune it).
const ENGAGEMENT_WINDOW_DAYS = 30;

// The whole point of this dashboard, in the admin's own words: "know their
// performance compared to other students who enrolled in gate if they are
// appearing in gate, similarly for tnpsc and other exams." Every number
// this helper returns is scoped to the student's own exam category — GATE
// students are only ever compared against other GATE students, never
// against TNPSC/SSC-RRB-JE students, and vice versa. This is a narrower
// (and more correct) scope than the pre-existing global rank in
// dashboardController.js's getStudentDetailedAnalysis, which ranks a
// student against every student regardless of category — that's a
// pre-existing gap, left alone here since fixing it is a separate change,
// but worth knowing this new helper does NOT reuse that computation.
//
// Returns null when the student has no category assigned yet (nothing to
// compare against). Otherwise returns:
//   {
//     category, categoryLabel, hasData,
//     overall: { avgPercentage, rank, totalStudents, percentile, categoryAvgPercentage } | null,
//     perExam: [{ examId, examCode, subjectName, subTopicName, order,
//                  myPercentage, myObtainedMark, myTotalMarks, mySpeed, myAccuracy,
//                  rank, totalParticipants, categoryAvgPercentage }],
//     perTopic: [{ subjectName, subTopicName, myAvgPercentage, categoryAvgPercentage,
//                   rank, totalStudents }],
//     speedAccuracy: { myAvgSpeed, categoryAvgSpeed, myAvgAccuracy, categoryAvgAccuracy } | null,
//   }
//
// `hasData: false` means the student's category itself has zero completed
// submissions yet from ANYONE (a brand-new category with no test history) —
// distinct from the student having no category at all (returns null).
const computeCategoryPerformance = async (studentId) => {
  const studentIdStr = studentId.toString();
  const student = await User.findById(studentId).select("username category").lean();
  if (!student || !student.category) {
    return null;
  }

  const subjects = await Subject.find({ category: student.category }).lean();
  const subjectIds = subjects.map((s) => s._id);
  const subjectById = new Map(subjects.map((s) => [s._id.toString(), s]));

  const exams = await Exam.find({ subject: { $in: subjectIds } })
    .select("_id subject subTopic examCode order")
    .lean();
  const examIds = exams.map((e) => e._id);
  const examById = new Map(exams.map((e) => [e._id.toString(), e]));

  const emptyResult = {
    category: student.category,
    categoryLabel: EXAM_CATEGORY_LABELS[student.category] || student.category,
    hasData: false,
    overall: null,
    perExam: [],
    perTopic: [],
    speedAccuracy: null,
  };

  if (examIds.length === 0) return emptyResult;

  const markData = await markModel.findById("mark-based-on-levels");

  // The whole category cohort's completed submissions, in one query — every
  // stat below (overall, per-exam, per-topic, speed/accuracy) is derived
  // from this single dataset, same "fetch once, derive everything" pattern
  // already used by getTopicPerformanceOverview in dashboardController.js.
  const submissions = await ExamSubmission.find({
    examId: { $in: examIds },
    status: "completed",
  })
    .select("examId userId obtainedMark speedPercent accuracyPercent")
    .populate({ path: "examId", select: "subject subTopic questions", populate: { path: "questions" } })
    .populate("userId", "username")
    .lean();

  if (submissions.length === 0) return emptyResult;

  const pctOf = (sub) => {
    if (!sub.examId) return 0;
    const totalMarks = calculateTotalPossibleMarks(sub.examId.questions || [], markData);
    return totalMarks > 0 ? (sub.obtainedMark / totalMarks) * 100 : 0;
  };

  const avg = (arr) => (arr.length ? arr.reduce((sum, v) => sum + v, 0) / arr.length : null);
  const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

  // ---- Overall: average % per student, across every exam they've
  // completed in this category — this is what "rank" and "percentile" mean
  // on this dashboard. ----
  const byStudent = new Map(); // studentId -> { pcts: [], speeds: [], accuracies: [] }
  submissions.forEach((sub) => {
    const sid = sub.userId?._id?.toString();
    if (!sid) return;
    if (!byStudent.has(sid)) byStudent.set(sid, { pcts: [], speeds: [], accuracies: [] });
    const entry = byStudent.get(sid);
    entry.pcts.push(pctOf(sub));
    if (sub.speedPercent !== null && sub.speedPercent !== undefined) entry.speeds.push(sub.speedPercent);
    if (sub.accuracyPercent !== null && sub.accuracyPercent !== undefined) entry.accuracies.push(sub.accuracyPercent);
  });

  const overallList = [...byStudent.entries()]
    .map(([sid, e]) => ({ studentId: sid, avgPct: avg(e.pcts) }))
    .sort((a, b) => b.avgPct - a.avgPct);

  const totalStudentsInCategory = overallList.length;
  const myOverallRank =
    overallList.findIndex((s) => s.studentId === studentIdStr) + 1 || null;
  const myOverallPercentile =
    myOverallRank && totalStudentsInCategory > 0
      ? round1(((totalStudentsInCategory - myOverallRank) / totalStudentsInCategory) * 100)
      : null;
  const myEntry = byStudent.get(studentIdStr);

  const overall = myEntry
    ? {
        avgPercentage: round1(avg(myEntry.pcts)),
        rank: myOverallRank,
        totalStudents: totalStudentsInCategory,
        // e.g. 87.5 means this student scored better than 87.5% of their
        // category peers, on average, across everything they've attempted.
        percentile: myOverallPercentile,
        categoryAvgPercentage: round1(avg(overallList.map((s) => s.avgPct))),
      }
    : null;

  // ---- Per-exam: for every exam THIS student has completed, rank them
  // against every other category student who also completed that same
  // exam. ----
  const examGroups = new Map(); // examId -> [{ studentId, pct, speed, accuracy }]
  submissions.forEach((sub) => {
    const eid = sub.examId?._id?.toString();
    if (!eid) return;
    if (!examGroups.has(eid)) examGroups.set(eid, []);
    examGroups.get(eid).push({
      studentId: sub.userId?._id?.toString(),
      pct: pctOf(sub),
      speed: sub.speedPercent,
      accuracy: sub.accuracyPercent,
    });
  });

  const perExam = [];
  examGroups.forEach((list, eid) => {
    const mine = list.find((s) => s.studentId === studentIdStr);
    if (!mine) return; // only exams this student has actually taken
    const sorted = [...list].sort((a, b) => b.pct - a.pct);
    const rank = sorted.findIndex((s) => s.studentId === studentIdStr) + 1;
    const examMeta = examById.get(eid);
    const subjectMeta = examMeta ? subjectById.get(examMeta.subject?.toString()) : null;
    const subtopicMeta = subjectMeta
      ? (subjectMeta.subtopics || []).find((st) => st._id.toString() === examMeta.subTopic?.toString())
      : null;
    perExam.push({
      examId: eid,
      examCode: examMeta?.examCode || "—",
      subjectName: subjectMeta?.name || "—",
      subTopicName: subtopicMeta?.name || "—",
      order: examMeta?.order ?? 0,
      myPercentage: round1(mine.pct),
      mySpeed: round1(mine.speed),
      myAccuracy: round1(mine.accuracy),
      rank,
      totalParticipants: list.length,
      categoryAvgPercentage: round1(avg(list.map((s) => s.pct))),
    });
  });
  perExam.sort(
    (a, b) => a.order - b.order || a.subjectName.localeCompare(b.subjectName)
  );

  // ---- Per-topic: same subject+subtopic grouping as
  // getTopicPerformanceOverview, but scoped to this student's own attempted
  // topics only, comparing their average vs. the category-wide average on
  // that same topic. ----
  const topicGroups = new Map(); // "subjectId|subTopicId" -> Map<studentId, pct[]>
  submissions.forEach((sub) => {
    const examMeta = sub.examId;
    if (!examMeta || !examMeta.subject || !examMeta.subTopic) return;
    const key = `${examMeta.subject}|${examMeta.subTopic}`;
    if (!topicGroups.has(key)) topicGroups.set(key, new Map());
    const studMap = topicGroups.get(key);
    const sid = sub.userId?._id?.toString();
    if (!sid) return;
    if (!studMap.has(sid)) studMap.set(sid, []);
    studMap.get(sid).push(pctOf(sub));
  });

  const perTopic = [];
  topicGroups.forEach((studMap, key) => {
    if (!studMap.has(studentIdStr)) return; // only topics this student has attempted
    const [subjectIdStr, subTopicIdStr] = key.split("|");
    const subjectMeta = subjectById.get(subjectIdStr);
    const subtopicMeta = subjectMeta
      ? (subjectMeta.subtopics || []).find((st) => st._id.toString() === subTopicIdStr)
      : null;
    const entries = [...studMap.entries()]
      .map(([sid, pcts]) => ({ studentId: sid, avgPct: avg(pcts) }))
      .sort((a, b) => b.avgPct - a.avgPct);
    const rank = entries.findIndex((e) => e.studentId === studentIdStr) + 1;
    perTopic.push({
      subjectName: subjectMeta?.name || "—",
      subTopicName: subtopicMeta?.name || "—",
      myAvgPercentage: round1(avg(studMap.get(studentIdStr))),
      categoryAvgPercentage: round1(avg(entries.map((e) => e.avgPct))),
      rank,
      totalStudents: entries.length,
    });
  });
  perTopic.sort(
    (a, b) => a.subjectName.localeCompare(b.subjectName) || a.subTopicName.localeCompare(b.subTopicName)
  );

  // ---- Speed & Accuracy vs. category average ----
  const allSpeeds = [...byStudent.values()].flatMap((e) => e.speeds);
  const allAccuracies = [...byStudent.values()].flatMap((e) => e.accuracies);
  const speedAccuracy = {
    myAvgSpeed: myEntry ? round1(avg(myEntry.speeds)) : null,
    categoryAvgSpeed: round1(avg(allSpeeds)),
    myAvgAccuracy: myEntry ? round1(avg(myEntry.accuracies)) : null,
    categoryAvgAccuracy: round1(avg(allAccuracies)),
  };

  return {
    category: student.category,
    categoryLabel: EXAM_CATEGORY_LABELS[student.category] || student.category,
    hasData: true,
    overall,
    perExam,
    perTopic,
    speedAccuracy,
  };
};

// A public, per-test leaderboard: top 10 performers on every test in the
// student's own category — visible to every student in that category, not
// just their own comparison (that's computeCategoryPerformance above). Still
// scoped by category the same way as everything else in this file: a GATE
// student only ever sees a GATE leaderboard, never TNPSC/SSC-RRB-JE names.
//
// Unlike computeCategoryPerformance's perExam (which only lists exams THIS
// student has attempted), this covers every exam in the category that has
// at least one completed submission from anyone — so a student can see the
// leaderboard for a test they haven't taken yet too.
//
// Returns null when the student has no category. Otherwise:
//   { category, categoryLabel, hasData, leaderboards: [{
//       examId, examCode, subjectName, subTopicName, order, totalParticipants,
//       topPerformers: [{ rank, name, percentage, isMe }],
//       myRank, myPercentage, attemptedByMe,
//   }] }
const computeCategoryLeaderboards = async (studentId) => {
  const studentIdStr = studentId.toString();
  const student = await User.findById(studentId).select("username category").lean();
  if (!student || !student.category) {
    return null;
  }

  const subjects = await Subject.find({ category: student.category }).lean();
  const subjectIds = subjects.map((s) => s._id);
  const subjectById = new Map(subjects.map((s) => [s._id.toString(), s]));

  const exams = await Exam.find({ subject: { $in: subjectIds } })
    .select("_id subject subTopic examCode order")
    .lean();
  const examById = new Map(exams.map((e) => [e._id.toString(), e]));

  const emptyResult = {
    category: student.category,
    categoryLabel: EXAM_CATEGORY_LABELS[student.category] || student.category,
    hasData: false,
    leaderboards: [],
  };

  if (exams.length === 0) return emptyResult;

  const markData = await markModel.findById("mark-based-on-levels");

  const submissions = await ExamSubmission.find({
    examId: { $in: exams.map((e) => e._id) },
    status: "completed",
  })
    .select("examId userId obtainedMark completedAt")
    .populate({ path: "examId", select: "subject subTopic questions", populate: { path: "questions" } })
    .populate("userId", "username")
    .lean();

  if (submissions.length === 0) return emptyResult;

  const pctOf = (sub) => {
    if (!sub.examId) return 0;
    const totalMarks = calculateTotalPossibleMarks(sub.examId.questions || [], markData);
    return totalMarks > 0 ? (sub.obtainedMark / totalMarks) * 100 : 0;
  };
  const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

  const examGroups = new Map(); // examId -> [{ studentId, name, pct, completedAt }]
  submissions.forEach((sub) => {
    const eid = sub.examId?._id?.toString();
    if (!eid) return;
    if (!examGroups.has(eid)) examGroups.set(eid, []);
    examGroups.get(eid).push({
      studentId: sub.userId?._id?.toString(),
      name: sub.userId?.username || "—",
      pct: pctOf(sub),
      completedAt: sub.completedAt ? new Date(sub.completedAt).getTime() : Infinity,
    });
  });

  const leaderboards = [];
  examGroups.forEach((list, eid) => {
    // Best attempt per student on this test (a student can have up to 3
    // attempts — the leaderboard should reflect their best showing, not
    // penalize/duplicate them for retrying).
    const bestByStudent = new Map();
    list.forEach((entry) => {
      const existing = bestByStudent.get(entry.studentId);
      if (!existing || entry.pct > existing.pct) bestByStudent.set(entry.studentId, entry);
    });
    const sorted = [...bestByStudent.values()].sort(
      (a, b) => b.pct - a.pct || a.completedAt - b.completedAt
    );

    const examMeta = examById.get(eid);
    const subjectMeta = examMeta ? subjectById.get(examMeta.subject?.toString()) : null;
    const subtopicMeta = subjectMeta
      ? (subjectMeta.subtopics || []).find((st) => st._id.toString() === examMeta.subTopic?.toString())
      : null;

    const myIndex = sorted.findIndex((s) => s.studentId === studentIdStr);
    const attemptedByMe = myIndex !== -1;

    leaderboards.push({
      examId: eid,
      examCode: examMeta?.examCode || "—",
      subjectName: subjectMeta?.name || "—",
      subTopicName: subtopicMeta?.name || "—",
      order: examMeta?.order ?? 0,
      totalParticipants: sorted.length,
      topPerformers: sorted.slice(0, 10).map((s, i) => ({
        rank: i + 1,
        name: s.name,
        percentage: round1(s.pct),
        isMe: s.studentId === studentIdStr,
      })),
      myRank: attemptedByMe ? myIndex + 1 : null,
      myPercentage: attemptedByMe ? round1(sorted[myIndex].pct) : null,
      attemptedByMe,
    });
  });

  leaderboards.sort(
    (a, b) => a.order - b.order || a.subjectName.localeCompare(b.subjectName)
  );

  return {
    category: student.category,
    categoryLabel: EXAM_CATEGORY_LABELS[student.category] || student.category,
    hasData: true,
    leaderboards,
  };
};

// This student's own attempt-by-attempt history, in chronological order —
// the raw material for two new page sections: a trend-over-time chart
// (score/speed/accuracy per attempt) and a speed-vs-accuracy quadrant
// scatter. Deliberately a single, lightweight endpoint rather than two:
// both visualizations are just different ways of looking at the exact same
// per-attempt data, so there's no reason to compute or fetch it twice.
// Unlike computeCategoryPerformance (which fetches the whole category
// cohort), this only ever queries THIS student's own submissions — much
// cheaper, and there's nothing category-wide to compare here.
//
// Returns null when the student has no category. Otherwise:
//   { category, categoryLabel, hasData, attempts: [{
//       completedAt, examId, examCode, subjectId, subjectName, subTopicId,
//       subTopicName, attemptNumber, percentage, speedPercent, accuracyPercent,
//   }], readiness: { tier, score, recencyWeightedAccuracy, topicCoverage,
//       topicsAttempted, totalTopics, consistencyScore } } — attempts sorted
//   oldest to newest.
//
// Readiness tier — a simplified version of the "Exam Readiness Score" idea:
// shown as a tier (Not Started / Building / On Track / Exam Ready) rather
// than a bare number, deliberately, so it doesn't invite over-interpretation
// of a composite metric. Blends three signals, same three proposed when this
// was first scoped out: (a) recency-weighted accuracy — the last up to 5
// attempts, most recent weighted highest, so a student who's improving isn't
// dragged down by an old bad attempt; (b) syllabus coverage — distinct
// topics attempted ÷ total topics in the category, so 90% on 2 of 8 topics
// doesn't read as "ready"; (c) consistency — how tightly the last few
// attempts cluster together, since wildly swinging scores read as less
// ready than steadily-improving ones. The 50/30/20 weighting and the
// tier cutoffs (<40 Building, 40–74 On Track, ≥75 Exam Ready — the same
// "Good ≥75%" band used elsewhere in the app) are a reasonable starting
// point, not a confirmed formula — flagged as adjustable, same as the
// existing progress-weight config, if the actual weighting ever needs
// tuning.
const computeStudentAttemptHistory = async (studentId) => {
  const student = await User.findById(studentId).select("username category").lean();
  if (!student || !student.category) {
    return null;
  }

  const subjects = await Subject.find({ category: student.category }).lean();
  const subjectById = new Map(subjects.map((s) => [s._id.toString(), s]));
  const subjectIds = subjects.map((s) => s._id);
  const totalTopicsInCategory = subjects.reduce(
    (sum, s) => sum + (s.subtopics || []).length,
    0
  );

  const exams = await Exam.find({ subject: { $in: subjectIds } })
    .select("_id subject subTopic examCode")
    .lean();
  const examById = new Map(exams.map((e) => [e._id.toString(), e]));

  const emptyResult = {
    category: student.category,
    categoryLabel: EXAM_CATEGORY_LABELS[student.category] || student.category,
    hasData: false,
    attempts: [],
    readiness: {
      tier: "Not Started",
      score: 0,
      recencyWeightedAccuracy: null,
      topicCoverage: 0,
      topicsAttempted: 0,
      totalTopics: totalTopicsInCategory,
      consistencyScore: null,
    },
  };

  if (exams.length === 0) return emptyResult;

  const markData = await markModel.findById("mark-based-on-levels");

  const submissions = await ExamSubmission.find({
    examId: { $in: exams.map((e) => e._id) },
    userId: studentId,
    status: "completed",
  })
    .select("examId obtainedMark speedPercent accuracyPercent completedAt attemptNumber")
    .populate({ path: "examId", select: "subject subTopic questions", populate: { path: "questions" } })
    .lean();

  if (submissions.length === 0) return emptyResult;

  const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

  const attempts = submissions
    .map((sub) => {
      const eid = sub.examId?._id?.toString();
      const examMeta = eid ? examById.get(eid) : null;
      const subjectMeta = examMeta ? subjectById.get(examMeta.subject?.toString()) : null;
      const subtopicMeta = subjectMeta
        ? (subjectMeta.subtopics || []).find((st) => st._id.toString() === examMeta.subTopic?.toString())
        : null;
      const totalMarks = sub.examId
        ? calculateTotalPossibleMarks(sub.examId.questions || [], markData)
        : 0;
      const percentage = totalMarks > 0 ? (sub.obtainedMark / totalMarks) * 100 : 0;
      return {
        completedAt: sub.completedAt,
        examId: eid || null,
        examCode: examMeta?.examCode || "—",
        subjectId: subjectMeta?._id?.toString() || null,
        subjectName: subjectMeta?.name || "—",
        subTopicId: subtopicMeta?._id?.toString() || null,
        subTopicName: subtopicMeta?.name || "—",
        attemptNumber: sub.attemptNumber ?? 1,
        percentage: round1(percentage),
        speedPercent: round1(sub.speedPercent),
        accuracyPercent: round1(sub.accuracyPercent),
      };
    })
    .filter((a) => a.completedAt) // a completed submission should always have this, but never chart an undated point
    .sort((a, b) => new Date(a.completedAt) - new Date(b.completedAt));

  // ---- Readiness tier ----
  const topicsAttemptedSet = new Set(
    attempts.filter((a) => a.subTopicId).map((a) => `${a.subjectId}|${a.subTopicId}`)
  );
  const topicsAttempted = topicsAttemptedSet.size;
  const topicCoverage = totalTopicsInCategory > 0 ? topicsAttempted / totalTopicsInCategory : 0;

  // Most recent first, capped at the last 5 attempts.
  const recent = [...attempts].reverse().slice(0, 5);

  const weightedAvg = (values) => {
    // values already ordered most-recent-first; weight = position from the
    // end (most recent gets the highest weight).
    let weightedSum = 0;
    let weightTotal = 0;
    values.forEach((v, i) => {
      if (v === null || v === undefined) return;
      const weight = values.length - i;
      weightedSum += v * weight;
      weightTotal += weight;
    });
    return weightTotal > 0 ? weightedSum / weightTotal : null;
  };

  const recencyWeightedAccuracyRaw = weightedAvg(recent.map((a) => a.accuracyPercent));
  // Falls back to overall score when accuracy isn't available (e.g. older
  // submissions predating the speed/accuracy feature) so readiness never
  // silently breaks for a student with older attempts.
  const recencyWeightedAccuracy =
    recencyWeightedAccuracyRaw !== null
      ? recencyWeightedAccuracyRaw
      : weightedAvg(recent.map((a) => a.percentage));

  const recentPercentages = recent.map((a) => a.percentage).filter((p) => p !== null);
  let consistencyScore = null;
  if (recentPercentages.length >= 2) {
    const mean = recentPercentages.reduce((s, v) => s + v, 0) / recentPercentages.length;
    const variance =
      recentPercentages.reduce((s, v) => s + (v - mean) ** 2, 0) / recentPercentages.length;
    const stddev = Math.sqrt(variance);
    consistencyScore = Math.max(0, Math.min(100, 100 - stddev * 2));
  } else {
    // A single attempt is neither consistent nor inconsistent yet — treat
    // as neutral rather than penalizing or rewarding.
    consistencyScore = 50;
  }

  const compositeScore = round1(
    0.5 * (recencyWeightedAccuracy ?? 0) + 0.3 * (topicCoverage * 100) + 0.2 * consistencyScore
  );

  let tier = "Building";
  if (compositeScore >= 75) tier = "Exam Ready";
  else if (compositeScore >= 40) tier = "On Track";

  return {
    category: student.category,
    categoryLabel: EXAM_CATEGORY_LABELS[student.category] || student.category,
    hasData: attempts.length > 0,
    attempts,
    readiness: {
      tier,
      score: compositeScore,
      recencyWeightedAccuracy: round1(recencyWeightedAccuracy),
      topicCoverage: round1(topicCoverage * 100),
      topicsAttempted,
      totalTopics: totalTopicsInCategory,
      consistencyScore: round1(consistencyScore),
    },
  };
};

// Admin-only, category-wide rollup — the thing the per-exam Exam Dashboard
// doesn't show: a period-based view across EVERY exam in a category at
// once, the kind of number an admin wants before planning the next
// revision class rather than one exam at a time. `fromDate`/`toDate` are
// optional ISO date strings (inclusive on `completedAt`); omitted entirely,
// this rolls up all-time data for the category.
//
// Returns null for an invalid/unknown category. Otherwise:
//   { category, categoryLabel, hasData, totalAttempts, distinctStudents,
//     passRate, avgPercentage, avgSpeed, avgAccuracy,
//     mostMissedTopics: [{ subjectName, subTopicName, avgPercentage, attempts }],
//     engagement: { windowDays, engagedStudents, notEngagedStudents,
//       engagedAvgScore, notEngagedAvgScore, engagedAttempts, notEngagedAttempts } | null }
const computeCategoryRollup = async (category, { fromDate, toDate } = {}) => {
  if (!EXAM_CATEGORIES.includes(category)) return null;

  const subjects = await Subject.find({ category }).lean();
  const subjectById = new Map(subjects.map((s) => [s._id.toString(), s]));
  const subjectIds = subjects.map((s) => s._id);

  const exams = await Exam.find({ subject: { $in: subjectIds } })
    .select("_id subject subTopic")
    .lean();
  const examById = new Map(exams.map((e) => [e._id.toString(), e]));

  const emptyResult = {
    category,
    categoryLabel: EXAM_CATEGORY_LABELS[category] || category,
    hasData: false,
    totalAttempts: 0,
    distinctStudents: 0,
    passRate: null,
    avgPercentage: null,
    avgSpeed: null,
    avgAccuracy: null,
    mostMissedTopics: [],
    engagement: null,
  };

  if (exams.length === 0) return emptyResult;

  const markData = await markModel.findById("mark-based-on-levels");

  const query = {
    examId: { $in: exams.map((e) => e._id) },
    status: "completed",
  };
  if (fromDate || toDate) {
    query.completedAt = {};
    if (fromDate) query.completedAt.$gte = new Date(fromDate);
    if (toDate) query.completedAt.$lte = new Date(toDate);
  }

  const submissions = await ExamSubmission.find(query)
    .select("examId userId obtainedMark speedPercent accuracyPercent pass")
    .populate({ path: "examId", select: "subject subTopic questions", populate: { path: "questions" } })
    .lean();

  if (submissions.length === 0) return emptyResult;

  const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);
  const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);

  const pctOf = (sub) => {
    if (!sub.examId) return 0;
    const totalMarks = calculateTotalPossibleMarks(sub.examId.questions || [], markData);
    return totalMarks > 0 ? (sub.obtainedMark / totalMarks) * 100 : 0;
  };

  const percentages = [];
  const speeds = [];
  const accuracies = [];
  const passFlags = [];
  const studentIds = new Set();
  const topicPercentages = new Map(); // "subjectId|subTopicId" -> [pct, ...]

  submissions.forEach((sub) => {
    const pct = pctOf(sub);
    percentages.push(pct);
    if (sub.speedPercent !== null && sub.speedPercent !== undefined) speeds.push(sub.speedPercent);
    if (sub.accuracyPercent !== null && sub.accuracyPercent !== undefined) accuracies.push(sub.accuracyPercent);
    if (typeof sub.pass === "boolean") passFlags.push(sub.pass);
    if (sub.userId) studentIds.add(sub.userId.toString());

    const examMeta = sub.examId ? examById.get(sub.examId._id.toString()) : null;
    if (examMeta?.subject && examMeta?.subTopic) {
      const key = `${examMeta.subject}|${examMeta.subTopic}`;
      if (!topicPercentages.has(key)) topicPercentages.set(key, []);
      topicPercentages.get(key).push(pct);
    }
  });

  const mostMissedTopics = [...topicPercentages.entries()]
    .map(([key, pcts]) => {
      const [subjectIdStr, subTopicIdStr] = key.split("|");
      const subjectMeta = subjectById.get(subjectIdStr);
      const subtopicMeta = subjectMeta
        ? (subjectMeta.subtopics || []).find((st) => st._id.toString() === subTopicIdStr)
        : null;
      return {
        subjectName: subjectMeta?.name || "—",
        subTopicName: subtopicMeta?.name || "—",
        avgPercentage: round1(avg(pcts)),
        attempts: pcts.length,
      };
    })
    .sort((a, b) => a.avgPercentage - b.avgPercentage)
    .slice(0, 10);

  // ---- Engagement-to-Performance correlation ----
  // Observational only, and labeled as such on the frontend: do students
  // who've actually watched a recorded class or opened a study material in
  // the last ENGAGEMENT_WINDOW_DAYS score better, on the very same
  // submissions already fetched above, than students who haven't? This
  // never claims a video/attachment CAUSED the difference — engagement and
  // performance could both just track how generally active a student is.
  const categoryStudents = await User.find({ role: "student", category })
    .select("_id")
    .lean();
  const categoryStudentIds = categoryStudents.map((s) => s._id);

  const engagementCutoff = new Date(Date.now() - ENGAGEMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [engagedByVideo, engagedByAttachment] = await Promise.all([
    VideoProgress.distinct("userId", {
      userId: { $in: categoryStudentIds },
      lastWatchedAt: { $gte: engagementCutoff },
    }),
    AttachmentProgress.distinct("userId", {
      userId: { $in: categoryStudentIds },
      lastViewedAt: { $gte: engagementCutoff },
    }),
  ]);
  const engagedIdSet = new Set(
    [...engagedByVideo, ...engagedByAttachment].map((id) => id.toString())
  );

  const engagedPercentages = [];
  const notEngagedPercentages = [];
  submissions.forEach((sub, i) => {
    const sid = sub.userId?.toString();
    if (!sid) return;
    (engagedIdSet.has(sid) ? engagedPercentages : notEngagedPercentages).push(percentages[i]);
  });

  const engagement = {
    windowDays: ENGAGEMENT_WINDOW_DAYS,
    engagedStudents: engagedIdSet.size,
    notEngagedStudents: Math.max(0, categoryStudentIds.length - engagedIdSet.size),
    engagedAvgScore: round1(avg(engagedPercentages)),
    notEngagedAvgScore: round1(avg(notEngagedPercentages)),
    engagedAttempts: engagedPercentages.length,
    notEngagedAttempts: notEngagedPercentages.length,
  };

  return {
    category,
    categoryLabel: EXAM_CATEGORY_LABELS[category] || category,
    hasData: true,
    totalAttempts: submissions.length,
    distinctStudents: studentIds.size,
    passRate:
      passFlags.length > 0
        ? round1((passFlags.filter(Boolean).length / passFlags.length) * 100)
        : null,
    avgPercentage: round1(avg(percentages)),
    avgSpeed: round1(avg(speeds)),
    avgAccuracy: round1(avg(accuracies)),
    mostMissedTopics,
    engagement,
  };
};

module.exports = {
  computeCategoryPerformance,
  computeCategoryLeaderboards,
  computeStudentAttemptHistory,
  computeCategoryRollup,
};
