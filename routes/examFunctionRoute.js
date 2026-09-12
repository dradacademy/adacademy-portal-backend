const express = require("express");
const checkExamEligibility = require("../middlewares/checkExamEligibility.js");
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

module.exports = router;
