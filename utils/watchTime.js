// Single source of truth for "how much did this student watch" — used by
// Video Analytics, the Attendance Report, Student Progress and the student's
// own class list, so every screen shows the same numbers.
//
// WHY THIS EXISTS (fixed 2026-10-08): the players used to report watch time
// as "how far the play position jumped" since the last report. Resuming a
// class at 2h, or dragging the progress bar forward, was counted as hours
// "watched" in one go — so a 150-minute class showed 10-17h for some
// students. The players now report:
//   - playedSeconds: real clock time the video was actually playing, and
//   - segments: which parts of the video [start, end] were played normally
//     (seeks/skips are excluded).
// From those:
//   watchedSeconds  = unique part of the video covered (never more than the
//                     video length; rewatching the same part doesn't add)
//                     -> used for Watch % and Present/Absent.
//   timeSpentSeconds = total real time spent playing (rewatching counts).
//
// Rows recorded BEFORE the fix ("legacy") only have the old inflated total.
// That can't be un-inflated exactly, so it is capped at the video length and
// flagged `estimated: true`. Once such a student watches again, the new
// accurate tracking is added on top.

// Old players (a browser tab still running the previous version) send
// deltaSecondsWatched every ~15s. A delta bigger than this was a seek/resume
// jump, not watching, so it is ignored.
const LEGACY_MAX_DELTA_SECONDS = 20;

// One ping covers at most ~15s of playing (plus a pause/close flush); this
// is a generous ceiling so a bad/forged value can't add hours.
const MAX_PLAYED_PER_PING_SECONDS = 90;

const toNumber = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// Sorted, merged [[start, end], ...] with no overlaps.
const mergeRanges = (ranges) => {
  const clean = (Array.isArray(ranges) ? ranges : [])
    .map((r) => (Array.isArray(r) ? [toNumber(r[0]), toNumber(r[1])] : null))
    .filter((r) => r && r[1] > r[0] && r[0] >= 0)
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of clean) {
    const last = merged[merged.length - 1];
    // Treat gaps of up to 1s as continuous (rounding between pings).
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
};

const coveredSeconds = (ranges) =>
  mergeRanges(ranges).reduce((sum, [s, e]) => sum + (e - s), 0);

// Validates segments sent by the player for one ping.
const sanitizeSegments = (segments, durationSeconds) => {
  if (!Array.isArray(segments)) return [];
  const maxEnd = durationSeconds > 0 ? durationSeconds + 30 : Infinity;
  return segments
    .slice(0, 50)
    .map((r) => (Array.isArray(r) ? [toNumber(r[0]), toNumber(r[1])] : null))
    .filter((r) => r && r[0] >= 0 && r[1] > r[0] && r[1] - r[0] <= 240 && r[1] <= maxEnd)
    .map(([s, e]) => [Math.round(s * 10) / 10, Math.round(e * 10) / 10]);
};

const clampPlayed = (v) => Math.max(0, Math.min(MAX_PLAYED_PER_PING_SECONDS, toNumber(v)));

const isAccurate = (row) => row && row.trackingVersion === 2;

// The pre-fix (inflated) part of a row's total.
const legacyRawSeconds = (row) =>
  isAccurate(row) ? toNumber(row.legacyWatchSeconds) : toNumber(row?.totalWatchSeconds);

// Recorded class: { watchedSeconds, timeSpentSeconds, percentWatched, estimated }
const recordedWatchStats = (row, durationSeconds) => {
  const duration = toNumber(durationSeconds);
  if (!row) return { watchedSeconds: 0, timeSpentSeconds: 0, percentWatched: 0, estimated: false };

  const legacyRaw = legacyRawSeconds(row);
  const legacyCapped = duration > 0 ? Math.min(legacyRaw, duration) : legacyRaw;
  const newPlayed = isAccurate(row) ? Math.max(0, toNumber(row.totalWatchSeconds) - legacyRaw) : 0;
  const rangesCovered = isAccurate(row) ? coveredSeconds(row.watchedRanges) : 0;

  let watched = Math.max(rangesCovered, legacyCapped);
  if (duration > 0) watched = Math.min(watched, duration);

  const percent = duration > 0 ? Math.min(100, (watched / duration) * 100) : 0;
  return {
    watchedSeconds: Math.round(watched),
    timeSpentSeconds: Math.round(legacyCapped + newPlayed),
    percentWatched: Number(percent.toFixed(1)),
    estimated: legacyRaw > 0,
  };
};

// Live class: a live stream can't be rewatched, so watched = real time
// spent playing, capped at how long the session ran.
const liveWatchStats = (row, sessionSeconds) => {
  const duration = Math.max(1, toNumber(sessionSeconds));
  if (!row) return { watchedSeconds: 0, timeSpentSeconds: 0, percentWatched: 0, estimated: false };

  const legacyRaw = legacyRawSeconds(row);
  const newPlayed = isAccurate(row) ? Math.max(0, toNumber(row.totalWatchSeconds) - legacyRaw) : 0;
  const watched = Math.min(duration, Math.min(legacyRaw, duration) + newPlayed);
  const percent = Math.min(100, (watched / duration) * 100);
  return {
    watchedSeconds: Math.round(watched),
    timeSpentSeconds: Math.round(watched),
    percentWatched: Number(percent.toFixed(1)),
    estimated: legacyRaw > 0,
  };
};

// Builds the Mongo update for one progress ping, given the current row
// (or null). Handles both the new player (v: 2) and old cached players.
const buildPingUpdate = (existingRow, body, durationSeconds, { withRanges }) => {
  const { v, positionSeconds, playedSeconds, segments, deltaSecondsWatched, newSession } = body || {};
  const set = { lastWatchedAt: new Date() };
  const inc = {};
  let newRanges = null;

  if (v === 2) {
    if (!isAccurate(existingRow)) {
      // First accurate ping for this row: freeze the old (inflated) total
      // as the legacy part, then add accurate time on top of it.
      set.trackingVersion = 2;
      set.legacyWatchSeconds = toNumber(existingRow?.totalWatchSeconds);
    }
    const played = clampPlayed(playedSeconds);
    if (played > 0) inc.totalWatchSeconds = played;
    if (withRanges) {
      const fresh = sanitizeSegments(segments, durationSeconds);
      if (fresh.length) {
        const merged = mergeRanges([...(existingRow?.watchedRanges || []), ...fresh]);
        newRanges = merged.slice(0, 1000);
      }
    }
  } else {
    // Old player still open in someone's browser: only trust small deltas.
    const delta = toNumber(deltaSecondsWatched);
    if (delta > 0 && delta <= LEGACY_MAX_DELTA_SECONDS) inc.totalWatchSeconds = delta;
  }

  if (newSession) inc.sessionCount = 1;
  if (typeof positionSeconds === "number" && positionSeconds >= 0) {
    set.lastPositionSeconds = Math.floor(positionSeconds);
  }
  if (newRanges) set.watchedRanges = newRanges;

  const update = { $set: set };
  if (Object.keys(inc).length) update.$inc = inc;
  return update;
};

module.exports = {
  mergeRanges,
  coveredSeconds,
  recordedWatchStats,
  liveWatchStats,
  buildPingUpdate,
  LEGACY_MAX_DELTA_SECONDS,
};
