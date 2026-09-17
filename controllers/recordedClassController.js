const recordedClassModel = require("../models/recordedClassModel");
const videoProgressModel = require("../models/videoProgressModel");
const userModel = require("../models/userModel");
const { extractYoutubeVideoId } = require("../utils/youtube");

// POST /api/recorded-classes (admin only) — the admin uploads the class
// recording to their own YouTube account (as Unlisted, so it isn't publicly
// searchable) and pastes the resulting link/ID here. No file ever passes
// through our server or a third-party API — this just records the
// metadata + video ID.
const createRecordedClass = async (req, res) => {
  try {
    const {
      title,
      description,
      category,
      subject,
      recordedDate,
      youtubeUrl,
      durationSeconds,
    } = req.body;

    if (!title || !category || !recordedDate || !youtubeUrl) {
      return res.status(400).json({
        success: false,
        message: "title, category, recordedDate, and a YouTube link are required.",
      });
    }

    const youtubeVideoId = extractYoutubeVideoId(youtubeUrl);
    if (!youtubeVideoId) {
      return res.status(400).json({
        success: false,
        message:
          "That doesn't look like a valid YouTube link. Paste the full video URL (e.g. https://youtu.be/VIDEOID) or the 11-character video ID.",
      });
    }

    const recordedClass = await recordedClassModel.create({
      title,
      description: description || "",
      category,
      subject: subject || null,
      youtubeVideoId,
      recordedDate,
      durationSeconds:
        typeof durationSeconds === "number" && durationSeconds > 0
          ? Math.round(durationSeconds)
          : null,
      uploadedBy: req.user._id,
    });

    res.status(201).json({ success: true, data: recordedClass });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to save recorded class.",
      error: error.message,
    });
  }
};

// GET /api/recorded-classes (admin only) — list every recording, newest
// first, optionally filtered by category.
const listRecordedClasses = async (req, res) => {
  try {
    const { category } = req.query;
    const filter = category ? { category } : {};

    const recordedClasses = await recordedClassModel
      .find(filter)
      .populate("subject", "name")
      .populate("uploadedBy", "username email")
      .sort({ recordedDate: -1, createdAt: -1 });

    res.status(200).json({ success: true, data: recordedClasses });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to list recorded classes.",
      error: error.message,
    });
  }
};

// PATCH /api/recorded-classes/:id (admin only) — edit metadata (including
// swapping the YouTube link itself, or filling in duration later) and/or
// retire (active: false) a recording. Retiring never deletes the row
// (watch-history/analytics keep working); the video itself lives on
// YouTube and is managed there directly by the admin.
const updateRecordedClass = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      description,
      category,
      subject,
      recordedDate,
      youtubeUrl,
      durationSeconds,
      active,
    } = req.body;

    const update = {};
    if (title !== undefined) update.title = title;
    if (description !== undefined) update.description = description;
    if (category !== undefined) update.category = category;
    if (subject !== undefined) update.subject = subject || null;
    if (recordedDate !== undefined) update.recordedDate = recordedDate;
    if (active !== undefined) update.active = active;
    if (durationSeconds !== undefined) {
      update.durationSeconds =
        typeof durationSeconds === "number" && durationSeconds > 0
          ? Math.round(durationSeconds)
          : null;
    }
    if (youtubeUrl !== undefined) {
      const youtubeVideoId = extractYoutubeVideoId(youtubeUrl);
      if (!youtubeVideoId) {
        return res.status(400).json({
          success: false,
          message: "That doesn't look like a valid YouTube link or video ID.",
        });
      }
      update.youtubeVideoId = youtubeVideoId;
    }

    const recordedClass = await recordedClassModel.findByIdAndUpdate(id, update, {
      new: true,
    });

    if (!recordedClass) {
      return res.status(404).json({ success: false, message: "Recorded class not found." });
    }

    res.status(200).json({ success: true, data: recordedClass });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to update recorded class.",
      error: error.message,
    });
  }
};

// DELETE /api/recorded-classes/:id (admin only) — removes the metadata row
// entirely. There's no separate "storage" to clean up (the video itself
// stays on YouTube, managed there by the admin) — this just stops it from
// showing up anywhere in the app. Existing videoProgress rows referencing
// this id are left as historical data rather than cascade-deleted.
const deleteRecordedClass = async (req, res) => {
  try {
    const { id } = req.params;
    const recordedClass = await recordedClassModel.findByIdAndDelete(id);
    if (!recordedClass) {
      return res.status(404).json({ success: false, message: "Recorded class not found." });
    }

    res.status(200).json({ success: true, message: "Recorded class removed." });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to delete recorded class.",
      error: error.message,
    });
  }
};

// GET /api/recorded-classes/analytics (admin only) — per-video roll-up:
// every student who has ANY watch progress on this video, with their
// percentWatched/totalWatchSeconds/sessionCount/lastWatchedAt.
const getVideoAnalytics = async (req, res) => {
  try {
    const { videoId } = req.query;
    const filter = videoId ? { videoId } : {};

    const progressRows = await videoProgressModel
      .find(filter)
      .populate("userId", "username email")
      .populate("videoId", "title durationSeconds category")
      .sort({ lastWatchedAt: -1 });

    const data = progressRows
      .filter((row) => row.userId && row.videoId)
      .map((row) => {
        const durationSeconds = row.videoId.durationSeconds || 0;
        const percentWatched = durationSeconds
          ? Math.min(100, (row.totalWatchSeconds / durationSeconds) * 100)
          : 0;

        return {
          studentId: row.userId._id,
          studentName: row.userId.username,
          studentEmail: row.userId.email,
          videoId: row.videoId._id,
          videoTitle: row.videoId.title,
          totalWatchSeconds: row.totalWatchSeconds,
          percentWatched: Number(percentWatched.toFixed(1)),
          sessionCount: row.sessionCount,
          lastWatchedAt: row.lastWatchedAt,
          lastPositionSeconds: row.lastPositionSeconds,
        };
      });

    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch video analytics.",
      error: error.message,
    });
  }
};

// GET /api/recorded-classes/analytics/student/:userId (admin only) — the
// per-student view: every video this student has ANY progress on, matching
// the admin's worked example table (Student -> Class 1: 95%, Class 2: 72%).
const getStudentVideoAnalytics = async (req, res) => {
  try {
    const { userId } = req.params;

    const student = await userModel.findById(userId).select("username email");
    if (!student) {
      return res.status(404).json({ success: false, message: "Student not found." });
    }

    const progressRows = await videoProgressModel
      .find({ userId })
      .populate("videoId", "title durationSeconds category recordedDate")
      .sort({ lastWatchedAt: -1 });

    const data = progressRows
      .filter((row) => row.videoId)
      .map((row) => {
        const durationSeconds = row.videoId.durationSeconds || 0;
        const percentWatched = durationSeconds
          ? Math.min(100, (row.totalWatchSeconds / durationSeconds) * 100)
          : 0;

        return {
          videoId: row.videoId._id,
          title: row.videoId.title,
          recordedDate: row.videoId.recordedDate,
          totalWatchSeconds: row.totalWatchSeconds,
          percentWatched: Number(percentWatched.toFixed(1)),
          sessionCount: row.sessionCount,
          lastWatchedAt: row.lastWatchedAt,
          lastPositionSeconds: row.lastPositionSeconds,
        };
      });

    res.status(200).json({
      success: true,
      data: {
        studentName: student.username,
        studentEmail: student.email,
        videos: data,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch student video analytics.",
      error: error.message,
    });
  }
};

module.exports = {
  createRecordedClass,
  listRecordedClasses,
  updateRecordedClass,
  deleteRecordedClass,
  getVideoAnalytics,
  getStudentVideoAnalytics,
};
