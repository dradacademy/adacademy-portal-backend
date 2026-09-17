// Cost-control retention job for the recorded-class video system (see the
// plan's cost math: storage grows ~$225/month if every class is kept
// forever at the admin's stated scale). Runs in-process on a setInterval —
// deliberately NOT a new dependency (node-cron), since this repo has no
// existing cron infrastructure and adding a package isn't needed for a
// once-a-day sweep. Railway's own cron/scheduled-job feature is an equally
// valid alternative if the admin prefers running this out-of-process; this
// implementation just needs the Express process to stay up, which it
// already does.
const recordedClassModel = require("../models/recordedClassModel");
const videoSettingsModel = require("../models/videoSettingsModel");
const { deleteStreamVideo } = require("../utils/cloudflareStream");

const SETTINGS_ID = "video-settings";

const getVideoRetentionDays = async () => {
  const settings = await videoSettingsModel.findById(SETTINGS_ID);
  return settings?.videoRetentionDays ?? null;
};

const setVideoRetentionDays = async (days) => {
  return videoSettingsModel.findByIdAndUpdate(
    SETTINGS_ID,
    { videoRetentionDays: days },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

// Finds every ACTIVE recorded class older (by recordedDate) than the
// configured retention window, deletes it from Cloudflare Stream storage,
// and marks the local doc inactive (never hard-deleted — the metadata row
// stays for history/analytics, matching how PATCH .../active:false already
// works). A no-op when no retention window is configured (the default).
const runVideoRetentionSweep = async () => {
  const retentionDays = await getVideoRetentionDays();
  if (!retentionDays || retentionDays <= 0) {
    return { skipped: true, reason: "No retention window configured.", deleted: [] };
  }

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const expiredVideos = await recordedClassModel.find({
    active: true,
    recordedDate: { $lt: cutoff },
  });

  const deleted = [];
  const failed = [];

  for (const video of expiredVideos) {
    try {
      await deleteStreamVideo(video.cloudflareVideoUid);
      video.active = false;
      video.status = "error"; // no longer playable — storage is gone
      await video.save();
      deleted.push(video._id.toString());
    } catch (error) {
      // Don't let one failed deletion (e.g. a transient Cloudflare API
      // error) stop the rest of the sweep — log and keep going; it'll be
      // retried on the next scheduled run.
      console.error(
        `Video retention sweep: failed to delete ${video._id} (Cloudflare uid ${video.cloudflareVideoUid}):`,
        error.message
      );
      failed.push(video._id.toString());
    }
  }

  return { skipped: false, deleted, failed };
};

// Starts the in-process daily sweep. Call once from index.js at startup.
// Deliberately does NOT run immediately on startup (a cold-start deploy
// shouldn't immediately start deleting videos) — the first sweep happens
// one interval after boot.
const startVideoRetentionScheduler = (intervalMs = 24 * 60 * 60 * 1000) => {
  const timer = setInterval(() => {
    runVideoRetentionSweep().catch((error) => {
      console.error("Video retention sweep failed:", error.message);
    });
  }, intervalMs);

  // Don't keep the process alive just for this timer (relevant mainly for
  // tests/scripts that import index.js without wanting to hang).
  if (timer.unref) timer.unref();

  return timer;
};

module.exports = {
  getVideoRetentionDays,
  setVideoRetentionDays,
  runVideoRetentionSweep,
  startVideoRetentionScheduler,
};
