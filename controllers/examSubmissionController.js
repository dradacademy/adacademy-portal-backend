const { default: mongoose } = require("mongoose");
const examModel = require("../models/examModel");
const examSubmissionSchema = require("../models/examSubmissionSchema");
const userModel = require("../models/userModel");
const userPassSchema = require("../models/userPassSchema");
const sendMail = require("../utils/sendMail");
const markModel = require("../models/markModel");
const { ensureMarkConfigExists } = require("./markController");
const {
  evaluateQuestion,
  calculateMarks,
  calculateTotalPossibleMarks,
  validateMarks,
} = require("../utils/ExamSubmissionHelper");
const durationModel = require("../models/durationModel");
const { retryTransaction } = require("../utils/transactionHelper");

const getAllPassedSubmission = async (req, res) => {
  try {
    const passedData = await examSubmissionSchema
      .find({
        pass: true,
      })
      .populate({
        path: "examId",
        select: "subject subTopic level examCode passPercentage",
        populate: {
          path: "subject",
          select: "name",
        },
      })
      .populate("userId");

    for (let submission of passedData) {
      if (
        submission.examId &&
        submission.examId.subject &&
        submission.examId.subTopic
      ) {
        const subject = await mongoose
          .model("Subject")
          .findById(submission.examId.subject._id);

        const subtopic = subject.subtopics.id(submission.examId.subTopic);

        if (subtopic) {
          submission.examId._doc.subTopicName = subtopic.name;
        }
      }
    }

    res.status(200).json(passedData);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Unable to get the data",
      error: error.message,
    });
  }
};

const getPassedSubmissionForUser = async (req, res) => {
  try {
    const userId = req.params.userId;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User ID is required",
      });
    }

    if (req.user.role === "student" && req.user._id.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You do not have the required permissions",
      });
    }

    const passedData = await examSubmissionSchema
      .find({
        userId: userId,
        pass: true,
      })
      .populate({
        path: "examId",
        select: "subject subTopic level examCode passPercentage",
        populate: {
          path: "subject",
          select: "name",
        },
      });

    for (let submission of passedData) {
      if (
        submission.examId &&
        submission.examId.subject &&
        submission.examId.subTopic
      ) {
        const subject = await mongoose
          .model("Subject")
          .findById(submission.examId.subject._id);

        const subtopic = subject.subtopics.id(submission.examId.subTopic);

        if (subtopic) {
          submission.examId._doc.subTopicName = subtopic.name;
        }
      }
    }

    res.status(200).json(passedData);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Unable to get the data",
      error: error.message,
    });
  }
};

const getAllPreviousAttempt = async (req, res) => {
  try {
    const previousAttemptData = await examSubmissionSchema
      .find({
        pass: false,
      })
      .populate({
        path: "examId",
        select: "subject subTopic level examCode passPercentage",
        populate: {
          path: "subject",
          select: "name",
        },
      })
      .populate("userId")
      .sort({ createdAt: -1 });

    for (let submission of previousAttemptData) {
      if (
        submission.examId &&
        submission.examId.subject &&
        submission.examId.subTopic
      ) {
        const subject = await mongoose
          .model("Subject")
          .findById(submission.examId.subject._id);

        const subtopic = subject.subtopics.id(submission.examId.subTopic);

        if (subtopic) {
          submission.examId._doc.subTopicName = subtopic.name;
        }
      }
    }

    res.status(200).json(previousAttemptData);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Unable to get the data",
      error: error.message,
    });
  }
};

const getPreviousAttemptForUser = async (req, res) => {
  try {
    const userId = req.params.userId;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User ID is required",
      });
    }

    if (req.user.role === "student" && req.user._id.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You do not have the required permissions",
      });
    }

    const previousAttemptData = await examSubmissionSchema
      .find({
        userId: userId,
        pass: false,
      })
      .populate({
        path: "examId",
        select: "subject subTopic level examCode passPercentage",
        populate: {
          path: "subject",
          select: "name",
        },
      })
      .sort({ createdAt: -1 });

    for (let submission of previousAttemptData) {
      if (
        submission.examId &&
        submission.examId.subject &&
        submission.examId.subTopic
      ) {
        const subject = await mongoose
          .model("Subject")
          .findById(submission.examId.subject._id);

        const subtopic = subject.subtopics.id(submission.examId.subTopic);

        if (subtopic) {
          submission.examId._doc.subTopicName = subtopic.name;
        }
      }
    }

    res.status(200).json(previousAttemptData);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Unable to get the data",
      error: error.message,
    });
  }
};

const getExamSubmissionById = async (req, res) => {
  try {
    const examSubmissionId = req.params.examSubmissionId;

    if (
      !examSubmissionId ||
      !mongoose.Types.ObjectId.isValid(examSubmissionId)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid exam submission ID",
      });
    }

    const examSubmissionData = await examSubmissionSchema
      .findById(examSubmissionId)
      .populate({
        path: "examId",
        select: "subject subTopic level examCode passPercentage",
        populate: {
          path: "subject",
          select: "name",
        },
      })
      .populate({
        path: "examData",
        select: "questionType questionText options",
        populate: {
          path: "questionId",
        },
      })
      .populate({
        path: "reviews",
        populate: {
          path: "evaluator",
          select: "username email",
        },
      })
      .populate({
        path: "userId",
        select: "email username role",
      });

    if (!examSubmissionData) {
      return res.status(404).json({
        success: false,
        message: "Exam submission not found",
      });
    }

    if (
      req.user.role === "student" &&
      req.user._id.toString() !== examSubmissionData.userId._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You do not have the required permissions",
      });
    }

    if (
      examSubmissionData.examId &&
      examSubmissionData.examId.subject &&
      examSubmissionData.examId.subTopic
    ) {
      const subject = await mongoose
        .model("Subject")
        .findById(examSubmissionData.examId.subject._id);

      if (subject && subject.subtopics) {
        const subtopic = subject.subtopics.id(
          examSubmissionData.examId.subTopic
        );

        if (subtopic) {
          // Create _doc property if it doesn't exist
          if (!examSubmissionData.examId._doc) {
            examSubmissionData.examId._doc = {};
          }
          examSubmissionData.examId._doc.subTopicName = subtopic.name;
        }
      }
    }

    return res.status(200).json(examSubmissionData);
  } catch (error) {
    console.error("Error getting exam submission:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to get the data",
      error: error.message,
    });
  }
};

const submitExam = async (req, res) => {
  try {
    const { submissionData } = req.body;

    if (!submissionData || !submissionData.userId || !submissionData.examId) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid submission data" });
    }

    // Execute entire submission within a transaction
    const result = await retryTransaction(async (session) => {
      // 1. Find and lock the STARTED submission atomically
      const existingSubmission = await examSubmissionSchema.findOneAndUpdate(
        {
          userId: submissionData.userId,
          examId: submissionData.examId,
          status: "started",
        },
        { status: "processing" }, // Lock to prevent concurrent submissions
        { session, new: false } // Return original document
      );

      if (!existingSubmission) {
        throw new Error("NO_ACTIVE_SESSION");
      }

      // 2. Get exam details
      let examDetails = await examModel
        .findById(submissionData.examId)
        .populate({
          path: "subject",
          select: "name subtopics",
        })
        .populate("questions")
        .session(session);

      if (examDetails && examDetails.subject) {
        const subtopic = examDetails.subject.subtopics.find((sub) =>
          sub._id.equals(examDetails.subTopic)
        );

        examDetails = examDetails.toObject();
        examDetails.subTopic = subtopic ? subtopic._id : examDetails.subTopic;
        examDetails.subTopic.name = subtopic ? subtopic.name : null;
      }

      if (!examDetails) {
        throw new Error("EXAM_NOT_FOUND");
      }

      // 3. Server-side Duration Check (NEVER trust client time)
      const durationConfig = await durationModel
        .findById("duration-in-seconds")
        .session(session);
      let perQuestionDuration = 0;
      if (durationConfig) {
        if (examDetails.level === 1)
          perQuestionDuration = durationConfig.level1Duration;
        else if (examDetails.level === 2)
          perQuestionDuration = durationConfig.level2Duration;
        else if (examDetails.level === 3)
          perQuestionDuration = durationConfig.level3Duration;
        else if (examDetails.level === 4)
          perQuestionDuration = durationConfig.level4Duration;
      }

      // Fallback if config missing
      if (!perQuestionDuration) perQuestionDuration = 3600; // Default 1 hour

      // CRITICAL FIX: Calculate TOTAL exam duration (not per-question)
      // This must match the frontend calculation in examFunctionRoute.js
      const allowedDuration = examDetails.questions.length * perQuestionDuration;

      const startTime = new Date(existingSubmission.createdAt).getTime();
      const currentTime = Date.now();
      const timeTakenSeconds = Math.floor((currentTime - startTime) / 1000);
      const GRACE_PERIOD_SECONDS = Math.max(allowedDuration * 0.1, 300); // 10% grace or 5 min minimum

      if (timeTakenSeconds > allowedDuration + GRACE_PERIOD_SECONDS) {
        // Time limit exceeded significantly
        // Instead of rejecting, we ACCEPT it as a forced submission (auto-submit)
        // But we cap the time and maybe flag it if needed.
        // This ensures the student isn't locked out.
        console.log(`Submission accepted with timeout: ${timeTakenSeconds}s > ${allowedDuration}s`);
        
        // Cap the time for the record
        // We do NOT return or throw error. We proceed to grade what they have.
      }

      // 4. Get mark configuration
      const mark = await markModel
        .findById("mark-based-on-levels")
        .session(session);
      if (!mark) {
        await ensureMarkConfigExists();
      }

      let positiveMark = mark.level1Mark,
        negativeMark = mark.level1NegativeMark;

      if (examDetails.level === 2) {
        positiveMark = mark.level2Mark;
        negativeMark = mark.level2NegativeMark;
      } else if (examDetails.level === 3) {
        positiveMark = mark.level3Mark;
        negativeMark = mark.level3NegativeMark;
      } else if (examDetails.level === 4) {
        positiveMark = mark.level4Mark;
        negativeMark = mark.level4NegativeMark;
      }

      // 5. Create question lookup map ONCE (O(n) instead of O(n²))
      const questionMap = new Map(
        examDetails.questions.map((q) => [q._id.toString(), q])
      );

      // 6. Evaluate answers (O(n) with Map lookup)
      const enhancedExamData = submissionData.examData.map((studQuestion) => {
        const question = questionMap.get(studQuestion.questionId); // O(1) lookup!
        if (!question) return studQuestion;
        return evaluateQuestion(question, studQuestion);
      });

      // 7. Calculate marks (O(n) with Map lookup)
      const studentObtainedMarks = submissionData.examData.reduce(
        (total, studQuestion) => {
          const question = questionMap.get(studQuestion.questionId); // O(1) lookup!
          if (!question) return total;

          return (
            total +
            calculateMarks(question, studQuestion, positiveMark, negativeMark)
          );
        },
        0
      );

      // 8. Calculate total possible marks and pass mark (FIXED FORMULA)
      const totalPossibleMarks = calculateTotalPossibleMarks(
        submissionData.examData.length,
        positiveMark
      );
      const passMark = (examDetails.passPercentage / 100) * totalPossibleMarks;

      // 8. Validate marks (prevent negative or exceeding maximum)
      const validatedMarks = validateMarks(
        studentObtainedMarks,
        totalPossibleMarks
      );

      // 9. Calculate server-side time taken (cap at allowed duration)
      const serverTimeTaken = Math.min(timeTakenSeconds, allowedDuration);

      // 10. Update submission
      existingSubmission.timetaken = serverTimeTaken;
      existingSubmission.obtainedMark = Number(validatedMarks.toFixed(2));
      existingSubmission.examData = enhancedExamData;
      existingSubmission.pass = validatedMarks >= passMark;
      existingSubmission.status = "completed";

      await existingSubmission.save({ session });

      // 11. Send email notification if attempt >= 5 and failed
      if (existingSubmission.attemptNumber >= 5 && !existingSubmission.pass) {
        // Email sending is async and non-critical, do it outside transaction
        // Store flag to send email after transaction commits
        existingSubmission._shouldNotifyEvaluators = true;
      }

      // 12. Create/Update UserPass record if passed (use upsert to prevent duplicates)
      if (existingSubmission.pass) {
        await userPassSchema.findOneAndUpdate(
          {
            userId: submissionData.userId,
            subject: examDetails.subject,
            subTopic: examDetails.subTopic,
            level: examDetails.level,
          },
          { pass: true },
          { upsert: true, session }
        );
      }

      return {
        submission: existingSubmission,
        examDetails: examDetails,
      };
    });

    // Send email notification outside transaction (non-critical)
    if (result.submission._shouldNotifyEvaluators) {
      // Move to background - don't block response
      setImmediate(async () => {
        try {
          const evaluators = await userModel
            .find({ role: "evaluator" })
            .select("email");
          const evaluatorEmails = evaluators.map((e) => e.email);

          if (evaluatorEmails.length > 0) {
            const userDetail = await userModel.findById(submissionData.userId);

            const subject = `Student Repeated Exam Attempts: ${userDetail.username}`;
            const text = `The user ${userDetail.username} (Email: ${userDetail.email}) has attempted the exam ${result.submission.attemptNumber} times but has not yet passed. Exam Details: Subject - ${result.examDetails.subject.name}, Subtopic - ${result.examDetails.subTopic.name}, Level - ${result.examDetails.level}.`;
            const html = `
            <h2>Exam Attempt Alert</h2>
            <p>The student <strong>${userDetail.username}</strong> has attempted the exam <strong>${result.submission.attemptNumber} times</strong> but has not yet passed.</p>
            <h3>Exam Details:</h3>
            <ul>
              <li><strong>Subject:</strong> ${result.examDetails.subject.name}</li>
              <li><strong>Subtopic:</strong> ${result.examDetails.subTopic.name}</li>
              <li><strong>Level:</strong> ${result.examDetails.level}</li>
            </ul>
            <p>Please review the student's progress.</p>
          `;

            await sendMail(evaluatorEmails, subject, text, html);
          }
        } catch (emailError) {
          console.error("Failed to send evaluator notification:", emailError);
          // Email failure doesn't affect submission success
        }
      });
    }

    res.status(200).json({
      success: true,
      message: "Exam submitted successfully",
      submittedData: result.submission,
    });
  } catch (error) {
    console.error("Submission error:", error);

    // Handle specific error cases
    if (error.message === "NO_ACTIVE_SESSION") {
      return res.status(400).json({
        success: false,
        message: "No active exam session found. Please start the exam again.",
      });
    }

    if (error.message === "EXAM_NOT_FOUND") {
      return res.status(404).json({
        success: false,
        message: "Exam not found",
      });
    }

    if (error.message === "TIME_LIMIT_EXCEEDED") {
      return res.status(400).json({
        success: false,
        message: "Submission rejected: Time limit exceeded.",
      });
    }

    // Handle duplicate key errors (unique constraint violations)
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message:
          "Duplicate submission detected. This exam has already been submitted.",
      });
    }

    res.status(500).json({
      success: false,
      message: "Unable to submit the exam",
      error: error.message,
    });
  }
};

const submitReviewForExamSubmission = async (req, res) => {
  try {
    const { examSubmissionId, userId, message } = req.body;

    if (!examSubmissionId || !userId || !message) {
      return res.status(500).json({
        success: false,
        message: "Need the evaluator Id, Exam Submission Id and the message",
      });
    }

    const updatedExamSubmission = await examSubmissionSchema
      .findByIdAndUpdate(
        examSubmissionId,
        { $push: { reviews: { evaluator: userId, message } } },
        { new: true }
      )
      .populate("reviews.evaluator", "username email")
      .populate({
        path: "examId",
        select: "subject subTopic level examCode passPercentage",
        populate: {
          path: "subject",
          select: "name",
        },
      })
      .populate({
        path: "userId",
        select: "email username role",
      })
      .populate({
        path: "examData",
        select: "questionType questionText options",
        populate: {
          path: "questionId",
        },
      });

    if (!updatedExamSubmission) {
      return res.status(404).json({
        success: false,
        message: "Exam Submission not found",
      });
    }

    return res.status(201).json({
      success: true,
      message: "Added the Comment Successfully",
      examSubmission: updatedExamSubmission,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Unable to add comment for the exam",
    });
  }
};

const updateCommentInExamSubmission = async (req, res) => {
  try {
    const { examId, reviewId } = req.params;
    const { message } = req.body;

    if (!examId || !reviewId || !message) {
      return res.status(400).json({
        success: false,
        message: "The Exam, Review Id and Message is needed",
      });
    }

    const existingSubmission = await examSubmissionSchema.findById(examId);
    if (!existingSubmission) {
      return res.status(404).json({
        success: false,
        message: "Exam Submission not found",
      });
    }

    const updatedComment = await examSubmissionSchema
      .findOneAndUpdate(
        { _id: examId, "reviews._id": reviewId },
        { $set: { "reviews.$.message": message } },
        { new: true }
      )
      .populate("reviews.evaluator", "username email")
      .populate({
        path: "examId",
        select: "subject subTopic level examCode passPercentage",
        populate: {
          path: "subject",
          select: "name",
        },
      })
      .populate({
        path: "userId",
        select: "email username role",
      })
      .populate({
        path: "examData",
        select: "questionType questionText options",
        populate: {
          path: "questionId",
        },
      });

    if (!updatedComment) {
      return res.status(404).json({
        success: false,
        message: "Exam Submission not found",
      });
    }

    return res.status(201).json({
      success: true,
      message: "Updated the Comment Successfully",
      examSubmission: updatedComment,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Unable to update the Comment",
    });
  }
};

const deleteCommentInExamSubmission = async (req, res) => {
  try {
    const { examId, reviewId } = req.params;

    if (!examId || !reviewId) {
      return res.status(500).json({
        success: false,
        message: "The Exam and Review Id is needed",
      });
    }

    const existingSubmission = await examSubmissionSchema.findById(examId);
    if (!existingSubmission) {
      return res.status(404).json({
        success: false,
        message: "Exam Submission not found",
      });
    }

    const deletedComment = await examSubmissionSchema
      .findByIdAndUpdate(
        examId,
        { $pull: { reviews: { _id: reviewId } } },
        { new: true }
      )
      .populate("reviews.evaluator", "username email")
      .populate({
        path: "examId",
        select: "subject subTopic level examCode passPercentage",
        populate: {
          path: "subject",
          select: "name",
        },
      })
      .populate({
        path: "userId",
        select: "email username role",
      })
      .populate({
        path: "examData",
        select: "questionType questionText options",
        populate: {
          path: "questionId",
        },
      });

    if (!deletedComment) {
      return res.status(404).json({
        success: false,
        message: "Exam Submission not found",
      });
    }

    return res.status(201).json({
      success: true,
      message: "Deleted the Comment Successfully",
      examSubmission: deletedComment,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Unable to delete the Comment",
    });
  }
};

module.exports = {
  getAllPassedSubmission,
  getPassedSubmissionForUser,
  getAllPreviousAttempt,
  getPreviousAttemptForUser,
  getExamSubmissionById,
  submitExam,
  submitReviewForExamSubmission,
  updateCommentInExamSubmission,
  deleteCommentInExamSubmission,
};
