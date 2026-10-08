const recordedClassModel = require("../models/recordedClassModel");

// The real length of a live class, used for live attendance % and for the
// copy added to Recorded Classes. (Fixed 2026-10-08.)
//
// Before, it was always "End Live time - Go Live time". When End Live was
// pressed late — or never, and the class only ended when the next one
// started — a 2.5h class counted as 7h, or even 71h (Deep Foundation
// Class 3: 30 Sep -> 3 Oct), making every student's live % meaningless.
// Now, in this order:
//   1. a length the admin set on the live class (Edit -> Class length);
//   2. else the length of the recording the admin added manually for the
//      same YouTube video (the stream's real length);
//   3. else Go Live -> End Live time, capped at LIVE_CLASS_MAX_HOURS (6h).
const MAX_LIVE_SECONDS = (parseFloat(process.env.LIVE_CLASS_MAX_HOURS) || 6) * 3600;

const elapsedSeconds = (lc) => {
  const end = lc.endedAt ? new Date(lc.endedAt) : new Date();
  return Math.max(1, Math.round((end.getTime() - new Date(lc.startedAt).getTime()) / 1000));
};

const keyFor = (category, videoId) => `${category}|${videoId}`;

// Map of "category|videoId" -> duration of a MANUALLY added recording.
const loadManualRecordingLengths = async (liveClasses) => {
  const videoIds = [...new Set(liveClasses.map((lc) => lc.youtubeVideoId).filter(Boolean))];
  if (videoIds.length === 0) return new Map();
  const recs = await recordedClassModel
    .find({
      youtubeVideoId: { $in: videoIds },
      sourceLiveClassId: null,
      durationSeconds: { $gt: 0 },
    })
    .select("category youtubeVideoId durationSeconds")
    .lean();
  return new Map(recs.map((r) => [keyFor(r.category, r.youtubeVideoId), r.durationSeconds]));
};

// -> { seconds, source: "admin" | "recording" | "start-end" | "capped" }
const liveSessionLength = (lc, manualLengths) => {
  if (lc.durationSeconds > 0) return { seconds: Math.round(lc.durationSeconds), source: "admin" };
  const fromRecording = manualLengths?.get(keyFor(lc.category, lc.youtubeVideoId));
  if (fromRecording > 0) return { seconds: Math.round(fromRecording), source: "recording" };
  const elapsed = elapsedSeconds(lc);
  if (elapsed > MAX_LIVE_SECONDS) return { seconds: MAX_LIVE_SECONDS, source: "capped" };
  return { seconds: elapsed, source: "start-end" };
};

module.exports = {
  MAX_LIVE_SECONDS,
  elapsedSeconds,
  loadManualRecordingLengths,
  liveSessionLength,
};
