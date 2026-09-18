const Subject = require("../models/subjectModel");
const Exam = require("../models/examModel");
const ExamSubmission = require("../models/examSubmissionSchema");
const RecordedClass = require("../models/recordedClassModel");
const VideoProgress = require("../models/videoProgressModel");
const Attachment = require("../models/attachmentModel");
const AttachmentProgress = require("../models/attachmentProgressModel");
const progressWeightConfigModel = require("../models/progressWeightConfigModel");
const { isVideoComplete } = require("./attendanceHelper");

const DEFAULT_WEIGHTS = { examWeight: 40, videoWeight: 40, attachmentWeight: 20 };

// Singleton config accessor (same upsert-on-read pattern as
// markController.js's ensureMarkConfigExists) — never throws "not found",
// always returns a usable weight config.
const getWeightConfig = async () => {
  let config = await progressWeightConfigModel.findById("progress-weight-config");
  if (!config) {
    config = await progressWeightConfigModel.findByIdAndUpdate(
      "progress-weight-config",
      {},
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }
  return config;
};

// Same "still visible to students" rule as recordedClassModel.js's
// isVisibleToStudents() instance method, reimplemented here in plain JS
// because this helper works over .lean() documents (no schema methods).
const isVideoVisible = (video) => {
  if (!video.active) return false;
  if (video.visibilityWindowDays === null || video.visibilityWindowDays === undefined) {
    return true;
  }
  const cutoff =
    new Date(video.recordedDate).getTime() + video.visibilityWindowDays * 24 * 60 * 60 * 1000;
  return Date.now() <= cutoff;
};

// Computes learning-progress figures for a batch of students in bulk
// (never one query per student — see the rank-computation N+1 bug already
// fixed once in this project's history under dashboardController.js).
// `students` is an array of lean User docs carrying at least _id/category.
//
// Returns a Map<studentIdString, {
//   exams: { completed, total, percent, list },
//   videos: { completed, total, percent, list },
//   attachments: { completed, total, percent, list },
//   overallProgress,
// }>
//
// This is the SINGLE SOURCE OF TRUTH for every "X/Y exams" / "X/Y videos" /
// "X/Y attachments" / "Overall Progress %" figure shown anywhere in the
// app (the admin list dashboard, the admin per-student detail view, and the
// student's own "My Progress" page all call this exact function) — so the
// numbers can never drift out of sync between those three surfaces, the
// same discipline already established for attendance verdicts in
// attendanceHelper.js.
const computeStudentProgress = async (students) => {
  const results = new Map();
  if (!students || students.length === 0) return results;

  const weightConfig = await getWeightConfig();
  const totalWeight =
    (weightConfig.examWeight || 0) +
    (weightConfig.videoWeight || 0) +
    (weightConfig.attachmentWeight || 0) || 1;

  const studentIds = students.map((s) => s._id);
  const categories = [...new Set(students.map((s) => s.category).filter(Boolean))];

  if (categories.length === 0) {
    // No categorized students in this batch — every count is trivially 0/0.
    students.forEach((s) => {
      results.set(s._id.toString(), {
        exams: { completed: 0, total: 0, percent: 0, list: [] },
        videos: { completed: 0, total: 0, percent: 0, list: [] },
        attachments: { completed: 0, total: 0, percent: 0, list: [] },
        overallProgress: 0,
      });
    });
    return results;
  }

  const [subjects, recordedClasses, attachments] = await Promise.all([
    Subject.find({ category: { $in: categories } }).select("_id category").lean(),
    RecordedClass.find({ category: { $in: categories } })
      .select("_id title category durationSeconds visibilityWindowDays recordedDate active")
      .lean(),
    Attachment.find({ category: { $in: categories }, active: true })
      .select("_id title category")
      .lean(),
  ]);

  const subjectIdsByCategory = new Map();
  categories.forEach((c) =>
    subjectIdsByCategory.set(
      c,
      subjects.filter((s) => s.category === c).map((s) => s._id)
    )
  );

  const examsByCategory = new Map();
  await Promise.all(
    categories.map(async (c) => {
      const subjectIds = subjectIdsByCategory.get(c) || [];
      const exams = subjectIds.length
        ? await Exam.find({ subject: { $in: subjectIds }, status: "active" })
            .select("_id examCode")
            .lean()
        : [];
      examsByCategory.set(c, exams);
    })
  );
  const allActiveExamIds = [...examsByCategory.values()].flat().map((e) => e._id);

  const visibleVideos = recordedClasses.filter(isVideoVisible);
  const videosByCategory = new Map();
  categories.forEach((c) =>
    videosByCategory.set(c, visibleVideos.filter((v) => v.category === c))
  );

  const attachmentsByCategory = new Map();
  categories.forEach((c) =>
    attachmentsByCategory.set(c, attachments.filter((a) => a.category === c))
  );

  const [examSubmissions, videoProgressRows, attachmentProgressRows] = await Promise.all([
    allActiveExamIds.length
      ? ExamSubmission.find({
          userId: { $in: studentIds },
          examId: { $in: allActiveExamIds },
          status: "completed",
        })
          .select("userId examId obtainedMark completedAt attemptNumber")
          .sort({ attemptNumber: 1 })
          .lean()
      : [],
    VideoProgress.find({ userId: { $in: studentIds } }).lean(),
    AttachmentProgress.find({ userId: { $in: studentIds } }).lean(),
  ]);

  const examSubsByUser = new Map();
  examSubmissions.forEach((sub) => {
    const key = sub.userId.toString();
    if (!examSubsByUser.has(key)) examSubsByUser.set(key, new Map());
    const byExam = examSubsByUser.get(key);
    const examKey = sub.examId.toString();
    if (!byExam.has(examKey)) byExam.set(examKey, []);
    byExam.get(examKey).push(sub);
  });

  const videoProgressByUser = new Map();
  videoProgressRows.forEach((row) => {
    const key = row.userId.toString();
    if (!videoProgressByUser.has(key)) videoProgressByUser.set(key, new Map());
    videoProgressByUser.get(key).set(row.videoId.toString(), row);
  });

  const attachProgressByUser = new Map();
  attachmentProgressRows.forEach((row) => {
    const key = row.userId.toString();
    if (!attachProgressByUser.has(key)) attachProgressByUser.set(key, new Map());
    attachProgressByUser.get(key).set(row.attachmentId.toString(), row);
  });

  for (const student of students) {
    const sid = student._id.toString();
    const category = student.category;

    const categoryExams = examsByCategory.get(category) || [];
    const studentExamSubs = examSubsByUser.get(sid) || new Map();
    const examList = categoryExams.map((exam) => {
      const subs = studentExamSubs.get(exam._id.toString()) || [];
      const completed = subs.length > 0;
      return {
        examId: exam._id,
        examCode: exam.examCode,
        completed,
        attemptsCount: subs.length,
        bestMark: completed ? Math.max(...subs.map((s) => s.obtainedMark || 0)) : null,
        lastAttemptAt: completed ? subs[subs.length - 1].completedAt : null,
      };
    });
    const completedExams = examList.filter((e) => e.completed).length;
    const totalExams = examList.length;

    const categoryVideos = videosByCategory.get(category) || [];
    const studentVideoRows = videoProgressByUser.get(sid) || new Map();
    const videoList = categoryVideos.map((video) => {
      const row = studentVideoRows.get(video._id.toString());
      const durationSeconds = video.durationSeconds || 0;
      const totalWatchSeconds = row?.totalWatchSeconds || 0;
      const percentWatched = durationSeconds
        ? Math.min(100, (totalWatchSeconds / durationSeconds) * 100)
        : 0;
      return {
        videoId: video._id,
        title: video.title,
        percentWatched: Number(percentWatched.toFixed(1)),
        completed: isVideoComplete(percentWatched),
        lastWatchedAt: row?.lastWatchedAt || null,
      };
    });
    const completedVideos = videoList.filter((v) => v.completed).length;
    const totalVideos = videoList.length;

    const categoryAttachments = attachmentsByCategory.get(category) || [];
    const studentAttachRows = attachProgressByUser.get(sid) || new Map();
    const attachmentList = categoryAttachments.map((att) => {
      const row = studentAttachRows.get(att._id.toString());
      const viewed = !!row && row.viewCount > 0;
      return {
        attachmentId: att._id,
        title: att.title,
        viewed,
        lastViewedAt: row?.lastViewedAt || null,
      };
    });
    const completedAttachments = attachmentList.filter((a) => a.viewed).length;
    const totalAttachments = attachmentList.length;

    const examPct = totalExams ? (completedExams / totalExams) * 100 : 0;
    const videoPct = totalVideos ? (completedVideos / totalVideos) * 100 : 0;
    const attachPct = totalAttachments ? (completedAttachments / totalAttachments) * 100 : 0;

    const overallProgress =
      (examPct * (weightConfig.examWeight || 0) +
        videoPct * (weightConfig.videoWeight || 0) +
        attachPct * (weightConfig.attachmentWeight || 0)) /
      totalWeight;

    results.set(sid, {
      exams: {
        completed: completedExams,
        total: totalExams,
        percent: Number(examPct.toFixed(1)),
        list: examList,
      },
      videos: {
        completed: completedVideos,
        total: totalVideos,
        percent: Number(videoPct.toFixed(1)),
        list: videoList,
      },
      attachments: {
        completed: completedAttachments,
        total: totalAttachments,
        percent: Number(attachPct.toFixed(1)),
        list: attachmentList,
      },
      overallProgress: Number(overallProgress.toFixed(1)),
    });
  }

  return results;
};

module.exports = { computeStudentProgress, getWeightConfig, DEFAULT_WEIGHTS };
