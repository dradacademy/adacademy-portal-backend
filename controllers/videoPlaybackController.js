const recordedClassModel = require("../models/recordedClassModel");
const videoProgressModel = require("../models/videoProgressModel");
const enrollmentModel = require("../models/enrollmentModel");
const { isEnrollmentActive } = require("../models/enrollmentModel");
const { mintPlaybackToken, getCustomerCode } = require("../utils/cloudflareStream");

// GET /api/videos/available (student) — every ready, active recording in
// this student's category, annotated with their own watch progress (for
// "Continue Watching — mm:ss" / percent-watched in the list). Does NOT
// check enrollment here — a student should still SEE what's available
// (and why it's locked) even if their enrollment has lapsed; enrollment is
// enforced at playback-token time (below), which is the actual access
// control chokepoint.
const listAvailableVideos = async (req, res) => {
  try {
    if (!req.user.category) {
      return res.status(200).json({ success: true, data: [] });
    }

    const [videos, enrollment, progressRows] = await Promise.all([
      recordedClassModel
        .find({ category: req.user.category, status: "ready", active: true })
        .select("title description category subject recordedDate durationSeconds")
        .sort({ recordedDate: -1 }),
      enrollmentModel.findOne({
        userId: req.user._id,
        category: req.user.category,
      }),
      videoProgressModel.find({ userId: req.user._id }),
    ]);

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
// chokepoint. Requires ALL of: video exists/ready/active, category match,
// AND an active (non-revoked, non-expired) Enrollment record. On success,
// mints a short-lived Cloudflare Stream signed token — the frontend hands
// this straight to Cloudflare's Stream Player, which serves HLS-only, with
// no download affordance and no raw file URL ever exposed to the client.
const getPlaybackToken = async (req, res) => {
  try {
    const { id } = req.params;

    const video = await recordedClassModel.findById(id);
    if (!video || video.status !== "ready" || !video.active) {
      return res.status(404).json({
        success: false,
        message: "This recording is not available.",
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

    const signedToken = mintPlaybackToken(video.cloudflareVideoUid);

    res.status(200).json({
      success: true,
      videoUid: video.cloudflareVideoUid,
      signedToken,
      // The Stream Player iframe embed needs this to build its URL
      // (https://customer-<CODE>.cloudflarestream.com/<token>/iframe) —
      // see the CLOUDFLARE_STREAM_CUSTOMER_CODE env var.
      customerCode: getCustomerCode(),
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
// off mid-video by a progress ping — the NEXT playback-token request is
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
