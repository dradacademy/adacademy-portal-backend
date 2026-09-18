// Shared attendance-status thresholds, used everywhere a watch percentage
// needs to become a Present/Partially Watched/Absent verdict — recorded
// video progress, live class progress, the admin attendance report, and
// the "video completion" figure on the Student Progress dashboard all call
// this SAME function, so the numbers never drift out of sync with each
// other. Per the admin's exact spec (2026-09-18):
//   >= 75% watched  -> Present
//   50% - 74%       -> Partially Watched
//   <  50%          -> Absent
const ATTENDANCE_PRESENT_THRESHOLD = 75;
const ATTENDANCE_PARTIAL_THRESHOLD = 50;

const getAttendanceStatus = (watchPercent) => {
  const pct = Number(watchPercent) || 0;
  if (pct >= ATTENDANCE_PRESENT_THRESHOLD) return "Present";
  if (pct >= ATTENDANCE_PARTIAL_THRESHOLD) return "Partially Watched";
  return "Absent";
};

// "Completed" for the Student Progress dashboard's video-completion count
// deliberately reuses the same Present threshold — one definition of
// "actually watched this video" everywhere, rather than a second,
// independent cutoff that could disagree with the attendance report.
const isVideoComplete = (watchPercent) =>
  getAttendanceStatus(watchPercent) === "Present";

module.exports = {
  ATTENDANCE_PRESENT_THRESHOLD,
  ATTENDANCE_PARTIAL_THRESHOLD,
  getAttendanceStatus,
  isVideoComplete,
};
