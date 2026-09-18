const userModel = require("../models/userModel");
const progressWeightConfigModel = require("../models/progressWeightConfigModel");
const { computeStudentProgress, getWeightConfig } = require("../utils/studentProgressHelper");

// GET /api/student-progress (admin only) — the Student Progress & Learning
// Analytics Dashboard's list view. Every student, with Overall Progress %,
// exam/video/attachment completion (completed/total), computed dynamically
// from real activity (never hardcoded) via the shared
// utils/studentProgressHelper.js. Supports batch/course/progress-range/
// completion/active-inactive filters and sorting — all applied here,
// server-side, after the one bulk computation (no per-student queries).
const listStudentProgress = async (req, res) => {
  try {
    const {
      batch,
      category,
      search,
      examStatus,
      videoStatus,
      attachmentStatus,
      activeStatus,
      progressMin,
      progressMax,
      sortBy,
      sortDir,
    } = req.query;

    const match = { role: "student" };
    if (category) match.category = category;
    if (batch) match.batch = batch;
    if (activeStatus === "active") match.isDisabled = false;
    if (activeStatus === "inactive") match.isDisabled = true;
    if (search) {
      const regex = new RegExp(search.trim(), "i");
      match.$or = [{ username: regex }, { email: regex }, { registerNumber: regex }];
    }

    const students = await userModel
      .find(match)
      .select("username email registerNumber category batch isDisabled lastLoginAt createdAt")
      .lean();

    const progressMap = await computeStudentProgress(students);

    let rows = students.map((student) => {
      const p = progressMap.get(student._id.toString()) || {
        exams: { completed: 0, total: 0, percent: 0 },
        videos: { completed: 0, total: 0, percent: 0 },
        attachments: { completed: 0, total: 0, percent: 0 },
        overallProgress: 0,
      };
      return {
        studentId: student._id,
        name: student.username,
        email: student.email,
        registerNumber: student.registerNumber || null,
        category: student.category || null,
        batch: student.batch || "",
        isDisabled: !!student.isDisabled,
        lastLoginAt: student.lastLoginAt || null,
        overallProgress: p.overallProgress,
        exams: { completed: p.exams.completed, total: p.exams.total, percent: p.exams.percent },
        videos: { completed: p.videos.completed, total: p.videos.total, percent: p.videos.percent },
        attachments: {
          completed: p.attachments.completed,
          total: p.attachments.total,
          percent: p.attachments.percent,
        },
      };
    });

    if (progressMin !== undefined && progressMin !== "") {
      rows = rows.filter((r) => r.overallProgress >= Number(progressMin));
    }
    if (progressMax !== undefined && progressMax !== "") {
      rows = rows.filter((r) => r.overallProgress <= Number(progressMax));
    }

    const completionFilter = (bucket, status) => {
      if (status === "complete") {
        rows = rows.filter((r) => r[bucket].total > 0 && r[bucket].completed === r[bucket].total);
      } else if (status === "incomplete") {
        rows = rows.filter((r) => r[bucket].completed < r[bucket].total);
      }
    };
    completionFilter("exams", examStatus);
    completionFilter("videos", videoStatus);
    completionFilter("attachments", attachmentStatus);

    const dir = sortDir === "desc" ? -1 : 1;
    const sortKey = sortBy || "name";
    rows.sort((a, b) => {
      let av;
      let bv;
      switch (sortKey) {
        case "overallProgress":
          av = a.overallProgress;
          bv = b.overallProgress;
          break;
        case "examPercent":
          av = a.exams.percent;
          bv = b.exams.percent;
          break;
        case "videoPercent":
          av = a.videos.percent;
          bv = b.videos.percent;
          break;
        case "attachmentPercent":
          av = a.attachments.percent;
          bv = b.attachments.percent;
          break;
        default:
          av = (a.name || "").toLowerCase();
          bv = (b.name || "").toLowerCase();
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });

    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load student progress.",
      error: error.message,
    });
  }
};

// GET /api/student-progress/:studentId (admin only) — the "View Detail"
// page: profile info, overall progress, exam/video/attachment breakdown
// lists, last login. Uses the exact same computeStudentProgress() call as
// the list above, so these numbers can never disagree with the dashboard
// row that linked here.
const getStudentProgressDetail = async (req, res) => {
  try {
    const { studentId } = req.params;

    const student = await userModel
      .findById(studentId)
      .select("username email registerNumber role category batch isDisabled lastLoginAt createdAt")
      .lean();

    if (!student || student.role !== "student") {
      return res.status(404).json({ success: false, message: "Student not found." });
    }

    const progressMap = await computeStudentProgress([student]);
    const progress = progressMap.get(studentId) || {
      exams: { completed: 0, total: 0, percent: 0, list: [] },
      videos: { completed: 0, total: 0, percent: 0, list: [] },
      attachments: { completed: 0, total: 0, percent: 0, list: [] },
      overallProgress: 0,
    };

    res.status(200).json({
      success: true,
      data: {
        student: {
          studentId: student._id,
          name: student.username,
          email: student.email,
          registerNumber: student.registerNumber || null,
          category: student.category || null,
          batch: student.batch || "",
          isDisabled: !!student.isDisabled,
          lastLoginAt: student.lastLoginAt || null,
          joinedAt: student.createdAt,
        },
        progress,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load student progress detail.",
      error: error.message,
    });
  }
};

// GET /api/student-progress/me (any student) — the student's own progress,
// for their "individual progress" view in their own login.
const getMyProgress = async (req, res) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({
        success: false,
        message: "Only students have a progress view.",
      });
    }

    const student = await userModel
      .findById(req.user._id)
      .select("username email category batch lastLoginAt")
      .lean();

    const progressMap = await computeStudentProgress([student]);
    const progress = progressMap.get(req.user._id.toString()) || {
      exams: { completed: 0, total: 0, percent: 0, list: [] },
      videos: { completed: 0, total: 0, percent: 0, list: [] },
      attachments: { completed: 0, total: 0, percent: 0, list: [] },
      overallProgress: 0,
    };

    res.status(200).json({ success: true, data: progress });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load your progress.",
      error: error.message,
    });
  }
};

// GET /api/student-progress/weights (admin only)
const getWeights = async (req, res) => {
  try {
    const config = await getWeightConfig();
    res.status(200).json({ success: true, data: config });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load progress weight configuration.",
      error: error.message,
    });
  }
};

// PATCH /api/student-progress/weights (admin only) — the "configurable
// weighting system for Exams, Videos and Attachments" the admin asked for.
const updateWeights = async (req, res) => {
  try {
    const { examWeight, videoWeight, attachmentWeight } = req.body;

    const update = {};
    if (examWeight !== undefined) update.examWeight = Math.max(0, Number(examWeight) || 0);
    if (videoWeight !== undefined) update.videoWeight = Math.max(0, Number(videoWeight) || 0);
    if (attachmentWeight !== undefined)
      update.attachmentWeight = Math.max(0, Number(attachmentWeight) || 0);

    const updated = await progressWeightConfigModel.findByIdAndUpdate(
      "progress-weight-config",
      update,
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to update progress weight configuration.",
      error: error.message,
    });
  }
};

module.exports = {
  listStudentProgress,
  getStudentProgressDetail,
  getMyProgress,
  getWeights,
  updateWeights,
};
