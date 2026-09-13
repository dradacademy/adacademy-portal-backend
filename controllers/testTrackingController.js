// Test Tracking — powers the Student "Test Index" page and the Admin
// "Test Tracking" dashboard. Both surfaces show the same underlying
// information (which tests exist, when they were posted/scheduled/made
// available, who completed them and when, on-time vs late, and score),
// scoped differently: a student only ever sees their own row, an admin
// sees every student's row for every test in a category.
//
// "Assigned" tests intentionally use the existing category + order-based
// eligibility model (no separate per-student roster/assignment feature):
// a test is "assigned" to a student once it's unlocked for them (or they've
// already completed it) — the same rule that already governs the
// Available/Attended tabs and progression unlocking elsewhere in the app.

const examModel = require("../models/examModel");
const examSubmissionSchema = require("../models/examSubmissionSchema");
const examPassModel = require("../models/examPassModel");
const Subject = require("../models/subjectModel");
const User = require("../models/userModel");
const markModel = require("../models/markModel");
const { ensureMarkConfigExists } = require("./markController");
const {
  calculateTotalPossibleMarks,
} = require("../utils/ExamSubmissionHelper");

const getMarkConfig = async () => {
  let mark = await markModel.findById("mark-based-on-levels");
  if (!mark) {
    await ensureMarkConfigExists();
    mark = await markModel.findById("mark-based-on-levels");
  }
  return mark;
};

// "On or before the scheduled date" counts as on-time — give the student
// the whole scheduled calendar day, not just up to midnight.
const isOnTime = (completedAt, scheduledDate) => {
  if (!scheduledDate) return null; // Unscheduled — no on-time/late verdict
  const endOfScheduledDay = new Date(scheduledDate);
  endOfScheduledDay.setHours(23, 59, 59, 999);
  return new Date(completedAt) <= endOfScheduledDay;
};

const buildTestRecord = ({
  exam,
  subjectName,
  subTopicName,
  submission,
  markConfig,
  isEligible,
}) => {
  const totalPossibleMarks = calculateTotalPossibleMarks(
    exam.questions || [],
    markConfig
  );

  const base = {
    examId: exam._id,
    examCode: exam.examCode,
    subjectName,
    subTopicName,
    order: exam.order,
    postedDate: exam.createdAt, // date the admin first built/posted the test
    scheduledDate: exam.scheduledDate,
    madeAvailableDate: exam.publishedAt,
    passPercentage: exam.passPercentage,
    totalPossibleMarks,
  };

  if (submission) {
    const percentage = totalPossibleMarks
      ? Math.round((submission.obtainedMark / totalPossibleMarks) * 1000) / 10
      : 0;

    return {
      ...base,
      status: "Completed",
      completedAt: submission.completedAt || submission.updatedAt,
      attemptNumber: submission.attemptNumber,
      obtainedMark: submission.obtainedMark,
      percentage,
      pass: submission.pass,
      onTime: isOnTime(
        submission.completedAt || submission.updatedAt,
        exam.scheduledDate
      ),
    };
  }

  return {
    ...base,
    status: "Pending",
    completedAt: null,
    attemptNumber: null,
    obtainedMark: null,
    percentage: null,
    pass: null,
    onTime: null,
    isEligible: !!isEligible, // only meaningful for the student view
  };
};

// GET /api/test-tracking/student/:userId
// Every test "assigned" to this student (currently eligible/unlocked, or
// already completed), each with posted/scheduled/available dates,
// completed-or-pending status, attended date, score, and on-time/late.
const getStudentTestIndex = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res
        .status(400)
        .json({ success: false, message: "User ID is required." });
    }

    if (req.user._id.toString() !== userId && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You do not have the required permissions",
      });
    }

    const student = await User.findById(userId).select("category role");
    if (!student) {
      return res
        .status(404)
        .json({ success: false, message: "Student not found." });
    }

    if (!student.category) {
      return res.status(200).json({ success: true, data: [] });
    }

    const subjects = await Subject.find({ category: student.category }).select(
      "_id name subtopics"
    );
    const subjectIds = subjects.map((s) => s._id);

    const exams = await examModel
      .find({ subject: { $in: subjectIds }, status: "active" })
      .populate("questions")
      .sort({ subject: 1, subTopic: 1, order: 1 });

    const examIds = exams.map((e) => e._id);

    const [submissions, passes, markConfig] = await Promise.all([
      examSubmissionSchema
        .find({ userId, examId: { $in: examIds }, status: "completed" })
        .sort({ attemptNumber: -1 }),
      examPassModel.find({ userId, pass: true }).select("subject subTopic order"),
      getMarkConfig(),
    ]);

    // Latest completed submission per exam (highest attemptNumber wins).
    const latestSubmissionByExam = new Map();
    for (const sub of submissions) {
      const key = sub.examId.toString();
      if (!latestSubmissionByExam.has(key)) {
        latestSubmissionByExam.set(key, sub);
      }
    }

    const passedOrdersByKey = new Map();
    for (const p of passes) {
      const key = `${p.subject}-${p.subTopic}`;
      if (!passedOrdersByKey.has(key)) passedOrdersByKey.set(key, new Set());
      passedOrdersByKey.get(key).add(p.order);
    }

    const subjectById = new Map(subjects.map((s) => [s._id.toString(), s]));

    const records = [];
    for (const exam of exams) {
      const subject = subjectById.get(exam.subject.toString());
      const subTopic = subject?.subtopics?.find(
        (st) => st._id.toString() === exam.subTopic.toString()
      );
      const key = `${exam.subject}-${exam.subTopic}`;
      const passedOrders = passedOrdersByKey.get(key) || new Set();
      const submission = latestSubmissionByExam.get(exam._id.toString());

      const isEligible =
        exam.order === 1 || passedOrders.has(exam.order - 1);

      // A test is "assigned" to this student once it's unlocked for them
      // or they've already completed it — a still-locked future test in
      // the sequence isn't shown yet, same as the existing Available tab.
      if (!submission && !isEligible) continue;

      records.push(
        buildTestRecord({
          exam,
          subjectName: subject?.name || "Unknown Subject",
          subTopicName: subTopic?.name || "Unknown Subtopic",
          submission,
          markConfig,
          isEligible,
        })
      );
    }

    res.status(200).json({ success: true, data: records });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to get student test index",
      error: error.message,
    });
  }
};

// GET /api/test-tracking/admin?category=gate
// Every test in the category, crossed with every active student enrolled
// in that category: who completed it, when, on-time/late, score, and who
// still hasn't. Filtering (by test/student/date/completed-pending/
// on-time-late/performance) is done client-side on this dataset.
const getAdminTestTracking = async (req, res) => {
  try {
    const { category } = req.query;

    const subjectFilter = category ? { category } : {};
    const subjects = await Subject.find(subjectFilter).select(
      "_id name category subtopics"
    );
    const subjectIds = subjects.map((s) => s._id);

    const exams = await examModel
      .find({ subject: { $in: subjectIds }, status: "active" })
      .populate("questions")
      .sort({ subject: 1, subTopic: 1, order: 1 });

    const examIds = exams.map((e) => e._id);

    const categoriesInScope = category
      ? [category]
      : [...new Set(subjects.map((s) => s.category))];

    const [students, submissions, markConfig] = await Promise.all([
      User.find({
        role: "student",
        category: { $in: categoriesInScope },
      }).select("username email category isDisabled"),
      examSubmissionSchema
        .find({ examId: { $in: examIds }, status: "completed" })
        .sort({ attemptNumber: -1 }),
      getMarkConfig(),
    ]);

    // Latest completed submission per (exam, student) pair.
    const latestSubmissionByExamAndUser = new Map();
    for (const sub of submissions) {
      const key = `${sub.examId}-${sub.userId}`;
      if (!latestSubmissionByExamAndUser.has(key)) {
        latestSubmissionByExamAndUser.set(key, sub);
      }
    }

    const subjectById = new Map(subjects.map((s) => [s._id.toString(), s]));
    const studentsByCategory = new Map();
    for (const student of students) {
      const key = student.category;
      if (!studentsByCategory.has(key)) studentsByCategory.set(key, []);
      studentsByCategory.get(key).push(student);
    }

    const records = [];
    for (const exam of exams) {
      const subject = subjectById.get(exam.subject.toString());
      const subTopic = subject?.subtopics?.find(
        (st) => st._id.toString() === exam.subTopic.toString()
      );
      const studentsInCategory = studentsByCategory.get(subject?.category) || [];

      for (const student of studentsInCategory) {
        const submission = latestSubmissionByExamAndUser.get(
          `${exam._id}-${student._id}`
        );

        const record = buildTestRecord({
          exam,
          subjectName: subject?.name || "Unknown Subject",
          subTopicName: subTopic?.name || "Unknown Subtopic",
          submission,
          markConfig,
        });

        records.push({
          ...record,
          studentId: student._id,
          studentName: student.username,
          studentEmail: student.email,
          studentDisabled: student.isDisabled,
        });
      }
    }

    res.status(200).json({ success: true, data: records });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to get admin test tracking data",
      error: error.message,
    });
  }
};

module.exports = {
  getStudentTestIndex,
  getAdminTestTracking,
};
