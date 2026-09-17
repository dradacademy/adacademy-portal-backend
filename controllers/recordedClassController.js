const crypto = require("crypto");
const recordedClassModel = require("../models/recordedClassModel");
const videoProgressModel = require("../models/videoProgressModel");
const userModel = require("../models/userModel");
const {
  createDirectUploadUrl,
  deleteStreamVideo,
} = require("../utils/cloudflareStream");
const {
  getVideoRetentionDays,
  setVideoRetentionDays,
  runVideoRetentionSweep,
} = require("../jobs/videoRetentionJob");

// POST /api/recorded-classes/upload-url (admin only)
// Requests a one-time direct-creator-upload URL from Cloudflare Stream and
// creates the RecordedClass metadata row (status: "uploading"). The
// ADMIN'S BROWSER then uploads the actual video file straight to the
// returned uploadUrl — never through this server — so multi-hour class
// recordings never hit our own request size/timeout limits.
const requestUploadUrl = async (req, res) => {
  try {
    const { title, description, category, subject, recordedDate } = req.body;

    if (!title || !category || !recordedDate) {
      return res.status(400).json({
        success: false,
        message: "title, category, and recordedDate are required.",
      });
    }

    const { uploadUrl, videoUid } = await createDirectUploadUrl();

    const recordedClass = await recordedClassModel.create({
      title,
      description: description || "",
      category,
      subject: subject || null,
      cloudflareVideoUid: videoUid,
      recordedDate,
      uploadedBy: req.user._id,
      status: "uploading",
    });

    res.status(200).json({
      success: true,
      uploadUrl,
      recordedClassId: recordedClass._id,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to request an upload URL from Cloudflare Stream.",
      error: error.message,
    });
  }
};

// Verify Cloudflare's webhook signature when a signing secret is
// configured (CLOUDFLARE_STREAM_WEBHOOK_SECRET — the secret returned when
// the webhook is created/retrieved via the Cloudflare API). If no secret
// has been set up yet, the webhook is still accepted (so the admin isn't
// blocked before finishing every last piece of Cloudflare setup) but this
// is logged — configure the secret in Railway env as soon as possible so a
// forged request can't flip a video's status.
//
// Verification per Cloudflare's documented scheme: the `Webhook-Signature`
// header is "time=<unix ts>,sig1=<hex hmac>"; the signed string is
// `${time}.${rawRequestBody}` (HMAC-SHA256 with the webhook secret). This
// relies on req.rawBody (captured globally in index.js's express.json()
// verify callback) rather than re-serializing req.body, since a
// re-serialization can differ from Cloudflare's original bytes.
// https://developers.cloudflare.com/stream/manage-video-library/using-webhooks/
const verifyWebhookSignature = (req) => {
  const secret = process.env.CLOUDFLARE_STREAM_WEBHOOK_SECRET;
  if (!secret) {
    console.warn(
      "CLOUDFLARE_STREAM_WEBHOOK_SECRET is not set — skipping webhook signature verification."
    );
    return true;
  }

  const signatureHeader = req.headers["webhook-signature"];
  if (!signatureHeader) return false;

  // Cloudflare's header format: "time=<ts>,sig1=<hex hmac>"
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => p.split("="))
  );
  if (!parts.time || !parts.sig1) return false;

  const payload = `${parts.time}.${req.rawBody || JSON.stringify(req.body)}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(parts.sig1)
    );
  } catch {
    return false;
  }
};

// POST /api/recorded-classes/webhook (Cloudflare Stream calls this — no
// user auth, verified by signature instead)
const handleUploadWebhook = async (req, res) => {
  try {
    if (!verifyWebhookSignature(req)) {
      return res.status(401).json({ success: false, message: "Invalid webhook signature." });
    }

    const videoUid = req.body?.uid;
    const state = req.body?.status?.state;
    const durationSeconds = req.body?.duration;

    if (!videoUid) {
      return res.status(400).json({ success: false, message: "Missing video uid." });
    }

    const update = {};
    if (state === "ready") {
      update.status = "ready";
      if (typeof durationSeconds === "number" && durationSeconds > 0) {
        update.durationSeconds = Math.round(durationSeconds);
      }
    } else if (state === "error") {
      update.status = "error";
    }

    if (Object.keys(update).length > 0) {
      await recordedClassModel.findOneAndUpdate(
        { cloudflareVideoUid: videoUid },
        update
      );
    }

    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to process Cloudflare Stream webhook.",
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

// PATCH /api/recorded-classes/:id (admin only) — edit metadata and/or
// retire (active: false) a recording. Retiring never hard-deletes the row
// (watch-history/analytics keep working); Cloudflare storage deletion is a
// separate, explicit step (the retention job, or a future "delete forever"
// admin action) since retiring just hides it from students.
const updateRecordedClass = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, category, subject, recordedDate, active } =
      req.body;

    const update = {};
    if (title !== undefined) update.title = title;
    if (description !== undefined) update.description = description;
    if (category !== undefined) update.category = category;
    if (subject !== undefined) update.subject = subject || null;
    if (recordedDate !== undefined) update.recordedDate = recordedDate;
    if (active !== undefined) update.active = active;

    const recordedClass = await recordedClassModel.findByIdAndUpdate(
      id,
      update,
      { new: true }
    );

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

// DELETE /api/recorded-classes/:id (admin only) — permanently deletes from
// Cloudflare Stream storage AND marks the local row inactive. Distinct from
// PATCH .../active:false (retire, reversible) — this is the "delete
// forever" action and cannot be undone.
const deleteRecordedClass = async (req, res) => {
  try {
    const { id } = req.params;
    const recordedClass = await recordedClassModel.findById(id);
    if (!recordedClass) {
      return res.status(404).json({ success: false, message: "Recorded class not found." });
    }

    await deleteStreamVideo(recordedClass.cloudflareVideoUid);
    recordedClass.active = false;
    recordedClass.status = "error"; // no longer playable — storage is gone
    await recordedClass.save();

    res.status(200).json({ success: true, message: "Recorded class deleted from storage." });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to delete recorded class from Cloudflare Stream.",
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

// GET /api/recorded-classes/settings/retention (admin only)
const getRetentionSetting = async (req, res) => {
  try {
    const videoRetentionDays = await getVideoRetentionDays();
    res.status(200).json({ success: true, data: { videoRetentionDays } });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch retention setting.",
      error: error.message,
    });
  }
};

// PATCH /api/recorded-classes/settings/retention (admin only) — body:
// { videoRetentionDays: Number | null }. null disables automatic deletion
// (the default) — this is a deliberate opt-IN to irreversible storage
// deletion, so the admin has to set it explicitly.
const updateRetentionSetting = async (req, res) => {
  try {
    const { videoRetentionDays } = req.body;

    if (
      videoRetentionDays !== null &&
      (typeof videoRetentionDays !== "number" || videoRetentionDays <= 0)
    ) {
      return res.status(400).json({
        success: false,
        message: "videoRetentionDays must be a positive number of days, or null to disable.",
      });
    }

    const settings = await setVideoRetentionDays(videoRetentionDays);
    res.status(200).json({ success: true, data: settings });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to update retention setting.",
      error: error.message,
    });
  }
};

// POST /api/recorded-classes/settings/retention/run-now (admin only) —
// manually trigger a retention sweep immediately, instead of waiting for
// the daily scheduler (useful right after configuring a retention window,
// or to confirm it's working).
const runRetentionSweepNow = async (req, res) => {
  try {
    const result = await runVideoRetentionSweep();
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to run retention sweep.",
      error: error.message,
    });
  }
};

module.exports = {
  requestUploadUrl,
  handleUploadWebhook,
  listRecordedClasses,
  updateRecordedClass,
  deleteRecordedClass,
  getVideoAnalytics,
  getStudentVideoAnalytics,
  getRetentionSetting,
  updateRetentionSetting,
  runRetentionSweepNow,
};
