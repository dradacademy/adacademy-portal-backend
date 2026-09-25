const mongoose = require("mongoose");
const ExamSubmission = require("../models/examSubmissionSchema");
const User = require("../models/userModel");
const Exam = require("../models/examModel");
const Subject = require("../models/subjectModel");
const markModel = require("../models/markModel");
const attemptCounterModel = require("../models/attemptCounterModel");
const examPassModel = require("../models/examPassModel");
const videoProgressModel = require("../models/videoProgressModel");
const {
  calculateTotalPossibleMarks,
} = require("../utils/ExamSubmissionHelper");
const {
  getLatestAttemptsOnly,
  latestAttemptOnlyStages,
} = require("../utils/latestAttemptHelper");

// Get all exams overview
const getAllExamsOverview = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    // Admin's category-organized workflow: optionally scope this whole
    // overview to one exam category (GATE / TNPSC AE / TNPSC JDO /
    // SSC JE-RRB JE) instead of seeing every category mixed together.
    const examMatch = {};
    if (req.query.category) {
      const subjectIdsInCategory = await Subject.find({
        category: req.query.category,
      }).distinct("_id");
      examMatch.subject = { $in: subjectIdsInCategory };
    }

    // Single aggregation instead of N+1. Note: this intentionally shows
    // exams of every status (not just "active") — an admin managing exams
    // (publish/unpublish, item D "exam status") needs to see inactive ones
    // too, with their status displayed, rather than have them silently
    // disappear from the dashboard.
    const [examsData, totalCount] = await Promise.all([
      Exam.aggregate([
        { $match: examMatch },
        { $sort: { createdAt: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $lookup: {
            from: "subjects",
            localField: "subject",
            foreignField: "_id",
            as: "subjectData",
          },
        },
        { $unwind: { path: "$subjectData", preserveNullAndEmptyArrays: true } },
        {
          // "Last attempt only" rule: this $lookup pipeline reduces every
          // student's submissions for this exam down to their single most
          // recent attempt (highest attemptNumber) BEFORE any of the
          // completed/passed/marks counting below runs, so a student who
          // failed attempt 1 and passed attempt 2 counts once, as passed —
          // not twice, once each way. See utils/latestAttemptHelper.js for
          // the equivalent plain-array helper used elsewhere.
          $lookup: {
            from: "examsubmissions",
            let: { examId: "$_id" },
            pipeline: [
              { $match: { $expr: { $eq: ["$examId", "$$examId"] } } },
              { $sort: { userId: 1, attemptNumber: -1 } },
              { $group: { _id: "$userId", doc: { $first: "$$ROOT" } } },
              { $replaceRoot: { newRoot: "$doc" } },
            ],
            as: "submissions",
          },
        },
        {
          $project: {
            _id: 1,
            examCode: 1,
            order: 1,
            status: 1,
            subTopic: 1,
            "subjectData._id": 1,
            "subjectData.name": 1,
            "subjectData.category": 1,
            "subjectData.subtopics": 1,
            totalSubmissions: { $size: "$submissions" },
            completedSubmissions: {
              $filter: {
                input: "$submissions",
                as: "sub",
                cond: { $eq: ["$$sub.status", "completed"] },
              },
            },
            inProgressCount: {
              $size: {
                $filter: {
                  input: "$submissions",
                  as: "sub",
                  cond: { $ne: ["$$sub.status", "completed"] },
                },
              },
            },
            passedStudents: {
              $size: {
                $filter: {
                  input: "$submissions",
                  as: "sub",
                  cond: { $eq: ["$$sub.pass", true] },
                },
              },
            },
          },
        },
        {
          $addFields: {
            completedCount: { $size: "$completedSubmissions" },
            // Marks stats are computed from COMPLETED submissions only —
            // an in-progress submission's obtainedMark is always still 0,
            // and including it would silently drag avgScore/lowestMark
            // down for no real reason.
            marks: {
              $map: {
                input: "$completedSubmissions",
                as: "sub",
                in: { $ifNull: ["$$sub.obtainedMark", 0] },
              },
            },
          },
        },
        {
          $addFields: {
            qualifiedCount: "$passedStudents",
            notQualifiedCount: {
              $subtract: ["$completedCount", "$passedStudents"],
            },
            avgScore: {
              $cond: {
                if: { $gt: ["$completedCount", 0] },
                then: { $avg: "$marks" },
                else: 0,
              },
            },
            passRate: {
              $cond: {
                if: { $gt: ["$completedCount", 0] },
                then: {
                  $multiply: [
                    { $divide: ["$passedStudents", "$completedCount"] },
                    100,
                  ],
                },
                else: 0,
              },
            },
            highestMark: {
              $cond: {
                if: { $gt: ["$completedCount", 0] },
                then: { $max: "$marks" },
                else: 0,
              },
            },
            lowestMark: {
              $cond: {
                if: { $gt: ["$completedCount", 0] },
                then: { $min: "$marks" },
                else: 0,
              },
            },
          },
        },
        {
          $project: {
            _id: 1,
            examCode: 1,
            status: 1,
            subject: {
              _id: "$subjectData._id",
              name: "$subjectData.name",
              category: "$subjectData.category",
            },
            subTopic: {
              $let: {
                vars: {
                  subtopicObj: {
                    $arrayElemAt: [
                      {
                        $filter: {
                          input: "$subjectData.subtopics",
                          as: "st",
                          cond: { $eq: ["$$st._id", "$subTopic"] },
                        },
                      },
                      0,
                    ],
                  },
                },
                in: {
                  _id: "$$subtopicObj._id",
                  name: "$$subtopicObj.name",
                },
              },
            },
            order: 1,
            totalSubmissions: 1,
            completedCount: 1,
            inProgressCount: 1,
            qualifiedCount: 1,
            notQualifiedCount: 1,
            avgScore: { $round: ["$avgScore", 2] },
            passRate: { $round: ["$passRate", 2] },
            highestMark: 1,
            lowestMark: 1,
          },
        },
      ]),
      Exam.countDocuments(examMatch),
    ]);

    // Calculate overall statistics
    const totalStudents = examsData.reduce(
      (sum, exam) => sum + exam.totalSubmissions,
      0,
    );
    const overallAvgScore =
      examsData.length > 0
        ? examsData.reduce((sum, exam) => sum + exam.avgScore, 0) /
          examsData.length
        : 0;
    const overallPassRate =
      examsData.length > 0
        ? examsData.reduce((sum, exam) => sum + exam.passRate, 0) /
          examsData.length
        : 0;

    res.status(200).json({
      success: true,
      data: {
        exams: examsData,
        statistics: {
          totalStudents,
          overallAvgScore: parseFloat(overallAvgScore.toFixed(2)),
          overallPassRate: parseFloat(overallPassRate.toFixed(2)),
          totalExams: totalCount,
        },
        pagination: {
          page,
          limit,
          totalPages: Math.ceil(totalCount / limit),
          hasMore: page * limit < totalCount,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching exams overview:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching exams overview",
      error: error.message,
    });
  }
};

// Get detailed exam analysis
const getExamDetailedAnalysis = async (req, res) => {
  try {
    const { examId } = req.params;

    // 1️⃣ Fetch exam with subject + embedded subtopics
    const exam = await Exam.findById(examId)
      .populate("subject", "name subtopics")
      .populate("questions")
      .lean();

    if (!exam) {
      return res.status(404).json({
        success: false,
        message: "Exam not found",
      });
    }

    if (!exam.subject) {
      return res.status(422).json({
        success: false,
        message: `Exam "${exam.examCode}" references a deleted subject. Please reassign or remove this exam.`,
      });
    }

    // 2️⃣ Resolve exam-level subTopic manually
    const examSubTopic =
      exam.subject?.subtopics?.find(
        (st) => st._id.toString() === exam.subTopic?.toString(),
      ) || null;

    // 3️⃣ Fetch submissions — "last attempt only" rule: every stat, rank,
    // and count below is computed from each student's single most recent
    // attempt on this exam, not every attempt they've ever made.
    const rawSubmissions = await ExamSubmission.find({ examId })
      .populate("userId", "username email")
      .populate(
        "examData.questionId",
        "question subTopic questionType correctAnswer",
      )
      .lean();
    const submissions = getLatestAttemptsOnly(rawSubmissions);

    // Fetch mark configuration
    const markData = await markModel.findById("mark-based-on-levels");
    if (!markData) {
      throw new Error("Mark configuration not found");
    }

    // Total possible marks for this exam, summed per-question (each
    // question may override marks individually; falls back to the
    // level-based config otherwise). Exams no longer carry one uniform
    // level/mark, so this replaces the old single `positiveMark` value.
    const totalPossibleMarks = calculateTotalPossibleMarks(
      exam.questions || [],
      markData
    );

    /* =======================
       A. EXAM SUMMARY
    ======================= */
    const totalSubmission = submissions.length;
    const marks = submissions.map((s) => s.obtainedMark || 0);

    const highestMark = totalSubmission > 0 ? Math.max(...marks) : 0;
    const lowestMark = totalSubmission > 0 ? Math.min(...marks) : 0;
    const averageMark =
      totalSubmission > 0
        ? marks.reduce((a, b) => a + b, 0) / totalSubmission
        : 0;

    /* =======================
       B. PERFORMANCE DISTRIBUTION
    ======================= */
    const above75 = submissions.filter((s) => {
      return totalPossibleMarks > 0
        ? (s.obtainedMark / totalPossibleMarks) * 100 > 75
        : false;
    }).length;

    const between50_75 = submissions.filter((s) => {
      const percentage =
        totalPossibleMarks > 0
          ? (s.obtainedMark / totalPossibleMarks) * 100
          : 0;
      return percentage >= 50 && percentage <= 75;
    }).length;

    const below50 = submissions.filter((s) => {
      return totalPossibleMarks > 0
        ? (s.obtainedMark / totalPossibleMarks) * 100 < 50
        : true;
    }).length;

    const performanceDistribution = {
      above75: {
        count: above75,
        percentage:
          totalSubmission > 0
            ? Number(((above75 / totalSubmission) * 100).toFixed(1))
            : 0,
      },
      between50_75: {
        count: between50_75,
        percentage:
          totalSubmission > 0
            ? Number(((between50_75 / totalSubmission) * 100).toFixed(1))
            : 0,
      },
      below50: {
        count: below50,
        percentage:
          totalSubmission > 0
            ? Number(((below50 / totalSubmission) * 100).toFixed(1))
            : 0,
      },
    };

    /* =======================
       C. TOP PERFORMERS
    ======================= */
    const topPerformers = [...submissions]
      .sort((a, b) => b.obtainedMark - a.obtainedMark)
      .slice(0, 5)
      .map((sub, index) => ({
        rank: index + 1,
        name: sub.userId?.username || "Unknown",
        email: sub.userId?.email || "N/A",
        marks: sub.obtainedMark,
      }));

    /* =======================
       C2. FULL PER-STUDENT PERFORMANCE (Exam → Students → Individual
       Performance drill-down). Unlike topPerformers above (top 5 only,
       kept for the summary card), this lists EVERY submission — completed
       or still in progress — with rank-by-marks and rank-by-completion-time
       computed only among completed submissions (an in-progress row's
       marks/time aren't final yet, so ranking it would be misleading),
       plus each student's attempt allowance so the admin can see who might
       need — or who was already granted — an extra attempt.
    ======================= */
    const completedForRanking = submissions.filter(
      (s) => s.status === "completed",
    );
    const marksRankOrder = [...completedForRanking].sort(
      (a, b) => b.obtainedMark - a.obtainedMark,
    );
    const timeRankOrder = [...completedForRanking].sort(
      (a, b) => (a.timetaken || 0) - (b.timetaken || 0),
    );
    const marksRankMap = new Map(
      marksRankOrder.map((s, idx) => [s._id.toString(), idx + 1]),
    );
    const timeRankMap = new Map(
      timeRankOrder.map((s, idx) => [s._id.toString(), idx + 1]),
    );

    const involvedUserIds = [
      ...new Set(submissions.map((s) => s.userId?._id?.toString()).filter(Boolean)),
    ];
    const attemptCounters = await attemptCounterModel
      .find({ examId, userId: { $in: involvedUserIds } })
      .lean();
    const attemptCounterMap = new Map(
      attemptCounters.map((c) => [c.userId.toString(), c]),
    );

    const studentPerformance = submissions
      .map((sub) => {
        const idStr = sub._id.toString();
        const userIdStr = sub.userId?._id?.toString();
        const counter = userIdStr ? attemptCounterMap.get(userIdStr) : null;
        return {
          submissionId: sub._id,
          userId: sub.userId?._id,
          name: sub.userId?.username || "Unknown",
          email: sub.userId?.email || "N/A",
          status: sub.status,
          pass: sub.pass,
          marks: sub.obtainedMark || 0,
          totalPossibleMarks,
          timetaken: sub.timetaken || 0,
          attemptNumber: sub.attemptNumber,
          maxAllowedAttempts: counter?.maxAllowedAttempts ?? 1,
          rankByMarks: marksRankMap.get(idStr) || null,
          rankByCompletionTime: timeRankMap.get(idStr) || null,
          submittedAt: sub.updatedAt,
          startedAt: sub.createdAt,
        };
      })
      .sort((a, b) => (a.rankByMarks || Infinity) - (b.rankByMarks || Infinity));

    /* =======================
       D. SUBTOPIC-WISE ANALYSIS
    ======================= */
    const subTopicAnalysis = {};

    submissions.forEach((sub) => {
      sub.examData.forEach((q) => {
        if (!q.questionId || !q.questionId.subTopic) return;
        if (!exam.subject?.subtopics) return;

        const subTopicId = q.questionId.subTopic.toString();

        // 🔑 Resolve subtopic from subject
        const subTopicObj = exam.subject.subtopics.find(
          (st) => st._id.toString() === subTopicId,
        );

        const subTopicName = subTopicObj?.name || "Unknown";

        if (!subTopicAnalysis[subTopicId]) {
          subTopicAnalysis[subTopicId] = {
            subTopicId,
            subTopicName,
            correct: 0,
            total: 0,
          };
        }

        subTopicAnalysis[subTopicId].total++;

        const isCorrect =
          JSON.stringify(q.studentAnswer) === JSON.stringify(q.correctAnswer);

        if (isCorrect) {
          subTopicAnalysis[subTopicId].correct++;
        }
      });
    });

    const subTopicData = Object.values(subTopicAnalysis).map((data) => ({
      subTopic: data.subTopicName,
      correct: data.correct,
      total: data.total,
      avgScore:
        data.total > 0
          ? Number(((data.correct / data.total) * 100).toFixed(1))
          : 0,
    }));

    /* =======================
       E. BEST & WORST SUBTOPICS
    ======================= */
    const sortedSubTopics = [...subTopicData].sort(
      (a, b) => b.avgScore - a.avgScore,
    );

    const bestSubTopic = sortedSubTopics[0] || {
      subTopic: "N/A",
      avgScore: 0,
    };

    const worstSubTopic = sortedSubTopics[sortedSubTopics.length - 1] || {
      subTopic: "N/A",
      avgScore: 0,
    };

    /* =======================
       F. KEY INSIGHTS
    ======================= */
    const keyInsights = {
      bestPerformingSubTopic: {
        name: bestSubTopic.subTopic,
        score: bestSubTopic.avgScore,
      },
      poorlyPerformingSubTopic: {
        name: worstSubTopic.subTopic,
        score: worstSubTopic.avgScore,
      },
    };

    /* =======================
       FINAL RESPONSE
    ======================= */
    res.status(200).json({
      success: true,
      data: {
        exam: {
          _id: exam._id,
          examCode: exam.examCode,
          subject: {
            _id: exam.subject._id,
            name: exam.subject.name,
          },
          subTopic: examSubTopic
            ? { _id: examSubTopic._id, name: examSubTopic.name }
            : null,
          order: exam.order,
          passPercentage: exam.passPercentage,
        },
        summary: {
          totalStudents: totalSubmission,
          highestMark,
          lowestMark,
          averageMark: Number(averageMark.toFixed(2)),
        },
        performanceDistribution,
        topPerformers,
        studentPerformance,
        subTopicAnalysis: subTopicData,
        mostMistakenTopic: worstSubTopic,
        keyInsights,
      },
    });
  } catch (error) {
    console.error("Error fetching exam detailed analysis:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching exam detailed analysis",
      error: error.message,
    });
  }
};

// Get all students overview
const getAllStudentsOverview = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    // Fetch mark configuration
    const markData = await markModel.findById("mark-based-on-levels");
    if (!markData) {
      throw new Error("Mark configuration not found");
    }

    // Admin's category-organized workflow: optionally scope this student
    // list to one exam category (GATE / TNPSC AE / TNPSC JDO / SSC JE-RRB
    // JE) instead of seeing every category's students mixed together.
    const studentMatch = { role: "student" };
    if (req.query.category) {
      studentMatch.category = req.query.category;
    }

    // Get all students with their submissions
    const [allStudents, totalCount] = await Promise.all([
      User.find(studentMatch)
        .sort({ username: 1 })
        .skip(skip)
        .limit(limit)
        .select("_id username email registerNumber category isDisabled")
        .lean(),
      User.countDocuments(studentMatch),
    ]);

    // Process each student
    const studentsData = await Promise.all(
      allStudents.map(async (student) => {
        // "Last attempt only" rule: one entry per exam this student has
        // ever attempted — their single most recent attempt on it — not
        // every attempt across every retake.
        const rawSubmissions = await ExamSubmission.find({ userId: student._id })
          .populate({
            path: "examId",
            select: "questions",
            populate: { path: "questions" },
          })
          .lean();
        const submissions = getLatestAttemptsOnly(rawSubmissions);

        const totalExams = submissions.length;
        const passedExams = submissions.filter((sub) => sub.pass === true).length;

        let totalCorrect = 0;
        let totalAttempted = 0;
        let totalPercentage = 0;

        submissions.forEach((sub) => {
          if (sub.examId && sub.examData && sub.examData.length > 0) {
            // Total possible marks, summed per-question (per-question
            // overrides fall back to the level-based config).
            const totalMarks = calculateTotalPossibleMarks(
              sub.examId.questions || [],
              markData
            );
            const percentage = totalMarks > 0 ? (sub.obtainedMark / totalMarks) * 100 : 0;
            totalPercentage += percentage;

            sub.examData.forEach((q) => {
              totalAttempted++;
              if (q.isRight === "Correct") {
                totalCorrect++;
              }
            });
          }
        });

        const avgPercentage = totalExams > 0 ? totalPercentage / totalExams : 0;
        const passRate = totalExams > 0 ? (passedExams / totalExams) * 100 : 0;

        return {
          _id: student._id,
          name: student.username,
          email: student.email,
          registerNumber: student.registerNumber,
          category: student.category || null,
          isDisabled: !!student.isDisabled,
          totalExams,
          avgPercentage: parseFloat(avgPercentage.toFixed(2)),
          passRate: parseFloat(passRate.toFixed(2)),
          totalCorrect,
          totalAttempted,
        };
      })
    );

    res.status(200).json({
      success: true,
      data: {
        students: studentsData,
        totalStudents: totalCount,
        pagination: {
          page,
          limit,
          totalPages: Math.ceil(totalCount / limit),
          hasMore: page * limit < totalCount,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching students overview:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching students overview",
      error: error.message,
    });
  }
};

// Get detailed student analysis
const getStudentDetailedAnalysis = async (req, res) => {
  try {
    const { studentId } = req.params;

    const student = await User.findById(studentId)
      .select("username email registerNumber role category lastLoginAt")
      .lean();

    if (!student || student.role !== "student") {
      return res.status(404).json({
        success: false,
        message: "Student not found",
      });
    }

    // "Last attempt only" rule: one entry per exam this student has ever
    // attempted — their single most recent attempt on it — feeds every
    // section below (percentage, subject/topic breakdowns, exam summary,
    // attempt summary).
    const rawSubmissions = await ExamSubmission.find({ userId: studentId })
      .populate({
        path: "examId",
        populate: [
          {
            path: "subject",
            select: "name subtopics",
          },
          {
            path: "questions",
          },
        ],
      })
      .populate("examData.questionId", "topic subTopic questionType")
      .lean();
    const submissions = getLatestAttemptsOnly(rawSubmissions);

    // A. Basic Details
    const basicDetails = {
      studentName: student.username,
      email: student.email,
      registerNumber: student.registerNumber,
      course: "Not specified", // Add course field to User model if needed
      // Activity signal outside of test performance — when this student
      // last logged in (set on every successful login; see loginUser in
      // userController.js).
      lastLoginAt: student.lastLoginAt || null,
    };

    // Fetch mark configuration for percentage calculation
    const markData = await markModel.findById("mark-based-on-levels");
    if (!markData) {
      throw new Error("Mark configuration not found");
    }

    const totalPercentageArray =
      submissions.length > 0
        ? submissions
            .filter(
              (exam) => exam.status === "completed" && exam.examData.length > 0 && exam.examId,
            )
            .map((exam) => {
              const totalMarks = calculateTotalPossibleMarks(
                exam.examId.questions || [],
                markData
              );
              return totalMarks > 0 ? (exam.obtainedMark / totalMarks) * 100 : 0;
            })
        : [];

    const avgPercentage =
      totalPercentageArray.length > 0
        ? totalPercentageArray.reduce(
            (sum, percentage) => sum + percentage,
            0,
          ) / totalPercentageArray.length
        : 0;

    // Calculate rank across every student. Previously this re-fetched each
    // candidate student's ENTIRE submission history in a separate query
    // (one ExamSubmission.find per student — an O(N) query fan-out that
    // gets slower as the student count grows). Replaced with a single
    // aggregation pipeline: average obtainedMark per userId in one pass,
    // left-joined against every student so a student with zero submissions
    // still ranks (avgScore 0) instead of being silently dropped.
    const totalStudentsCount = await User.countDocuments({ role: "student" });

    const rankAgg = await User.aggregate([
      { $match: { role: "student" } },
      { $project: { _id: 1 } },
      {
        $lookup: {
          from: ExamSubmission.collection.name,
          let: { studentId: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$userId", "$$studentId"] } } },
            // "Last attempt only" rule: average across each exam's most
            // recent attempt for this student, not every retake.
            ...latestAttemptOnlyStages(),
            { $group: { _id: null, avgScore: { $avg: "$obtainedMark" } } },
          ],
          as: "scoreInfo",
        },
      },
      {
        $project: {
          avgScore: {
            $ifNull: [{ $arrayElemAt: ["$scoreInfo.avgScore", 0] }, 0],
          },
        },
      },
      { $sort: { avgScore: -1 } },
    ]);

    const rank =
      rankAgg.findIndex((s) => s._id.toString() === studentId) + 1;

    // Calculate accuracy
    let totalCorrect = 0;
    let totalAttempted = 0;

    submissions.forEach((sub) => {
      sub.examData.forEach((q) => {
        if (q.studentAnswer !== null && q.studentAnswer !== undefined) {
          totalAttempted++;
          const isCorrect =
            JSON.stringify(q.studentAnswer) === JSON.stringify(q.correctAnswer);
          if (isCorrect) totalCorrect++;
        }
      });
    });

    const overallPerformance = {
      percentage: parseFloat(avgPercentage.toFixed(2)),
      rank,
      totalStudents: totalStudentsCount,
      correctAnswers: totalCorrect,
      attemptedQuestions: totalAttempted,
    };

    const subjectPerformance = {};

    submissions.forEach((sub) => {
      if (!sub.examId || !sub.examId.subject) return;

      const subjectName = sub.examId.subject.name;

      if (!subjectPerformance[subjectName]) {
        subjectPerformance[subjectName] = {
          subjectName,
          totalMarks: 0,
          examsCount: 0,
          correct: 0,
          total: 0,
        };
      }

      subjectPerformance[subjectName].totalMarks += sub.obtainedMark;
      subjectPerformance[subjectName].examsCount += 1;

      sub.examData.forEach((q) => {
        if (q.questionId) {
          subjectPerformance[subjectName].total++;
          const isCorrect =
            JSON.stringify(q.studentAnswer) === JSON.stringify(q.correctAnswer);
          if (isCorrect) subjectPerformance[subjectName].correct++;
        }
      });
    });

    // C. Exam-wise Summary (NEW) — rank this student, per exam, against
    // every OTHER student who completed that same exam (rank-by-marks and
    // rank-by-completion-time), plus this student's own attempt status and
    // allowance for that exam (item C's "Student → Exams → Individual
    // Performance" requirement).
    const completedExamIds = [
      ...new Set(
        submissions
          .filter((sub) => sub.status === "completed" && sub.examId?._id)
          .map((sub) => sub.examId._id.toString()),
      ),
    ];

    const [rawSubmissionsForTheseExams, studentAttemptCounters] =
      await Promise.all([
        ExamSubmission.find({
          examId: { $in: completedExamIds },
          status: "completed",
        })
          .select("examId userId obtainedMark timetaken attemptNumber completedAt")
          .lean(),
        attemptCounterModel
          .find({ userId: studentId, examId: { $in: completedExamIds } })
          .lean(),
      ]);
    // "Last attempt only" rule: rank this student against every OTHER
    // student's own single most recent completed attempt per exam, not
    // every attempt anyone has ever made.
    const allSubmissionsForTheseExams = getLatestAttemptsOnly(
      rawSubmissionsForTheseExams,
    );

    const rankMapsByExam = new Map(); // examId -> { marksRank: Map<submissionUserId,rank>, timeRank: Map }
    completedExamIds.forEach((examIdStr) => {
      const subsForExam = allSubmissionsForTheseExams.filter(
        (s) => s.examId.toString() === examIdStr,
      );
      const byMarks = [...subsForExam].sort(
        (a, b) => b.obtainedMark - a.obtainedMark,
      );
      const byTime = [...subsForExam].sort(
        (a, b) => (a.timetaken || 0) - (b.timetaken || 0),
      );
      rankMapsByExam.set(examIdStr, {
        marksRank: new Map(
          byMarks.map((s, idx) => [s.userId.toString(), idx + 1]),
        ),
        timeRank: new Map(
          byTime.map((s, idx) => [s.userId.toString(), idx + 1]),
        ),
        totalParticipants: subsForExam.length,
      });
    });

    const attemptCounterByExam = new Map(
      studentAttemptCounters.map((c) => [c.examId.toString(), c]),
    );

    const examSummary = submissions
      .filter((sub) => sub.status === "completed" && sub.examData.length > 0)
      .map((sub) => {
        let correct = 0;
        let wrong = 0;
        let partial = 0;
        let skipped = 0;

        sub.examData.forEach((q) => {
          if (q.isRight === "Correct") correct++;
          else if (q.isRight === "Incorrect") wrong++;
          else if (q.isRight === "Partially Correct") partial++;
          else skipped++;
        });

        let subTopicName = "N/A";

        if (sub.examId?.subject?.subtopics?.length && sub.examId?.subTopic) {
          const match = sub.examId.subject.subtopics.find(
            (st) => st._id.toString() === sub.examId.subTopic.toString(),
          );
          if (match) subTopicName = match.name;
        }

        const totalMarks = calculateTotalPossibleMarks(
          sub.examId?.questions || [],
          markData
        );

        const percentage =
          totalMarks > 0
            ? Number(((sub.obtainedMark / totalMarks) * 100).toFixed(2))
            : 0;

        const examIdStr = sub.examId?._id?.toString();
        const rankInfo = examIdStr ? rankMapsByExam.get(examIdStr) : null;
        const counter = examIdStr ? attemptCounterByExam.get(examIdStr) : null;

        return {
          examId: sub.examId?._id,
          subject: sub.examId?.subject?.name || "N/A",
          subTopic: subTopicName || "N/A",
          order: sub.examId?.order ?? "N/A",
          totalQuestions: sub.examData.length,
          correct,
          wrong,
          partial,
          skipped,
          percentage,
          marks: sub.obtainedMark || 0,
          totalPossibleMarks: totalMarks,
          completionTimeSeconds: sub.timetaken || 0,
          rankByMarks: rankInfo?.marksRank.get(studentId.toString()) || null,
          rankByCompletionTime:
            rankInfo?.timeRank.get(studentId.toString()) || null,
          totalParticipants: rankInfo?.totalParticipants || 0,
          attemptNumber: sub.attemptNumber,
          status: sub.status,
          pass: sub.pass,
          submittedAt: sub.updatedAt,
          maxAllowedAttempts: counter?.maxAllowedAttempts ?? 3,
          // Speed %/Accuracy % for this student's LATEST completed attempt
          // on this exam — `submissions` was already reduced to one entry
          // per exam (their most recent attempt) above, per the "last
          // attempt only" rule, so examSummary has one row per exam here,
          // not one row per attempt.
          speedPercent: sub.speedPercent ?? null,
          accuracyPercent: sub.accuracyPercent ?? null,
        };
      });

    // Group completed exams into Subject -> Topic (subtopic) rollups. Each
    // topic aggregates its own attempt summary (correct/wrong/partial/
    // skipped) and average percentage across just that topic's exams — so
    // the admin can see how a student is doing on one specific topic, not
    // only a whole subject or the flat per-exam list.
    const topicMap = new Map(); // key: `${subject}|${subTopic}`

    examSummary.forEach((exam) => {
      const key = `${exam.subject}|${exam.subTopic}`;
      if (!topicMap.has(key)) {
        topicMap.set(key, {
          subject: exam.subject,
          subTopic: exam.subTopic,
          exams: [],
          correct: 0,
          wrong: 0,
          partial: 0,
          skipped: 0,
          totalPercentage: 0,
        });
      }
      const t = topicMap.get(key);
      t.exams.push(exam);
      t.correct += exam.correct;
      t.wrong += exam.wrong;
      t.partial += exam.partial;
      t.skipped += exam.skipped;
      t.totalPercentage += exam.percentage;
    });

    const topicSummaries = Array.from(topicMap.values()).map((t) => {
      const totalAnswered = t.correct + t.wrong + t.partial + t.skipped;
      return {
        subject: t.subject,
        subTopic: t.subTopic,
        examsCount: t.exams.length,
        avgPercentage: Number(
          (t.totalPercentage / t.exams.length).toFixed(2),
        ),
        attemptSummary: {
          correct: t.correct,
          wrong: t.wrong,
          partial: t.partial,
          skipped: t.skipped,
          correctPercentage:
            totalAnswered > 0
              ? Number(((t.correct / totalAnswered) * 100).toFixed(1))
              : 0,
          wrongPercentage:
            totalAnswered > 0
              ? Number(((t.wrong / totalAnswered) * 100).toFixed(1))
              : 0,
          partialPercentage:
            totalAnswered > 0
              ? Number(((t.partial / totalAnswered) * 100).toFixed(1))
              : 0,
          skippedPercentage:
            totalAnswered > 0
              ? Number(((t.skipped / totalAnswered) * 100).toFixed(1))
              : 0,
        },
        exams: t.exams,
      };
    });

    // examGroupedBySubject now maps subject name -> array of topic
    // (subtopic) summaries, each carrying its own attempt summary and exam
    // list (was previously a flat subject -> exams list with no topic
    // rollup).
    const groupedBySubject = {};
    topicSummaries.forEach((topic) => {
      if (!groupedBySubject[topic.subject]) {
        groupedBySubject[topic.subject] = [];
      }
      groupedBySubject[topic.subject].push(topic);
    });

    const subjectChart = {};

    examSummary.forEach((exam) => {
      if (!subjectChart[exam.subject]) {
        subjectChart[exam.subject] = { total: 0, count: 0 };
      }
      subjectChart[exam.subject].total += exam.percentage;
      subjectChart[exam.subject].count++;
    });

    const subjectChartData = Object.entries(subjectChart).map(
      ([subject, val]) => ({
        subject,
        percentage: val.total / val.count,
      }),
    );

    // Topic (subtopic)-level chart data — a finer-grained view than the
    // subject-level chart above, since one subject can contain several
    // topics with very different performance.
    const topicChartData = topicSummaries.map((t) => ({
      topic: t.subTopic,
      subject: t.subject,
      percentage: t.avgPercentage,
    }));

    // D. Attempt Summary
    let correctCount = 0;
    let inCorrectCount = 0;
    let skippedCount = 0;
    let partialMarkCount = 0;

    submissions.forEach((sub) => {
      sub.examData.forEach((q) => {
        if (q.isRight === "Correct") {
          correctCount++;
        } else if (q.isRight === "Incorrect") {
          inCorrectCount++;
        } else if (q.isRight === "Partially Correct") {
          partialMarkCount++;
        } else {
          skippedCount++;
        }
      });
    });

    const attemptSummary = {
      correct: correctCount,
      wrong: inCorrectCount,
      skipped: skippedCount,
      partialCorrect: partialMarkCount,
      total: correctCount + inCorrectCount + skippedCount + partialMarkCount,
      correctPercentage: parseFloat(
        (
          (correctCount /
            (correctCount + inCorrectCount + skippedCount + partialMarkCount)) *
          100
        ).toFixed(1),
      ),
      wrongPercentage: parseFloat(
        (
          (inCorrectCount /
            (correctCount + inCorrectCount + skippedCount + partialMarkCount)) *
          100
        ).toFixed(1),
      ),
      skippedPercentage: parseFloat(
        (
          (skippedCount /
            (correctCount + inCorrectCount + skippedCount + partialMarkCount)) *
          100
        ).toFixed(1),
      ),
      partialPercentage: parseFloat(
        (
          (partialMarkCount /
            (correctCount + inCorrectCount + skippedCount + partialMarkCount)) *
          100
        ).toFixed(1),
      ),
    };

    // E. Key Insights
    const sortedSubjects = [...subjectChartData].sort(
      (a, b) => b.percentage - a.percentage,
    );

    const strongestSubject = sortedSubjects[0] || {
      subject: "N/A",
      percentage: 0,
    };

    const weakestSubject = sortedSubjects[sortedSubjects.length - 1] || {
      subject: "N/A",
      percentage: 0,
    };

    // Topic (subtopic)-level strongest/weakest — a more actionable insight
    // than subject-level alone, since a student can be strong in most of a
    // subject but weak on one specific topic within it.
    const sortedTopics = [...topicChartData].sort(
      (a, b) => b.percentage - a.percentage,
    );

    const strongestTopic = sortedTopics[0] || { topic: "N/A", percentage: 0 };
    const weakestTopic = sortedTopics[sortedTopics.length - 1] || {
      topic: "N/A",
      percentage: 0,
    };

    const keyInsights = {
      strongestSubject: {
        name: strongestSubject.subject,
        percentage: strongestSubject.percentage,
      },
      weakestSubject: {
        name: weakestSubject.subject,
        percentage: weakestSubject.percentage,
      },
      strongestTopic: {
        name: strongestTopic.topic,
        percentage: strongestTopic.percentage,
      },
      weakestTopic: {
        name: weakestTopic.topic,
        percentage: weakestTopic.percentage,
      },
    };

    // F. Pending tests count — every active exam in this student's category
    // that has no completed submission yet. Every posted set is visible
    // from the moment it's posted (no order/pass-based unlock sequence
    // anymore — removed per admin request 2026-09-17), so this is now a
    // plain "posted but not yet completed" count.
    let pendingTestsCount = 0;
    if (student.category) {
      const studentSubjects = await Subject.find({
        category: student.category,
      }).select("_id");
      const studentSubjectIds = studentSubjects.map((s) => s._id);

      const activeExams = await Exam.find({
        subject: { $in: studentSubjectIds },
        status: "active",
      }).select("_id");

      const completedExamIdSet = new Set(completedExamIds);

      pendingTestsCount = activeExams.filter(
        (exam) => !completedExamIdSet.has(exam._id.toString())
      ).length;
    }

    // G. Video engagement — every recorded class this student has ANY
    // watch progress on, matching the admin's "Class 1: 95%, Class 2: 72%"
    // example. Empty until the student has watched anything (a brand new
    // recorded-class library, or a student who hasn't opened one yet).
    const videoProgressRows = await videoProgressModel
      .find({ userId: studentId })
      .populate("videoId", "title durationSeconds")
      .sort({ lastWatchedAt: -1 });

    const videoEngagement = videoProgressRows
      .filter((row) => row.videoId)
      .map((row) => {
        const durationSeconds = row.videoId.durationSeconds || 0;
        const percentWatched = durationSeconds
          ? Math.min(100, (row.totalWatchSeconds / durationSeconds) * 100)
          : 0;

        return {
          videoId: row.videoId._id,
          title: row.videoId.title,
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
        examGroupedBySubject: groupedBySubject,
        basicDetails,
        overallPerformance,
        subjectChartData,
        topicChartData,
        attemptSummary,
        keyInsights,
        pendingTestsCount,
        videoEngagement,
      },
    });
  } catch (error) {
    console.error("Error fetching student detailed analysis:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching student detailed analysis",
      error: error.message,
    });
  }
};

// Get topic (subject + subtopic) performance overview — for every topic
// that has at least one completed submission, who the top and weakest
// performing students are and the class average, so the admin's Exam
// Dashboard can show "who's leading / who's struggling" per topic instead
// of only per individual exam.
const getTopicPerformanceOverview = async (req, res) => {
  try {
    const subjectMatch = {};
    if (req.query.category) {
      subjectMatch.category = req.query.category;
    }

    const subjects = await Subject.find(subjectMatch).lean();
    if (subjects.length === 0) {
      return res.status(200).json({ success: true, data: { topics: [] } });
    }

    const subjectIds = subjects.map((s) => s._id);
    const exams = await Exam.find({ subject: { $in: subjectIds } })
      .select("_id subject subTopic")
      .lean();

    if (exams.length === 0) {
      return res.status(200).json({ success: true, data: { topics: [] } });
    }

    const examIds = exams.map((e) => e._id);
    const markData = await markModel.findById("mark-based-on-levels");
    if (!markData) {
      throw new Error("Mark configuration not found");
    }

    const rawSubmissions = await ExamSubmission.find({
      examId: { $in: examIds },
      status: "completed",
    })
      .populate({
        path: "examId",
        select: "subject subTopic questions",
        populate: { path: "questions" },
      })
      .populate("userId", "username email")
      .lean();
    // "Last attempt only" rule: one entry per student per exam (their most
    // recent completed attempt) before rolling up into topic averages —
    // otherwise a student who retook one exam in a topic would count that
    // exam's percentage multiple times and skew both their own topic
    // average and the topic's class average.
    const submissions = getLatestAttemptsOnly(rawSubmissions);

    // key: `${subjectId}|${subTopicId}`
    const topicMap = new Map();

    submissions.forEach((sub) => {
      if (!sub.examId || !sub.examId.subject || !sub.examId.subTopic) return;
      const subject = subjects.find(
        (s) => s._id.toString() === sub.examId.subject.toString(),
      );
      if (!subject) return;

      const subTopicIdStr = sub.examId.subTopic.toString();
      const subtopicObj = (subject.subtopics || []).find(
        (st) => st._id.toString() === subTopicIdStr,
      );

      const key = `${subject._id}|${subTopicIdStr}`;
      if (!topicMap.has(key)) {
        topicMap.set(key, {
          subjectId: subject._id,
          subjectName: subject.name,
          subTopicId: sub.examId.subTopic,
          subTopicName: subtopicObj?.name || "Unknown",
          category: subject.category,
          studentTotals: new Map(),
        });
      }

      const topic = topicMap.get(key);
      const totalMarks = calculateTotalPossibleMarks(
        sub.examId.questions || [],
        markData,
      );
      const pct = totalMarks > 0 ? (sub.obtainedMark / totalMarks) * 100 : 0;

      const studentId = sub.userId?._id?.toString();
      if (!studentId) return;

      if (!topic.studentTotals.has(studentId)) {
        topic.studentTotals.set(studentId, {
          name: sub.userId.username,
          email: sub.userId.email,
          totalPct: 0,
          count: 0,
        });
      }
      const entry = topic.studentTotals.get(studentId);
      entry.totalPct += pct;
      entry.count += 1;
    });

    const topics = Array.from(topicMap.values()).map((topic) => {
      const studentAverages = Array.from(topic.studentTotals.entries()).map(
        ([studentId, v]) => ({
          studentId,
          name: v.name,
          email: v.email,
          avgPercentage: Number((v.totalPct / v.count).toFixed(2)),
          examsCount: v.count,
        }),
      );
      studentAverages.sort((a, b) => b.avgPercentage - a.avgPercentage);

      const classAverage =
        studentAverages.length > 0
          ? Number(
              (
                studentAverages.reduce((sum, s) => sum + s.avgPercentage, 0) /
                studentAverages.length
              ).toFixed(2),
            )
          : 0;

      return {
        subjectId: topic.subjectId,
        subjectName: topic.subjectName,
        subTopicId: topic.subTopicId,
        subTopicName: topic.subTopicName,
        category: topic.category,
        totalStudents: studentAverages.length,
        classAverage,
        topPerformer: studentAverages[0] || null,
        // Only show a separate "weakest" performer when there's more than
        // one student — otherwise the same lone student would show up as
        // both top and weakest, which reads as a bug rather than a signal.
        weakestPerformer:
          studentAverages.length > 1
            ? studentAverages[studentAverages.length - 1]
            : null,
      };
    });

    topics.sort((a, b) => b.classAverage - a.classAverage);

    res.status(200).json({
      success: true,
      data: { topics },
    });
  } catch (error) {
    console.error("Error fetching topic performance overview:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching topic performance overview",
      error: error.message,
    });
  }
};

module.exports = {
  getAllExamsOverview,
  getExamDetailedAnalysis,
  getAllStudentsOverview,
  getStudentDetailedAnalysis,
  getTopicPerformanceOverview,
};
