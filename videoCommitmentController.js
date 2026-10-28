const mongoose = require("mongoose");
const userModel = require("../models/userModel");
const VideoCommitment = require("../models/videoCommitmentModel");
const {
  istYmd,
  endOfIstDayFromYmd,
  getCommitmentConfig,
  loadTracking,
  maxDateFor,
  summarizeItems,
  studentVerdict,
  describeGrouping,
  PENDING_STATUSES,
} = require("../utils/videoCommitments");

const STUDENT_FIELDS = "username email registerNumber category batch isDisabled lastLoginAt";

// What the student's popup shows: every pending (unfinished) video with the
// date promised so far and the latest date allowed.
const buildMyPending = async (user, config) => {
  const { perStudent, subjectLookup } = await loadTracking([user]);
  const entry = perStudent.get(String(user._id));
  if (!entry || !entry.tracked) return { tracked: false, items: [] };

  const today = istYmd();
  const items = entry.items
    .filter((it) => PENDING_STATUSES.has(it.status))
    .map((it) => {
      const grouping = describeGrouping(it.video, subjectLookup);
      return {
        videoId: it.video._id,
        title: it.video.title,
        subject: grouping.subject?.name || null,
        subtopic: grouping.subtopic?.name || null,
        recordedDate: it.video.recordedDate,
        durationSeconds: it.video.durationSeconds,
        percentWatched: it.percentWatched,
        watchState: it.watchState,
        status: it.status,
        targetDate: it.commitment ? istYmd(it.commitment.targetDate) : null,
        missedCount: it.commitment?.missedCount || 0,
        minDate: today,
        maxDate: maxDateFor(it.video, today, config.maxDaysAhead),
      };
    })
    // Most urgent first: missed, then no date, then upcoming by date.
    .sort((a, b) => {
      const rank = { missed: 0, no_date: 1, upcoming: 2 };
      if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
      return String(a.targetDate || a.maxDate).localeCompare(String(b.targetDate || b.maxDate));
    });

  return { tracked: true, items };
};

// GET /api/video-commitments/me (student)
const getMyPending = async (req, res) => {
  try {
    const config = await getCommitmentConfig();
    if (req.user.role !== "student" || req.user.accountType === "free_trial" || !config.popupEnabled) {
      return res.status(200).json({ success: true, data: { enabled: false, items: [], needsDates: false } });
    }
    const { items } = await buildMyPending(req.user, config);
    res.status(200).json({
      success: true,
      data: {
        enabled: true,
        today: istYmd(),
        items,
        needsDates: items.some((it) => it.status === "no_date" || it.status === "missed"),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to load pending videos.", error: error.message });
  }
};

// POST /api/video-commitments/me (student) — body { items: [{ videoId, date: "YYYY-MM-DD" }] }
const saveMyDates = async (req, res) => {
  try {
    const config = await getCommitmentConfig();
    const input = Array.isArray(req.body?.items) ? req.body.items.slice(0, 500) : [];
    if (input.length === 0) {
      return res.status(400).json({ success: false, message: "Pick a date for your pending videos." });
    }

    const { items } = await buildMyPending(req.user, config);
    const pendingById = new Map(items.map((it) => [String(it.videoId), it]));

    const errors = [];
    const valid = [];
    for (const row of input) {
      const item = pendingById.get(String(row?.videoId));
      if (!item) continue; // finished meanwhile, or not theirs — just skip
      const date = String(row?.date || "").trim();
      const end = endOfIstDayFromYmd(date);
      if (!end) {
        errors.push(`Pick a valid date for "${item.title}".`);
      } else if (date < item.minDate) {
        errors.push(`"${item.title}": the date can't be in the past.`);
      } else if (date > item.maxDate) {
        errors.push(`"${item.title}": pick a date on or before ${item.maxDate}.`);
      } else {
        valid.push({ item, end });
      }
    }
    if (errors.length) {
      return res.status(400).json({ success: false, message: errors[0], errors });
    }

    const existing = await VideoCommitment.find({
      userId: req.user._id,
      videoId: { $in: valid.map((v) => v.item.videoId) },
    });
    const existingById = new Map(existing.map((c) => [String(c.videoId), c]));
    const now = new Date();

    for (const { item, end } of valid) {
      const current = existingById.get(String(item.videoId));
      if (!current) {
        try {
          await VideoCommitment.create({
            userId: req.user._id,
            videoId: item.videoId,
            targetDate: end,
            firstTargetDate: end,
            setAt: now,
          });
        } catch (err) {
          if (err?.code !== 11000) throw err; // double-submit: row already made
        }
        continue;
      }
      if (current.targetDate.getTime() === end.getTime()) continue;
      const wasMissed = current.targetDate.getTime() < now.getTime();
      current.history.push({ targetDate: current.targetDate, setAt: current.setAt, missed: wasMissed });
      if (current.history.length > 50) current.history = current.history.slice(-50);
      if (wasMissed) current.missedCount += 1;
      current.changeCount += 1;
      current.targetDate = end;
      current.setAt = now;
      await current.save();
    }

    const fresh = await buildMyPending(req.user, config);
    res.status(200).json({
      success: true,
      message: "Dates saved.",
      data: {
        enabled: true,
        today: istYmd(),
        items: fresh.items,
        needsDates: fresh.items.some((it) => it.status === "no_date" || it.status === "missed"),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to save dates.", error: error.message });
  }
};

// GET /api/video-commitments/admin?category=&batch=&search=&includeInactive=
// The whole Video Tracker in one response: summary cards, one row per
// student, one row per video.
const getTracker = async (req, res) => {
  try {
    const { category, batch, search, includeInactive } = req.query;
    const config = await getCommitmentConfig();

    const base = { role: "student", accountType: { $ne: "free_trial" } };
    const match = { ...base };
    if (includeInactive !== "true") match.isDisabled = { $ne: true };
    if (category) match.category = category;
    if (batch === "__none__") match.batch = { $in: ["", null] };
    else if (batch) match.batch = batch;
    if (search && search.trim()) {
      const safe = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(safe, "i");
      match.$or = [{ username: regex }, { email: regex }, { registerNumber: regex }];
    }

    const [students, batchValues] = await Promise.all([
      userModel.find(match).select(STUDENT_FIELDS).lean(),
      userModel.distinct("batch", base),
    ]);

    const { perStudent, videosByCategory, noDurationByCategory, subjectLookup } =
      await loadTracking(students);

    const studentRows = [];
    const notTracked = [];
    const videoAgg = new Map();

    for (const s of students) {
      const entry = perStudent.get(String(s._id));
      if (!entry || !entry.tracked) {
        notTracked.push({ studentId: s._id, name: s.username, reason: entry?.reason || "Not tracked" });
        continue;
      }
      const sum = summarizeItems(entry.items);
      studentRows.push({
        studentId: s._id,
        name: s.username,
        email: s.email,
        registerNumber: s.registerNumber || null,
        category: s.category,
        batch: s.batch || "",
        lastLoginAt: s.lastLoginAt || null,
        ...sum,
        donePercent: sum.total ? Math.round((sum.done / sum.total) * 100) : 0,
        verdict: studentVerdict(sum),
      });

      for (const it of entry.items) {
        const vid = String(it.video._id);
        if (!videoAgg.has(vid)) {
          videoAgg.set(vid, {
            students: 0, done: 0, partial: 0, notStarted: 0,
            noDate: 0, upcoming: 0, missed: 0, doneOnTime: 0, doneLate: 0,
            pendingStudents: [],
          });
        }
        const agg = videoAgg.get(vid);
        agg.students += 1;
        if (it.watchState === "complete") agg.done += 1;
        else if (it.watchState === "partial") agg.partial += 1;
        else agg.notStarted += 1;
        if (it.status === "no_date") agg.noDate += 1;
        if (it.status === "upcoming") agg.upcoming += 1;
        if (it.status === "missed") agg.missed += 1;
        if (it.status === "done_on_time") agg.doneOnTime += 1;
        if (it.status === "done_late") agg.doneLate += 1;
        if (PENDING_STATUSES.has(it.status)) {
          agg.pendingStudents.push({
            studentId: s._id,
            name: s.username,
            batch: s.batch || "",
            percentWatched: it.percentWatched,
            status: it.status,
            targetDate: it.commitment ? istYmd(it.commitment.targetDate) : null,
          });
        }
      }
    }

    const videoRows = [];
    for (const [cat, list] of videosByCategory) {
      if (category && cat !== category) continue;
      for (const video of list) {
        const agg = videoAgg.get(String(video._id));
        if (!agg) continue; // no tracked student in this filter
        const grouping = describeGrouping(video, subjectLookup);
        videoRows.push({
          videoId: video._id,
          title: video.title,
          category: video.category,
          subject: grouping.subject?.name || null,
          subtopic: grouping.subtopic?.name || null,
          recordedDate: video.recordedDate,
          ...agg,
          donePercent: agg.students ? Math.round((agg.done / agg.students) * 100) : 0,
        });
      }
    }
    videoRows.sort((a, b) => new Date(b.recordedDate) - new Date(a.recordedDate));

    const noDuration = [];
    for (const [cat, list] of noDurationByCategory) {
      if (category && cat !== category) continue;
      list.forEach((v) => noDuration.push({ videoId: v._id, title: v.title, category: v.category }));
    }

    const count = (fn) => studentRows.filter(fn).length;
    const total = (field) => studentRows.reduce((n, r) => n + (r[field] || 0), 0);
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const summary = {
      studentsTracked: studentRows.length,
      studentsNotTracked: notTracked.length,
      allDone: count((r) => r.verdict === "all_done"),
      onTrack: count((r) => r.verdict === "on_track"),
      missedDate: count((r) => r.verdict === "missed"),
      noDateYet: count((r) => r.verdict === "no_date"),
      notWatching7Days: count(
        (r) => r.pending > 0 && (!r.lastWatchedAt || new Date(r.lastWatchedAt).getTime() < weekAgo)
      ),
      pendingVideos: total("pending"),
      notStartedVideos: total("notStarted"),
      partialVideos: total("partial"),
      doneOnTime: total("doneOnTime"),
      doneLate: total("doneLate"),
      missedNow: total("missed"),
      videosTracked: videoRows.length,
      videosWithoutDuration: noDuration.length,
    };

    studentRows.sort((a, b) => b.missed - a.missed || b.pending - a.pending || a.name.localeCompare(b.name));

    res.status(200).json({
      success: true,
      data: {
        summary,
        students: studentRows,
        videos: videoRows,
        notTracked,
        noDuration,
        batches: batchValues.filter(Boolean).sort(),
        settings: { popupEnabled: config.popupEnabled, maxDaysAhead: config.maxDaysAhead },
        generatedAt: new Date(),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to load the video tracker.", error: error.message });
  }
};

// GET /api/video-commitments/admin/student/:studentId — every tracked
// video for one student with the promise history.
const getStudentDetail = async (req, res) => {
  try {
    const { studentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({ success: false, message: "Unknown student." });
    }
    const student = await userModel.findById(studentId).select(STUDENT_FIELDS).lean();
    if (!student) return res.status(404).json({ success: false, message: "Student not found." });

    const { perStudent, subjectLookup } = await loadTracking([student]);
    const entry = perStudent.get(String(student._id));
    const items = (entry?.items || []).map((it) => {
      const grouping = describeGrouping(it.video, subjectLookup);
      const c = it.commitment;
      return {
        videoId: it.video._id,
        title: it.video.title,
        subject: grouping.subject?.name || null,
        subtopic: grouping.subtopic?.name || null,
        recordedDate: it.video.recordedDate,
        percentWatched: it.percentWatched,
        watchState: it.watchState,
        status: it.status,
        lastWatchedAt: it.lastWatchedAt,
        targetDate: c ? istYmd(c.targetDate) : null,
        firstTargetDate: c ? istYmd(c.firstTargetDate) : null,
        changeCount: c?.changeCount || 0,
        missedCount: c?.missedCount || 0,
        completedAt: c?.completedAt || null,
        history: (c?.history || []).map((h) => ({
          targetDate: istYmd(h.targetDate),
          setAt: h.setAt,
          missed: h.missed,
        })),
      };
    });
    const order = { missed: 0, no_date: 1, upcoming: 2, done_late: 3, done_on_time: 4, done: 5 };
    items.sort((a, b) => order[a.status] - order[b.status] || new Date(a.recordedDate) - new Date(b.recordedDate));

    res.status(200).json({
      success: true,
      data: {
        student: {
          studentId: student._id,
          name: student.username,
          email: student.email,
          registerNumber: student.registerNumber || null,
          category: student.category,
          batch: student.batch || "",
          lastLoginAt: student.lastLoginAt || null,
        },
        tracked: !!entry?.tracked,
        reason: entry?.reason || null,
        summary: summarizeItems(entry?.items || []),
        items,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to load student details.", error: error.message });
  }
};

// PATCH /api/video-commitments/admin/batch — body { studentIds: [...], batch: "2026 – Academy" }
// Sets the same batch for many students at once (e.g. separating Academy
// and Collaboration students). Batch is for reports only — it never
// changes which videos/tests a student can open.
const setBatchForStudents = async (req, res) => {
  try {
    const ids = (Array.isArray(req.body?.studentIds) ? req.body.studentIds : [])
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .slice(0, 2000);
    const batch = String(req.body?.batch ?? "").trim().slice(0, 80);
    if (ids.length === 0) {
      return res.status(400).json({ success: false, message: "Select at least one student." });
    }
    const result = await userModel.updateMany(
      { _id: { $in: ids }, role: "student" },
      { $set: { batch } }
    );
    res.status(200).json({
      success: true,
      message: batch
        ? `Batch "${batch}" set for ${result.modifiedCount} student(s).`
        : `Batch cleared for ${result.modifiedCount} student(s).`,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to update batch.", error: error.message });
  }
};

// PATCH /api/video-commitments/admin/settings — body { popupEnabled?, maxDaysAhead? }
const updateSettings = async (req, res) => {
  try {
    const set = {};
    if (typeof req.body?.popupEnabled === "boolean") set.popupEnabled = req.body.popupEnabled;
    if (req.body?.maxDaysAhead !== undefined) {
      const days = Math.round(Number(req.body.maxDaysAhead));
      if (!Number.isFinite(days) || days < 1 || days > 365) {
        return res.status(400).json({ success: false, message: "Days must be between 1 and 365." });
      }
      set.maxDaysAhead = days;
    }
    await getCommitmentConfig();
    const config = await require("../models/videoCommitmentConfigModel").findByIdAndUpdate(
      "video-commitment-config",
      { $set: set },
      { new: true }
    );
    res.status(200).json({
      success: true,
      message: "Settings saved.",
      data: { popupEnabled: config.popupEnabled, maxDaysAhead: config.maxDaysAhead },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to save settings.", error: error.message });
  }
};

module.exports = {
  getMyPending,
  saveMyDates,
  getTracker,
  getStudentDetail,
  setBatchForStudents,
  updateSettings,
};
