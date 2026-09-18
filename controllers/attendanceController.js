const videoProgressModel = require("../models/videoProgressModel");
const recordedClassModel = require("../models/recordedClassModel");
const liveAttendanceModel = require("../models/liveAttendanceModel");
const liveClassModel = require("../models/liveClassModel");
const { getAttendanceStatus } = require("../utils/attendanceHelper");

// GET /api/attendance/report (admin only) — the combined report the admin
// asked for: "Student Name | Video Name | Video Duration | Watched Time |
// Watch % | Attendance Status", across BOTH recorded classes and live
// classes (a `sessionType` column tells them apart). Attendance is never
// manually set anywhere — every row here is derived live from actual
// watch-time counters (videoProgressModel / liveAttendanceModel), so this
// report and the automatic status always agree by construction. Optional
// ?category= filter; export is left to the frontend (build a CSV from
// this same JSON) rather than a separate backend endpoint.
const getAttendanceReport = async (req, res) => {
  try {
    const { category } = req.query;

    const recordedFilter = category ? { category } : {};
    const recordedClasses = await recordedClassModel
      .find(recordedFilter)
      .select("title category durationSeconds");
    const recordedClassById = new Map(
      recordedClasses.map((rc) => [rc._id.toString(), rc])
    );
    const recordedClassIds = recordedClasses.map((rc) => rc._id);

    const recordedProgressRows = await videoProgressModel
      .find({ videoId: { $in: recordedClassIds } })
      .populate("userId", "username email category");

    const recordedRows = recordedProgressRows
      .filter((row) => row.userId && recordedClassById.has(row.videoId.toString()))
      .map((row) => {
        const video = recordedClassById.get(row.videoId.toString());
        const durationSeconds = video.durationSeconds || 0;
        const watchPercent = durationSeconds
          ? Math.min(100, (row.totalWatchSeconds / durationSeconds) * 100)
          : 0;

        return {
          sessionType: "Recorded",
          studentId: row.userId._id,
          studentName: row.userId.username,
          studentEmail: row.userId.email,
          contentId: video._id,
          contentTitle: video.title,
          durationSeconds,
          watchedSeconds: row.totalWatchSeconds,
          watchPercent: Number(watchPercent.toFixed(1)),
          attendanceStatus: durationSeconds
            ? getAttendanceStatus(watchPercent)
            : "—", // no duration entered yet — can't compute a percentage
          lastWatchedAt: row.lastWatchedAt,
        };
      });

    const liveFilter = category ? { category } : {};
    const liveClasses = await liveClassModel.find(liveFilter).select(
      "title category startedAt endedAt active"
    );
    const liveClassById = new Map(liveClasses.map((lc) => [lc._id.toString(), lc]));
    const liveClassIds = liveClasses.map((lc) => lc._id);

    const liveAttendanceRows = await liveAttendanceModel
      .find({ liveClassId: { $in: liveClassIds } })
      .populate("userId", "username email category");

    const liveRows = liveAttendanceRows
      .filter((row) => row.userId && liveClassById.has(row.liveClassId.toString()))
      .map((row) => {
        const liveClass = liveClassById.get(row.liveClassId.toString());
        const durationSeconds = liveClass.getElapsedSeconds();
        const watchPercent = Math.min(
          100,
          (row.totalWatchSeconds / durationSeconds) * 100
        );

        return {
          sessionType: "Live",
          studentId: row.userId._id,
          studentName: row.userId.username,
          studentEmail: row.userId.email,
          contentId: liveClass._id,
          contentTitle: liveClass.title,
          durationSeconds,
          watchedSeconds: row.totalWatchSeconds,
          watchPercent: Number(watchPercent.toFixed(1)),
          attendanceStatus: getAttendanceStatus(watchPercent),
          lastWatchedAt: row.lastWatchedAt,
        };
      });

    const data = [...liveRows, ...recordedRows].sort(
      (a, b) => new Date(b.lastWatchedAt || 0) - new Date(a.lastWatchedAt || 0)
    );

    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to build attendance report.",
      error: error.message,
    });
  }
};

module.exports = {
  getAttendanceReport,
};
