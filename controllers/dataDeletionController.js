const mongoose = require("mongoose");
const examModel = require("../models/examModel");
const userModel = require("../models/userModel");
const examSubmissionSchema = require("../models/examSubmissionSchema");
const attemptCounterModel = require("../models/attemptCounterModel");
const examPassModel = require("../models/examPassModel");
const answerSheetModel = require("../models/answerSheetModel");
const attachmentProgressModel = require("../models/attachmentProgressModel");
const videoProgressModel = require("../models/videoProgressModel");
const liveAttendanceModel = require("../models/liveAttendanceModel");
const { deleteFile } = require("../utils/gridfsHelper");
const { retryTransaction } = require("../utils/transactionHelper");

// Both actions below are highly destructive and irreversible, so both are:
//   (a) admin-only (enforced at the route level),
//   (b) gated on an explicit `confirm: true` in the request body as a
//       server-side backstop behind the frontend's own two sequential
//       Yes/No confirmation popups — a stray/duplicate click that somehow
//       skips the UI confirmation flow still can't trigger a real delete,
//   (c) transactional for every Mongo collection touched, so a mid-way
//       failure never leaves a partial wipe behind,
//   (d) scoped to leave everything else completely untouched — see each
//       function's comment for exactly what is (and is NOT) deleted.

// POST /api/data-deletion/delete-exam-history
// Wipes every student's attempt history for ONE exam — every submission
// (i.e. every stored mark), attempt counter, pass record, and uploaded
// answer sheet (+ its GridFS images) tied to that examId, across ALL
// students who ever attempted it. The exam itself (its questions, config,
// schedule, examCode, order) is left completely untouched, so it remains
// postable/attemptable fresh by anyone afterwards.
const deleteExamHistory = async (req, res) => {
  try {
    const { examId, confirm } = req.body;

    if (!examId) {
      return res.status(400).json({
        success: false,
        message: "examId is required.",
      });
    }
    if (!mongoose.Types.ObjectId.isValid(examId)) {
      return res.status(400).json({
        success: false,
        message: "examId is not a valid id.",
      });
    }
    if (confirm !== true) {
      return res.status(400).json({
        success: false,
        message:
          "This is a permanent, irreversible delete. Resubmit with confirm: true after the admin has confirmed twice.",
      });
    }

    const exam = await examModel.findById(examId).select("_id examCode order");
    if (!exam) {
      return res.status(404).json({
        success: false,
        message: "Exam not found.",
      });
    }

    // GridFS bucket operations don't accept a Mongo session, so the file
    // cleanup happens outside the transaction — same ordering as the
    // existing single-record deleteAnswerSheet in answerSheetController.js
    // (delete the blobs first, then the metadata rows). deleteFile() itself
    // swallows "already deleted"/missing-file errors, so this is safe even
    // if it's re-run after a partial prior failure.
    const answerSheets = await answerSheetModel
      .find({ examId })
      .select("images");
    const gridFsFileIds = answerSheets.flatMap((sheet) =>
      sheet.images.map((img) => img.gridFsFileId)
    );
    await Promise.all(gridFsFileIds.map((fileId) => deleteFile(fileId)));

    const counts = await retryTransaction(async (session) => {
      const [submissions, counters, passes, sheets] = await Promise.all([
        examSubmissionSchema.deleteMany({ examId }, { session }),
        attemptCounterModel.deleteMany({ examId }, { session }),
        examPassModel.deleteMany({ examId }, { session }),
        answerSheetModel.deleteMany({ examId }, { session }),
      ]);
      return {
        submissions: submissions.deletedCount,
        attemptCounters: counters.deletedCount,
        passRecords: passes.deletedCount,
        answerSheets: sheets.deletedCount,
      };
    });

    res.status(200).json({
      success: true,
      message: `Deleted all history for exam ${exam.examCode} (Order ${exam.order}): ${counts.submissions} submission(s)/mark(s), ${counts.attemptCounters} attempt counter(s), ${counts.passRecords} pass record(s), ${counts.answerSheets} answer sheet(s). The exam itself is untouched and can be attempted fresh.`,
      counts,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to delete exam history.",
      error: error.message,
    });
  }
};

// POST /api/data-deletion/delete-student-history
// Wipes ONE student's activity history across EVERY exam/content — every
// submission (mark), attempt counter, pass record, uploaded answer sheet
// (+ GridFS images), attachment-view record, video-watch-progress record,
// and live-class-attendance record tied to that userId. The student's User
// account, login, StudentProfile, and Enrollment record(s) are left
// completely untouched, so they keep logging in with a clean activity
// slate rather than being deleted or locked out.
const deleteStudentHistory = async (req, res) => {
  try {
    const { userId, confirm } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required.",
      });
    }
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        message: "userId is not a valid id.",
      });
    }
    if (confirm !== true) {
      return res.status(400).json({
        success: false,
        message:
          "This is a permanent, irreversible delete. Resubmit with confirm: true after the admin has confirmed twice.",
      });
    }

    const student = await userModel.findById(userId).select("_id username email role");
    if (!student) {
      return res.status(404).json({
        success: false,
        message: "Student not found.",
      });
    }
    if (student.role !== "student") {
      return res.status(400).json({
        success: false,
        message: "This account is not a student account.",
      });
    }

    const answerSheets = await answerSheetModel
      .find({ userId })
      .select("images");
    const gridFsFileIds = answerSheets.flatMap((sheet) =>
      sheet.images.map((img) => img.gridFsFileId)
    );
    await Promise.all(gridFsFileIds.map((fileId) => deleteFile(fileId)));

    const counts = await retryTransaction(async (session) => {
      const [
        submissions,
        counters,
        passes,
        sheets,
        attachmentViews,
        videoProgress,
        attendance,
      ] = await Promise.all([
        examSubmissionSchema.deleteMany({ userId }, { session }),
        attemptCounterModel.deleteMany({ userId }, { session }),
        examPassModel.deleteMany({ userId }, { session }),
        answerSheetModel.deleteMany({ userId }, { session }),
        attachmentProgressModel.deleteMany({ userId }, { session }),
        videoProgressModel.deleteMany({ userId }, { session }),
        liveAttendanceModel.deleteMany({ userId }, { session }),
      ]);
      return {
        submissions: submissions.deletedCount,
        attemptCounters: counters.deletedCount,
        passRecords: passes.deletedCount,
        answerSheets: sheets.deletedCount,
        attachmentViews: attachmentViews.deletedCount,
        videoProgress: videoProgress.deletedCount,
        liveAttendance: attendance.deletedCount,
      };
    });

    res.status(200).json({
      success: true,
      message: `Deleted all history for ${student.username} (${student.email}): ${counts.submissions} submission(s)/mark(s), ${counts.attemptCounters} attempt counter(s), ${counts.passRecords} pass record(s), ${counts.answerSheets} answer sheet(s), ${counts.attachmentViews} attachment-view record(s), ${counts.videoProgress} video-progress record(s), ${counts.liveAttendance} attendance record(s). Their account, profile, and enrollment are untouched.`,
      counts,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to delete student history.",
      error: error.message,
    });
  }
};

module.exports = {
  deleteExamHistory,
  deleteStudentHistory,
};
