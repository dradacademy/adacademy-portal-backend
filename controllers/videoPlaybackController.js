const recordedClassModel = require("../models/recordedClassModel");
const videoProgressModel = require("../models/videoProgressModel");
const enrollmentModel = require("../models/enrollmentModel");
const { isEnrollmentActive } = require("../models/enrollmentModel");

// GET /api/videos/available (student) — every ready, active recording in
// this student's category, annotated with their own watch progress (for
// "Continue Watching — mm:ss" / percent-watched in the list). Does NOT
// check enrollment here — a student should still SEE what's available
// (and why it's locked) even if their enrollment has lapsed; enrollment is
// enforced at playback-access time (below), which is the actual access
// control chokepoint.
//
// Also drops any recording whose per-video visibility window has elapsed
// (default 7 days from recordedDate, admin-editable per video, or "never"
// if the admin cleared it) — this is what makes a class "disappear after a
// week" for students automatically, computed live on every request (same
// pattern as enrollment expiry), with no scheduled job needed. It has
// nothing to do with YouTube: the admin's video keeps existing there until
// they delete it themselves, whenever they choose. Filtered in JS (not the
// Mongo query) since the window can differ video-by-video.
const listAvailableVideos = async (req, res) => {
  try {
    if (!req.user.category) {
      return res.status(200).json({ success: true, data: [] });
    }

    const [allVideos, enrollment, progressRows] = await Promise.all([
      recordedClassModel
        .find({ category: req.user.category, active: true })
        .select(
          "title description category subject recordedDate durationSeconds visibilityWindowDays active"
        )
        .sort({ recordedDate: -1 }),
      enrollmentModel.findOne({
        userId: req.user._id,
        category: req.user.category,
      }),
      videoProgressModel.find({ userId: req.user._id }),
    ]);

    const videos = allVideos.filter((video) => video.isVisibleToStudents());

    const progressByVideoId = new Map(
      progressRows.map((p) => [p.videoId.toString(), p])
    );

    const enrollmentActive = isEnrollmentActive(enrollment);

    const data = videos.map((video) => {
      const progress = progressByVideoId.get(video._id.toString());
      const durationSeconds = video.durationSeconds || 0;
      const percentWatched =
        progress && durationSeconds
          ? Math.min(100, (progress.totalWatchSeconds / durationSeconds) * 100)
          : 0;

      return {
        _id: video._id,
        title: video.title,
        description: video.description,
        recordedDate: video.recordedDate,
        durationSeconds: video.durationSeconds,
        lastPositionSeconds: progress?.lastPositionSeconds || 0,
        percentWatched: Number(percentWatched.toFixed(1)),
        // Lets the frontend show a clear "enrollment expired" state instead
        // of a generic error when the student taps play.
        enrollmentActive,
        // Lets the frontend show a "Test Series Only" locked state instead
        // of a generic error for a student whose plan doesn't include
        // recordings — see the matching check in getPlaybackToken below.
        accessLevel: enrollment?.accessLevel || "full",
      };
    });

    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to list available recorded classes.",
      error: error.message,
    });
  }
};

// GET /api/videos/:id/playback-token (student) — the actual access-control
// chokepoint, despite the route name (kept for frontend compatibility).
// Requires ALL of: video exists/active, category match, AND an active
// (non-revoked, non-expired) Enrollment record. On success, returns the
// YouTube video ID for the frontend's YouTube IFrame Player to embed.
//
// Real, honest limitation versus the Cloudflare Stream approach this
// replaced: this check controls who gets IN-APP access to press play, but
// once a video is playing it's an ordinary YouTube embed — there's no
// signed/expiring token and no way to fully block a determined viewer from
// downloading or recording it by other means. The video is uploaded as
// Unlisted on YouTube (not publicly searchable), but anyone who obtains
// the raw watch link directly on youtube.com can still open it there.
const getPlaybackToken = async (req, res) => {
  try {
    const { id } = req.params;

    const video = await recordedClassModel.findById(id);
    if (!video || !video.active) {
      return res.status(404).json({
        success: false,
        message: "This recording is not available.",
      });
    }

    // Same per-video visibility window as the list endpoint — checked again
    // here so a direct/stale request can't play a video after it has aged
    // out, even if the student already had the page open from before.
    if (!video.isVisibleToStudents()) {
      return res.status(404).json({
        success: false,
        message: "This recording is no longer available.",
      });
    }

    if (!req.user.category || video.category !== req.user.category) {
      return res.status(403).json({
        success: false,
        message: "This recording is not available for your course category.",
      });
    }

    const enrollment = await enrollmentModel.findOne({
      userId: req.user._id,
      category: video.category,
    });

    if (!isEnrollmentActive(enrollment)) {
      return res.status(403).json({
        success: false,
        message:
          "Your enrollment for this course has expired or is not active. Contact the academy to renew access.",
      });
    }

    // Test-Series-Only students get tests only — recordings are excluded
    // even while their enrollment is otherwise fully active. Exam access
    // (checkExamEligibility.js / examFunctionController.js) deliberately
    // never checks accessLevel, so this is the only place this plan is
    // actually enforced for video.
    if (enrollment.accessLevel === "test_series_only") {
      return res.status(403).json({
        success: false,
        message:
          "Your plan is Test Series Only — recorded lectures aren't included. Contact the academy to upgrade to Full Course Access.",
      });
    }

    res.status(200).json({
      success: true,
      youtubeVideoId: video.youtubeVideoId,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to authorize video playback.",
      error: error.message,
    });
  }
};

// POST /api/videos/:id/progress (student) — called periodically (~every
// 15-20s) by the player while playing, plus once on pause/unmount. Upserts
// the rolled-up watch-time counters; does NOT re-check enrollment (a
// student mid-way through an already-authorized playback session isn't cut
// off mid-video by a progress ping — the NEXT playback-access request is
// where a lapsed enrollment takes effect).
const recordProgress = async (req, res) => {
  try {
    const { id } = req.params;
    const { positionSeconds, deltaSecondsWatched, newSession } = req.body;

    const video = await recordedClassModel.findById(id).select("_id");
    if (!video) {
      return res.status(404).json({ success: false, message: "Video not found." });
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
    if (typeof positionSeconds === "number" && positionSeconds >= 0) {
      update.$set.lastPositionSeconds = positionSeconds;
    }
    if (Object.keys(update.$inc).length === 0) delete update.$inc;

    const progress = await videoProgressModel.findOneAndUpdate(
      { userId: req.user._id, videoId: id },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(200).json({ success: true, data: progress });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to record video progress.",
      error: error.message,
    });
  }
};

module.exports = {
  listAvailableVideos,
  getPlaybackToken,
  recordProgress,
};
