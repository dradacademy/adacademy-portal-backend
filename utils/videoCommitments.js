// Pending Videos popup + admin Video Tracker (2026-10-28) — the one place
// that decides, for each student and each recorded class:
//   - watch state: complete / partial / not_started  (complete = the same
//     75% "Present" rule used by attendance and Student Progress — see
//     utils/attendanceHelper.js — so every screen agrees)
//   - promise status (from models/videoCommitmentModel.js):
//       done_on_time — finished on or before the date they promised
//       done_late    — finished, but after the promised date
//       done         — finished without ever needing a date
//       upcoming     — not finished, promised date still ahead
//       missed       — not finished, promised date has passed
//       no_date      — not finished, no date promised yet
//       self_reported — the student says they watched it on YouTube
//       admin_marked  — the admin marked it as watched
//     (the last two count as finished; see models/videoWatchOverrideModel.js)
//
// Which videos count ("tracked"): recorded classes students can see right
// now (active + inside their availability window) in the student's
// category, AND with a duration filled in (without a duration the watch %
// can't be worked out, so such a video could never become "complete" and
// would trap the student in the popup forever — these are reported to the
// admin as "videos without duration" instead).
//
// Which students count: role student, not a free-test account, with an
// active enrollment for their category that includes recordings (Test
// Series Only students can't open videos, so they're never asked).

const RecordedClass = require("../models/recordedClassModel");
const VideoProgress = require("../models/videoProgressModel");
const VideoCommitment = require("../models/videoCommitmentModel");
const VideoCommitmentConfig = require("../models/videoCommitmentConfigModel");
const VideoWatchOverride = require("../models/videoWatchOverrideModel");
const enrollmentModel = require("../models/enrollmentModel");
const { isEnrollmentActive } = require("../models/enrollmentModel");
const { recordedWatchStats } = require("./watchTime");
const { isVideoComplete } = require("./attendanceHelper");
const {
  DAY_MS,
  isAvailableToStudents,
  getAvailableUntil,
  endOfIstDayFromYmd,
} = require("./classAvailability");
const { loadSubjectLookup, describeGrouping } = require("./recordedClassGrouping");

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// "YYYY-MM-DD" of the IST calendar day containing `value`.
const istYmd = (value = Date.now()) =>
  new Date(new Date(value).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

const addDaysYmd = (ymd, days) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const getCommitmentConfig = async () => {
  const config = await VideoCommitmentConfig.findByIdAndUpdate(
    "video-commitment-config",
    {},
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return config;
};

const VIDEO_FIELDS =
  "_id title category subject subtopic subtopicName recordedDate durationSeconds visibilityWindowDays availableUntil active";

// Loads everything needed for these students in a fixed number of queries
// (never one query per student).
// Returns {
//   perStudent: Map<sid, { tracked, reason, items: [...] }>,
//   videosByCategory: Map<category, [lean video]>,
//   noDurationByCategory: Map<category, [lean video]>,
//   subjectLookup,
// }
const loadTracking = async (students, { now = Date.now() } = {}) => {
  const perStudent = new Map();
  const videosByCategory = new Map();
  const noDurationByCategory = new Map();
  if (!students.length) {
    return { perStudent, videosByCategory, noDurationByCategory, subjectLookup: new Map() };
  }

  const studentIds = students.map((s) => s._id);
  const categories = [...new Set(students.map((s) => s.category).filter(Boolean))];

  const [videos, enrollments] = await Promise.all([
    categories.length
      ? RecordedClass.find({ category: { $in: categories }, active: true })
          .select(VIDEO_FIELDS)
          .sort({ recordedDate: 1 })
          .lean()
      : [],
    enrollmentModel
      .find({ userId: { $in: studentIds } })
      .select("userId category validTill revoked accessLevel")
      .lean(),
  ]);

  const visible = videos.filter((v) => isAvailableToStudents(v, now));
  categories.forEach((c) => {
    videosByCategory.set(c, visible.filter((v) => v.category === c && v.durationSeconds > 0));
    noDurationByCategory.set(c, visible.filter((v) => v.category === c && !(v.durationSeconds > 0)));
  });
  const trackedVideoIds = visible.filter((v) => v.durationSeconds > 0).map((v) => v._id);

  const [progressRows, commitmentRows, overrideRows, subjectLookup] = await Promise.all([
    trackedVideoIds.length
      ? VideoProgress.find({ userId: { $in: studentIds }, videoId: { $in: trackedVideoIds } })
          .select("userId videoId totalWatchSeconds trackingVersion legacyWatchSeconds watchedRanges lastWatchedAt")
          .lean()
      : [],
    trackedVideoIds.length
      ? VideoCommitment.find({ userId: { $in: studentIds }, videoId: { $in: trackedVideoIds } }).lean()
      : [],
    trackedVideoIds.length
      ? VideoWatchOverride.find({ userId: { $in: studentIds }, videoId: { $in: trackedVideoIds } }).lean()
      : [],
    loadSubjectLookup(visible),
  ]);

  const key = (u, v) => `${u}:${v}`;
  const progressMap = new Map(progressRows.map((r) => [key(r.userId, r.videoId), r]));
  const commitMap = new Map(commitmentRows.map((r) => [key(r.userId, r.videoId), r]));
  const overrideMap = new Map(overrideRows.map((r) => [key(r.userId, r.videoId), r]));
  const enrollMap = new Map(enrollments.map((e) => [key(e.userId, e.category), e]));

  for (const student of students) {
    const sid = String(student._id);
    if (!student.category) {
      perStudent.set(sid, { tracked: false, reason: "No course category", items: [] });
      continue;
    }
    const enrollment = enrollMap.get(key(sid, student.category));
    if (!isEnrollmentActive(enrollment)) {
      perStudent.set(sid, { tracked: false, reason: "No active enrollment", items: [] });
      continue;
    }
    if (enrollment.accessLevel === "test_series_only") {
      perStudent.set(sid, { tracked: false, reason: "Test Series Only", items: [] });
      continue;
    }

    const items = (videosByCategory.get(student.category) || []).map((video) => {
      const vid = String(video._id);
      const progress = progressMap.get(key(sid, vid)) || null;
      const commitment = commitMap.get(key(sid, vid)) || null;
      const override = overrideMap.get(key(sid, vid)) || null;
      const { percentWatched } = recordedWatchStats(progress, video.durationSeconds);
      const measuredComplete = isVideoComplete(percentWatched);
      // Marked watched (student's word or admin) counts as finished.
      const complete = measuredComplete || !!override;
      const watchState = complete ? "complete" : percentWatched > 0 ? "partial" : "not_started";

      let status;
      if (!measuredComplete && override) {
        status = override.source === "admin" ? "admin_marked" : "self_reported";
      } else if (complete) {
        if (!commitment) status = "done";
        else {
          const finishedAt = commitment.completedAt || progress?.lastWatchedAt || now;
          status = new Date(finishedAt).getTime() <= new Date(commitment.targetDate).getTime()
            ? "done_on_time"
            : "done_late";
        }
      } else if (!commitment) status = "no_date";
      else if (new Date(commitment.targetDate).getTime() < now) status = "missed";
      else status = "upcoming";

      return {
        video,
        percentWatched,
        watchState,
        status,
        commitment,
        override,
        measuredComplete,
        lastWatchedAt: progress?.lastWatchedAt || null,
      };
    });

    perStudent.set(sid, { tracked: true, reason: null, items });
  }

  return { perStudent, videosByCategory, noDurationByCategory, subjectLookup };
};

// Latest date a student may pick for this video: the earlier of
// (today + maxDaysAhead) and the video's last available day.
const maxDateFor = (video, todayYmd, maxDaysAhead) => {
  const cap = addDaysYmd(todayYmd, maxDaysAhead);
  const until = getAvailableUntil(video);
  if (!until) return cap;
  const untilYmd = istYmd(until);
  return untilYmd < cap ? untilYmd : cap;
};

const PENDING_STATUSES = new Set(["no_date", "missed", "upcoming"]);

const summarizeItems = (items) => {
  const out = {
    total: items.length,
    done: 0,
    partial: 0,
    notStarted: 0,
    pending: 0,
    noDate: 0,
    upcoming: 0,
    missed: 0,
    doneOnTime: 0,
    doneLate: 0,
    selfReported: 0,
    adminMarked: 0,
    datesMissedEver: 0,
    dateChanges: 0,
    nextDate: null,
    lastWatchedAt: null,
  };
  for (const it of items) {
    if (it.watchState === "complete") out.done += 1;
    else if (it.watchState === "partial") out.partial += 1;
    else out.notStarted += 1;
    if (PENDING_STATUSES.has(it.status)) out.pending += 1;
    if (it.status === "no_date") out.noDate += 1;
    if (it.status === "upcoming") {
      out.upcoming += 1;
      const t = new Date(it.commitment.targetDate);
      if (!out.nextDate || t < out.nextDate) out.nextDate = t;
    }
    if (it.status === "missed") out.missed += 1;
    if (it.status === "done_on_time") out.doneOnTime += 1;
    if (it.status === "done_late") out.doneLate += 1;
    if (it.status === "self_reported") out.selfReported += 1;
    if (it.status === "admin_marked") out.adminMarked += 1;
    if (it.commitment) {
      out.datesMissedEver += it.commitment.missedCount || 0;
      out.dateChanges += it.commitment.changeCount || 0;
    }
    if (it.lastWatchedAt && (!out.lastWatchedAt || it.lastWatchedAt > out.lastWatchedAt)) {
      out.lastWatchedAt = it.lastWatchedAt;
    }
  }
  // Currently-overdue promises count as missed too.
  out.datesMissedEver += out.missed;
  return out;
};

// Overall verdict for one student, worst first.
const studentVerdict = (s) => {
  if (s.total === 0) return "no_videos";
  if (s.pending === 0) return "all_done";
  if (s.missed > 0) return "missed";
  if (s.noDate > 0) return "no_date";
  return "on_track";
};

module.exports = {
  DAY_MS,
  istYmd,
  addDaysYmd,
  endOfIstDayFromYmd,
  getCommitmentConfig,
  loadTracking,
  maxDateFor,
  summarizeItems,
  studentVerdict,
  describeGrouping,
  PENDING_STATUSES,
};
