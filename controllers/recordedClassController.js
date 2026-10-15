const recordedClassModel = require("../models/recordedClassModel");
const { recordedWatchStats } = require("../utils/watchTime");
const videoProgressModel = require("../models/videoProgressModel");
const userModel = require("../models/userModel");
const { extractYoutubeVideoId } = require("../utils/youtube");
const { createNotification } = require("./notificationController");
const {
  DAY_MS,
  MAX_DAYS,
  endOfIstDay,
  getAvailableUntil,
  parseAvailabilityInput,
  withAvailability,
} = require("../utils/classAvailability");

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

    // Availability: N days from the class date, until a chosen date, or
    // never. Nothing sent = schema default (7 days from the class date).
    const availability = parseAvailabilityInput(req.body);
    if (availability && !availability.ok) {
      return res.status(400).json({ success: false, message: availability.message });
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
      ...(availability ? availability.fields : {}),
      uploadedBy: req.user._id,
    });

    // Best-effort — a notification failing to write should never fail the
    // actual upload.
    createNotification({
      category,
      type: "video",
      title: `New recorded class: ${title}`,
      refId: recordedClass._id,
      refModel: "RecordedClass",
      createdBy: req.user._id,
    }).catch((err) => console.error("Failed to create video notification:", err.message));

    res.status(201).json({ success: true, data: withAvailability(recordedClass) });
  } catch (error) {
    // Logged server-side so a create failure (validation, duplicate key,
    // storage-quota, connection issue, etc.) is actually diagnosable from
    // Railway logs — the frontend only ever surfaces `.message`, not this
    // `.error` field, so without this the real reason was invisible.
    console.error("Failed to save recorded class:", error.name, error.message);
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

    res.status(200).json({
      success: true,
      data: recordedClasses.map((rc) => withAvailability(rc)),
    });
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
    const availability = parseAvailabilityInput(req.body);
    if (availability && !availability.ok) {
      return res.status(400).json({ success: false, message: availability.message });
    }
    if (availability) Object.assign(update, availability.fields);
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

    res.status(200).json({ success: true, data: withAvailability(recordedClass) });
  } catch (error) {
    console.error("Failed to update recorded class:", error.name, error.message);
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
        const stats = recordedWatchStats(row, durationSeconds);
        const percentWatched = stats.percentWatched;

        return {
          studentId: row.userId._id,
          studentName: row.userId.username,
          studentEmail: row.userId.email,
          videoId: row.videoId._id,
          videoTitle: row.videoId.title,
          // Real time spent playing (rewatching counts); pre-fix rows are
          // capped at the video length — see utils/watchTime.js.
          totalWatchSeconds: stats.timeSpentSeconds,
          watchedSeconds: stats.watchedSeconds,
          estimated: stats.estimated,
          percentWatched,
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
        const stats = recordedWatchStats(row, durationSeconds);
        const percentWatched = stats.percentWatched;

        return {
          videoId: row.videoId._id,
          title: row.videoId.title,
          recordedDate: row.videoId.recordedDate,
          // Real time spent playing (rewatching counts); pre-fix rows are
          // capped at the video length — see utils/watchTime.js.
          totalWatchSeconds: stats.timeSpentSeconds,
          watchedSeconds: stats.watchedSeconds,
          estimated: stats.estimated,
          percentWatched,
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

// PATCH /api/recorded-classes/bulk-availability (admin only) — change how
// long several recordings stay visible to students in one go (the table's
// checkboxes), or extend them. Body: { ids: [...] } plus EITHER the usual
// availability choice ({ availabilityMode: "days" | "date" | "never",
// availabilityDays, availableUntilDate }) OR { extendDays: N } to push each
// recording's end date N days later — counted from today if it has
// already expired, so an expired class comes back for N days.
const bulkUpdateAvailability = async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
    if (ids.length === 0) {
      return res.status(400).json({ success: false, message: "Select at least one recording." });
    }

    if (req.body.extendDays !== undefined) {
      const extendDays = Math.round(Number(req.body.extendDays));
      if (!Number.isFinite(extendDays) || extendDays < 1 || extendDays > MAX_DAYS) {
        return res.status(400).json({
          success: false,
          message: `Extend by 1 to ${MAX_DAYS} days.`,
        });
      }
      const recordings = await recordedClassModel.find({ _id: { $in: ids } });
      const ops = [];
      let skippedNever = 0;
      for (const rec of recordings) {
        const currentUntil = getAvailableUntil(rec);
        if (currentUntil === null) {
          skippedNever++; // already never expires — nothing to extend
          continue;
        }
        const from = Math.max(Date.now(), currentUntil.getTime());
        ops.push({
          updateOne: {
            filter: { _id: rec._id },
            update: { $set: { availableUntil: endOfIstDay(from + extendDays * DAY_MS) } },
          },
        });
      }
      if (ops.length) await recordedClassModel.bulkWrite(ops);
      return res.status(200).json({
        success: true,
        updated: ops.length,
        skippedNeverExpires: skippedNever,
      });
    }

    const availability = parseAvailabilityInput(req.body);
    if (!availability) {
      return res.status(400).json({ success: false, message: "Choose how long these stay available." });
    }
    if (!availability.ok) {
      return res.status(400).json({ success: false, message: availability.message });
    }

    const result = await recordedClassModel.updateMany(
      { _id: { $in: ids } },
      { $set: availability.fields }
    );

    res.status(200).json({ success: true, updated: result.modifiedCount });
  } catch (error) {
    console.error("Failed to bulk-update availability:", error.name, error.message);
    res.status(500).json({
      success: false,
      message: "Failed to update availability.",
      error: error.message,
    });
  }
};

module.exports = {
  createRecordedClass,
  listRecordedClasses,
  updateRecordedClass,
  bulkUpdateAvailability,
  deleteRecordedClass,
  getVideoAnalytics,
  getStudentVideoAnalytics,
};
