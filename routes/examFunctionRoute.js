const express = require("express");
const checkExamEligibility = require("../middlewares/checkExamEligibility.js");
const requireCompletedProfile = require("../middlewares/requireCompletedProfile.js");
const {
  getEligibleExamForUser,
  manuallyPassExam,
  deletePassedExam,
} = require("../controllers/examFunctionController.js");
const {
  verifyToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware.js");
const examSubmissionSchema = require("../models/examSubmissionSchema");
const attemptCounterModel = require("../models/attemptCounterModel");
const durationModel = require("../models/durationModel");
const {
  resolveQuestionDuration,
} = require("../utils/ExamSubmissionHelper");

const router = express.Router();

router.get(
  "/eligible-exam/:userId",
  verifyToken,
  authorizeRoles("admin", "student"),
  requireCompletedProfile,
  getEligibleExamForUser
);
router.post(
  "/manually-pass-exam",
  verifyToken,
  authorizeRoles("admin"),
  manuallyPassExam
);
router.post(
  "/delete-passed-exam",
  verifyToken,
  authorizeRoles("admin"),
  deletePassedExam
);
router.post(
  "/attend-exam",
  verifyToken,
  authorizeRoles("admin", "student"),
  requireCompletedProfile,
  checkExamEligibility,
  async (req, res) => {
    try {
      const { userId } = req.body;
      const { _id: examId } = req.exam;

      // Atomic operation: Check for existing started submission OR create new one
      let submission = await examSubmissionSchema.findOne({
        userId,
        examId,
        status: "started",
      });

      // Get Duration Config
      const durationConfig = await durationModel.findById("duration-in-seconds");

      // Calculate total duration by summing each question's own resolved
      // duration (per-question override, or level-based fallback). This
      // must match the calculation in examSubmissionController.js.
      const totalDuration = req.exam.questions.reduce(
        (sum, q) => sum + resolveQuestionDuration(q, durationConfig),
        0
      );

      if (submission) {
        // Idempotent: Return existing started submission
        return res.status(200).json({
          success: true,
          message: "Exam session already active.",
          exam: req.exam,
          submissionId: submission._id,
          startTime: submission.createdAt,
          attemptNumber: submission.attemptNumber,
          serverDuration: totalDuration, // Needed for frontend timer sync
        });
      }

      // Attempt restriction: a student may normally attempt each exam only
      // once. This checks the number of already-COMPLETED submissions
      // (started-but-abandoned sessions don't count) against
      // maxAllowedAttempts, which defaults to 1 and can only be raised by
      // an admin (Controllers/Control Panel "grant second attempt") via
      // the /grant-extra-attempt route below — never by the student.
      if (req.user.role === "student") {
        const [existingCounter, completedCount] = await Promise.all([
          attemptCounterModel.findOne({ userId, examId }),
          examSubmissionSchema.countDocuments({
            userId,
            examId,
            status: "completed",
          }),
        ]);
        const maxAllowedAttempts = existingCounter?.maxAllowedAttempts ?? 1;

        if (completedCount >= maxAllowedAttempts) {
          return res.status(403).json({
            success: false,
            message:
              "You have already attempted this exam. Contact the academy if you need another attempt.",
          });
        }
      }

      // No active submission - create new one with atomic attempt counter
      // Use findOneAndUpdate with $inc for atomic counter increment
      const counter = await attemptCounterModel.findOneAndUpdate(
        { userId, examId },
        { $inc: { currentAttempt: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      // Create new submission with atomic attempt number
      submission = await examSubmissionSchema.create({
        userId,
        examId,
        attemptNumber: counter.currentAttempt,
        status: "started",
        examData: [], // Empty initially
      });

      res.status(200).json({
        success: true,
        message: "Exam started successfully.",
        exam: req.exam,
        submissionId: submission._id,
        startTime: submission.createdAt,
        attemptNumber: submission.attemptNumber,
        serverDuration: totalDuration, // Needed for frontend timer sync
      });
    } catch (error) {
      // Handle duplicate key errors (unique constraint violations)
      if (error.code === 11000) {
        // Race condition detected - fetch the existing submission
        const existingSubmission = await examSubmissionSchema.findOne({
          userId: req.body.userId,
          examId: req.exam._id,
          status: "started",
        });

        // Get Duration Config (Repeated for error case)
        const durationConfig = await durationModel.findById("duration-in-seconds");
        const totalDuration = req.exam.questions.reduce(
          (sum, q) => sum + resolveQuestionDuration(q, durationConfig),
          0
        );

        if (existingSubmission) {
          return res.status(200).json({
            success: true,
            message: "Exam session already active.",
            exam: req.exam,
            submissionId: existingSubmission._id,
            startTime: existingSubmission.createdAt,
            attemptNumber: existingSubmission.attemptNumber,
            serverDuration: totalDuration,
          });
        }
      }

      res.status(500).json({
        success: false,
        message: "Error starting exam",
        error: error.message,
      });
    }
  }
);

// Controllers / Control Panel — "first-attempt/second-attempt permission".
// Admin-only override that raises (or resets) how many attempts a specific
// student gets on a specific exam. This is the ONLY way a student can ever
// get more than the default single attempt — never available to students
// themselves.
router.patch(
  "/grant-extra-attempt",
  verifyToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { userId, examId, maxAllowedAttempts } = req.body;

      if (!userId || !examId) {
        return res.status(400).json({
          success: false,
          message: "userId and examId are required.",
        });
      }

      const parsedMax = Number(maxAllowedAttempts);
      if (!Number.isInteger(parsedMax) || parsedMax < 1) {
        return res.status(400).json({
          success: false,
          message: "maxAllowedAttempts must be a whole number of at least 1.",
        });
      }

      const counter = await attemptCounterModel.findOneAndUpdate(
        { userId, examId },
        {
          $setOnInsert: { currentAttempt: 0 },
          $set: {
            maxAllowedAttempts: parsedMax,
            grantedBy: req.user._id,
            grantedAt: new Date(),
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      res.status(200).json({
        success: true,
        message: `This student may now attempt this exam up to ${parsedMax} time(s).`,
        counter,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Failed to update attempt permission",
        error: error.message,
      });
    }
  }
);

module.exports = router;
