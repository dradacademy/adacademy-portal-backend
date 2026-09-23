const liveClassModel = require("../models/liveClassModel");
const liveAttendanceModel = require("../models/liveAttendanceModel");
const enrollmentModel = require("../models/enrollmentModel");
const userModel = require("../models/userModel");
const { isEnrollmentActive } = require("../models/enrollmentModel");
const { extractYoutubeVideoId } = require("../utils/youtube");
const { getAttendanceStatus } = require("../utils/attendanceHelper");

// POST /api/live-classes (admin only) — "Go Live": the admin pastes the
// YouTube Live watch link for the stream they've already started on
// YouTube (this doesn't start anything on YouTube's side — it just tells
// the app which stream to show students right now). If this category
// already has an active live class, it's automatically ended first, so a
// category never shows two "live now" entries at once.
const startLiveClass = async (req, res) => {
  try {
    const { title, category, subject, youtubeUrl } = req.body;

    if (!title || !category || !youtubeUrl) {
      return res.status(400).json({
        success: false,
        message: "title, category, and a YouTube Live link are required.",
      });
    }

    const youtubeVideoId = extractYoutubeVideoId(youtubeUrl);
    if (!youtubeVideoId) {
      return res.status(400).json({
        success: false,
        message:
          "That doesn't look like a valid YouTube link. Paste the full YouTube Live watch URL (e.g. https://youtube.com/watch?v=VIDEOID) or the 11-character video ID.",
      });
    }

    // End any live class already in progress for this category — only one
    // "live now" at a time per category.
    await liveClassModel.updateMany(
      { category, active: true },
      { $set: { active: false, endedAt: new Date() } }
    );

    const liveClass = await liveClassModel.create({
      title,
      category,
      subject: subject || null,
      youtubeVideoId,
      active: true,
      startedBy: req.user._id,
      startedAt: new Date(),
    });

    res.status(201).json({ success: true, data: liveClass });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to start live class.",
      error: error.message,
    });
  }
};

// PATCH /api/live-classes/:id (admin only) — edit metadata (title,
// category, subject, or swap the YouTube Live link itself) on an existing
// history row — active or already-ended, same as RecordedClass's edit
// (see updateRecordedClass in recordedClassController.js). Doesn't touch
// `active`/`startedAt`/`endedAt` — those stay owned by Go Live/End Live/
// Delete so this can't be used to sneak a class back to "live" or hide
// when it actually started.
const updateLiveClass = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, category, subject, youtubeUrl } = req.body;

    const update = {};
    if (title !== undefined) update.title = title;
    if (category !== undefined) update.category = category;
    if (subject !== undefined) update.subject = subject || null;
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

    const liveClass = await liveClassModel.findByIdAndUpdate(id, update, {
      new: true,
    });

    if (!liveClass) {
      return res.status(404).json({ success: false, message: "Live class not found." });
    }

    res.status(200).json({ success: true, data: liveClass });
  } catch (error) {
    console.error("Failed to update live class:", error.name, error.message);
    res.status(500).json({
      success: false,
      message: "Failed to update live class.",
      error: error.message,
    });
  }
};

// PATCH /api/live-classes/:id/end (admin only) — "End Live". Doesn't touch
// YouTube itself (the admin ends the actual broadcast there, same as
// always) — this just stops the app from showing it as ongoing.
const endLiveClass = async (req, res) => {
  try {
    const { id } = req.params;

    const liveClass = await liveClassModel.findByIdAndUpdate(
      id,
      { active: false, endedAt: new Date() },
      { new: true }
    );

    if (!liveClass) {
      return res.status(404).json({ success: false, message: "Live class not found." });
    }

    res.status(200).json({ success: true, data: liveClass });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to end live class.",
      error: error.message,
    });
  }
};

// GET /api/live-classes (admin only) — recent history (active + ended),
// newest first, optionally filtered by category. Mainly so the admin can
// see "did I actually go live" / confirm the current state.
const listLiveClasses = async (req, res) => {
  try {
    const { category } = req.query;
    const filter = category ? { category } : {};

    const liveClasses = await liveClassModel
      .find(filter)
      .populate("subject", "name")
      .populate("startedBy", "username email")
      .sort({ startedAt: -1 })
      .limit(50);

    res.status(200).json({ success: true, data: liveClasses });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to list live classes.",
      error: error.message,
    });
  }
};

// GET /api/live-classes/current (student) — any live class currently
// active in the student's own category (normally 0 or 1). Deliberately
// does NOT return the YouTube video ID here — same two-step pattern as
// recorded classes (see videoPlaybackController.js): a student with a
// lapsed enrollment should still see "a class is live right now" (and why
// they can't join), not silently see nothing. The actual video ID is only
// handed over by joinLiveClass below, once enrollment is confirmed.
const listCurrentLiveClasses = async (req, res) => {
  try {
    if (!req.user.category) {
      return res.status(200).json({ success: true, data: [] });
    }

    const [liveClasses, enrollment] = await Promise.all([
      liveClassModel
        .find({ category: req.user.category, active: true })
        .select("title category subject startedAt")
        .sort({ startedAt: -1 }),
      enrollmentModel.findOne({
        userId: req.user._id,
        category: req.user.category,
      }),
    ]);

    const enrollmentActive = isEnrollmentActive(enrollment);

    const data = liveClasses.map((liveClass) => ({
      _id: liveClass._id,
      title: liveClass.title,
      startedAt: liveClass.startedAt,
      enrollmentActive,
      accessLevel: enrollment?.accessLevel || "full",
    }));

    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to check for a live class.",
      error: error.message,
    });
  }
};

// GET /api/live-classes/:id/join (student) — the actual access-control
// chokepoint, same rule as recorded-class playback: category match AND an
// active (non-revoked, non-expired) Enrollment record. Returns the
// YouTube video ID for the frontend's YouTube IFrame Player to embed. Same
// honest limitation as recorded classes: this controls who gets in-app
// access to press play, not what a viewer can do with the stream once
// they're watching it.
const joinLiveClass = async (req, res) => {
  try {
    const { id } = req.params;

    const liveClass = await liveClassModel.findById(id);
    if (!liveClass || !liveClass.active) {
      return res.status(404).json({
        success: false,
        message: "This live class has ended or is not available.",
      });
    }

    if (!req.user.category || liveClass.category !== req.user.category) {
      return res.status(403).json({
        success: false,
        message: "This live class is not available for your course category.",
      });
    }

    const enrollment = await enrollmentModel.findOne({
      userId: req.user._id,
      category: liveClass.category,
    });

    if (!isEnrollmentActive(enrollment)) {
      return res.status(403).json({
        success: false,
        message:
          "Your enrollment for this course has expired or is not active. Contact the academy to renew access.",
      });
    }

    // Test-Series-Only students get tests only — live classes are excluded
    // even while their enrollment is otherwise fully active.
    if (enrollment.accessLevel === "test_series_only") {
      return res.status(403).json({
        success: false,
        message:
          "Your plan is Test Series Only — live classes aren't included. Contact the academy to upgrade to Full Course Access.",
      });
    }

    res.status(200).json({
      success: true,
      youtubeVideoId: liveClass.youtubeVideoId,
      title: liveClass.title,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to join live class.",
      error: error.message,
    });
  }
};

// POST /api/live-classes/:id/progress (student) — called periodically
// (~every 15-20s) by LiveClassPlayer while a student is actually watching,
// plus once on close. Same "actual watch time, not just having the page
// open" principle as recorded-class progress: this only advances by the
// number of seconds really played, so a student can't get credit just by
// leaving the tab open unless the player was actually running.
const recordLiveProgress = async (req, res) => {
  try {
    const { id } = req.params;
    const { deltaSecondsWatched, newSession } = req.body;

    const liveClass = await liveClassModel.findById(id).select("_id");
    if (!liveClass) {
      return res.status(404).json({ success: false, message: "Live class not found." });
    }

    const update = {
      $set: { lastWatchedAt: new Date() },
      $inc: {},
    };
    if (typeof deltaSecondsWatched === "number" && deltaSecondsWatched > 0) {
      update.$inc.totalWatchSeconds = deltaSecondsWatched;
    }
    if (newSession) {
      update.$inc.sessionCount = 1;
    }
    if (Object.keys(update.$inc).length === 0) delete update.$inc;

    const attendance = await liveAttendanceModel.findOneAndUpdate(
      { userId: req.user._id, liveClassId: id },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(200).json({ success: true, data: attendance });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to record live class progress.",
      error: error.message,
    });
  }
};

// GET /api/live-classes/attendance-report (admin only) — every student's
// watch time against every live class, with the same Present/Partially
// Watched/Absent verdict as the recorded-class report (see
// controllers/attendanceController.js for the combined, exportable view of
// both). Kept here too as the live-only source of truth this data comes
// from. Optionally filtered by ?liveClassId= or ?category=.
const getLiveAttendanceReport = async (req, res) => {
  try {
    const { liveClassId, category } = req.query;

    const liveClassFilter = category ? { category } : {};
    if (liveClassId) liveClassFilter._id = liveClassId;

    const liveClasses = await liveClassModel.find(liveClassFilter).select(
      "title category startedAt endedAt active"
    );
    const liveClassIds = liveClasses.map((lc) => lc._id);
    const liveClassById = new Map(liveClasses.map((lc) => [lc._id.toString(), lc]));

    const attendanceRows = await liveAttendanceModel
      .find({ liveClassId: { $in: liveClassIds } })
      .populate("userId", "username email category")
      .sort({ lastWatchedAt: -1 });

    const data = attendanceRows
      .filter((row) => row.userId && liveClassById.has(row.liveClassId.toString()))
      .map((row) => {
        const liveClass = liveClassById.get(row.liveClassId.toString());
        const durationSeconds = liveClass.getElapsedSeconds();
        const watchPercent = Math.min(
          100,
          (row.totalWatchSeconds / durationSeconds) * 100
        );

        return {
          studentId: row.userId._id,
          studentName: row.userId.username,
          studentEmail: row.userId.email,
          liveClassId: liveClass._id,
          liveClassTitle: liveClass.title,
          startedAt: liveClass.startedAt,
          liveClassStillActive: liveClass.active,
          durationSeconds,
          watchedSeconds: row.totalWatchSeconds,
          watchPercent: Number(watchPercent.toFixed(1)),
          attendanceStatus: getAttendanceStatus(watchPercent),
          lastWatchedAt: row.lastWatchedAt,
        };
      });

    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch live attendance report.",
      error: error.message,
    });
  }
};

// DELETE /api/live-classes/:id (admin only) — permanently removes a live
// class entry from the history table (e.g. a duplicate/mistaken entry).
// Also removes its liveAttendanceModel rows so no orphaned watch-time data
// is left pointing at a deleted class. If the entry being deleted is the
// one currently live, this has the same effect as "End Live" plus removal
// from history — students immediately stop seeing it (listCurrentLiveClasses
// and joinLiveClass both look the document up fresh on every request, so
// a deleted class simply no longer exists for them, in-app or in history).
const deleteLiveClass = async (req, res) => {
  try {
    const { id } = req.params;

    const liveClass = await liveClassModel.findByIdAndDelete(id);
    if (!liveClass) {
      return res.status(404).json({ success: false, message: "Live class not found." });
    }

    await liveAttendanceModel.deleteMany({ liveClassId: id });

    res.status(200).json({ success: true, data: { _id: id } });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to delete live class.",
      error: error.message,
    });
  }
};

module.exports = {
  startLiveClass,
  updateLiveClass,
  endLiveClass,
  listLiveClasses,
  listCurrentLiveClasses,
  joinLiveClass,
  recordLiveProgress,
  getLiveAttendanceReport,
  deleteLiveClass,
};
