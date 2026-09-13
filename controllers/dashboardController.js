const mongoose = require("mongoose");
const ExamSubmission = require("../models/examSubmissionSchema");
const User = require("../models/userModel");
const Exam = require("../models/examModel");
const Subject = require("../models/subjectModel");
const markModel = require("../models/markModel");
const attemptCounterModel = require("../models/attemptCounterModel");
const {
  calculateTotalPossibleMarks,
} = require("../utils/ExamSubmissionHelper");

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
          $lookup: {
            from: "examsubmissions",
            localField: "_id",
            foreignField: "examId",
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

    // 3️⃣ Fetch submissions
    const submissions = await ExamSubmission.find({ examId })
      .populate("userId", "username email")
      .populate(
        "examData.questionId",
        "question subTopic questionType correctAnswer",
      )
      .lean();

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
        const submissions = await ExamSubmission.find({ userId: student._id })
          .populate({
            path: "examId",
            select: "questions",
            populate: { path: "questions" },
          })
          .lean();

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
      .select("username email registerNumber role")
      .lean();

    if (!student || student.role !== "student") {
      return res.status(404).json({
        success: false,
        message: "Student not found",
      });
    }

    const submissions = await ExamSubmission.find({ userId: studentId })
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

    // A. Basic Details
    const basicDetails = {
      studentName: student.username,
      email: student.email,
      registerNumber: student.registerNumber,
      course: "Not specified", // Add course field to User model if needed
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

    // Calculate rank (you may want to implement a more sophisticated ranking system)
    const allStudents = await User.find({ role: "student" })
      .select("_id")
      .lean();
    const allStudentScores = await Promise.all(
      allStudents.map(async (s) => {
        const subs = await ExamSubmission.find({ userId: s._id }).lean();
        const total = subs.reduce((sum, sub) => sum + sub.obtainedMark, 0);
        const avg = subs.length > 0 ? total / subs.length : 0;
        return { studentId: s._id.toString(), avgScore: avg };
      }),
    );

    const sortedStudents = allStudentScores.sort(
      (a, b) => b.avgScore - a.avgScore,
    );
    const rank = sortedStudents.findIndex((s) => s.studentId === studentId) + 1;

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
      totalStudents: allStudents.length,
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

    const [allSubmissionsForTheseExams, studentAttemptCounters] =
      await Promise.all([
        ExamSubmission.find({
          examId: { $in: completedExamIds },
          status: "completed",
        })
          .select("examId userId obtainedMark timetaken")
          .lean(),
        attemptCounterModel
          .find({ userId: studentId, examId: { $in: completedExamIds } })
          .lean(),
      ]);

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
          maxAllowedAttempts: counter?.maxAllowedAttempts ?? 1,
        };
      });

    const groupedBySubject = {};

    examSummary.forEach((exam) => {
      if (!groupedBySubject[exam.subject]) {
        groupedBySubject[exam.subject] = [];
      }
      groupedBySubject[exam.subject].push(exam);
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

    const keyInsights = {
      strongestSubject: {
        name: strongestSubject.subject,
        percentage: strongestSubject.percentage,
      },
      weakestSubject: {
        name: weakestSubject.subject,
        percentage: weakestSubject.percentage,
      },
    };

    res.status(200).json({
      success: true,
      data: {
        examGroupedBySubject: groupedBySubject,
        basicDetails,
        overallPerformance,
        subjectChartData,
        attemptSummary,
        keyInsights,
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

module.exports = {
  getAllExamsOverview,
  getExamDetailedAnalysis,
  getAllStudentsOverview,
  getStudentDetailedAnalysis,
};
