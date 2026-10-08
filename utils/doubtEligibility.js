// Who may use "Ask a doubt" (2026-10-08): only regular students.
//   - admin override on the student: "allow" -> always, "block" -> never;
//   - otherwise ("auto"), in the last DOUBT_WINDOW_DAYS (30) days the
//     student must have:
//       * completed at least DOUBT_MIN_TESTS (4) different tests — or every
//         test posted in that period, if fewer were posted; and
//       * watched DOUBT_MIN_CLASS_PERCENT (60%) of the
//         classes (recorded + live) of their category in that period
//         ("watched" = 50%+ of the class).
// All three numbers can be changed with Railway variables of those names.
const mongoose = require("mongoose");
const ExamSubmission = require("../models/examSubmissionSchema");
const Exam = require("../models/examModel");
const Subject = require("../models/subjectModel");
const RecordedClass = require("../models/recordedClassModel");
const LiveClass = require("../models/liveClassModel");
const VideoProgress = require("../models/videoProgressModel");
const LiveAttendance = require("../models/liveAttendanceModel");
const { recordedWatchStats, liveWatchStats } = require("./watchTime");
const { loadManualRecordingLengths, liveSessionLength } = require("./liveSession");

const WINDOW_DAYS = parseInt(process.env.DOUBT_WINDOW_DAYS, 10) || 30;
const MIN_TESTS = parseInt(process.env.DOUBT_MIN_TESTS, 10) || 4;
const MIN_CLASS_PERCENT = parseFloat(process.env.DOUBT_MIN_CLASS_PERCENT) || 60;
const WATCHED_THRESHOLD = 50;

const getDoubtEligibility = async (user) => {
  const base = { eligible: false, override: user?.doubtAccess || "auto", rules: { WINDOW_DAYS, MIN_TESTS, MIN_CLASS_PERCENT } };
  if (!user || user.role !== "student") return { ...base, reason: "Doubts are for students." };
  if (user.accountType === "free_trial") {
    return { ...base, reason: "Ask-a-doubt is available to enrolled students of the academy." };
  }
  if (user.doubtAccess === "allow") return { ...base, eligible: true, reason: "Enabled by the academy." };
  if (user.doubtAccess === "block") return { ...base, reason: "Ask-a-doubt is not enabled for your account. Contact the academy." };

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000);
  const category = user.category;

  // Tests
  const subjects = category ? await Subject.find({ category }).select("_id").lean() : [];
  const subjectIds = subjects.map((s) => s._id);
  const [attemptedExamIds, testsPosted] = await Promise.all([
    ExamSubmission.distinct("examId", { userId: user._id, status: "completed", completedAt: { $gte: since } }),
    subjectIds.length
      ? Exam.countDocuments({
          subject: { $in: subjectIds },
          status: "active",
          $or: [{ publishedAt: { $gte: since } }, { publishedAt: null, createdAt: { $gte: since } }],
        })
      : 0,
  ]);
  const testsAttempted = attemptedExamIds.length;
  const testsRequired = Math.min(MIN_TESTS, testsPosted);

  // Classes
  const [recorded, live] = category
    ? await Promise.all([
        RecordedClass.find({ category, active: true, recordedDate: { $gte: since } }).select("_id durationSeconds").lean(),
        LiveClass.find({ category, startedAt: { $gte: since } }).select("_id category youtubeVideoId startedAt endedAt durationSeconds").lean(),
      ])
    : [[], []];
  const [videoRows, liveRows, manualLengths] = await Promise.all([
    recorded.length ? VideoProgress.find({ userId: user._id, videoId: { $in: recorded.map((r) => r._id) } }).lean() : [],
    live.length ? LiveAttendance.find({ userId: user._id, liveClassId: { $in: live.map((l) => l._id) } }).lean() : [],
    loadManualRecordingLengths(live),
  ]);
  const videoById = new Map(videoRows.map((r) => [String(r.videoId), r]));
  const liveById = new Map(liveRows.map((r) => [String(r.liveClassId), r]));
  let classesWatched = 0;
  for (const r of recorded) {
    if (recordedWatchStats(videoById.get(String(r._id)), r.durationSeconds || 0).percentWatched >= WATCHED_THRESHOLD) classesWatched++;
  }
  for (const l of live) {
    if (liveWatchStats(liveById.get(String(l._id)), liveSessionLength(l, manualLengths).seconds).percentWatched >= WATCHED_THRESHOLD) classesWatched++;
  }
  const classesTotal = recorded.length + live.length;
  const classPercent = classesTotal ? Math.round((classesWatched / classesTotal) * 100) : 100;

  const testsOk = testsAttempted >= testsRequired;
  const classesOk = classPercent >= MIN_CLASS_PERCENT;
  const stats = { testsAttempted, testsRequired, classesWatched, classesTotal, classPercent };
  if (testsOk && classesOk) return { ...base, eligible: true, stats, reason: "You are a regular student." };
  const parts = [];
  if (!testsOk) parts.push(`attempt ${testsRequired - testsAttempted} more test(s)`);
  if (!classesOk) parts.push(`watch at least ${MIN_CLASS_PERCENT}% of classes (now ${classPercent}%)`);
  return {
    ...base,
    stats,
    reason: `Ask-a-doubt unlocks for regular students. In the last ${WINDOW_DAYS} days, ${parts.join(" and ")}.`,
  };
};

module.exports = { getDoubtEligibility };
