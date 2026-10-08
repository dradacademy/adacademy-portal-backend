const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const userModel = require("../models/userModel");
const Exam = require("../models/examModel");
const Subject = require("../models/subjectModel");
const ExamSubmission = require("../models/examSubmissionSchema");
const EnrollmentLead = require("../models/enrollmentLeadModel");
const sendMail = require("../utils/sendMail");
const { EXAM_CATEGORIES, EXAM_CATEGORY_LABELS } = require("../constants/examCategories");
const { getLatestAttemptsOnly } = require("../utils/latestAttemptHelper");

// Free registration test (2026-10-08). The admin ticks "Free test" on one
// exam per category (GATE, TNPSC AE, TNPSC JDO, SSC JE & RRB JE). Anyone can
// register on the public /free-test page with their details, gets a
// "free_trial" student account (sees only free tests, no profile form), and
// after the test sees score, rank and full solutions like a regular
// student. Every registration is also saved as an enquiry and emailed to the
// academy.

const ADMIN_NOTIFY_EMAIL = "dradacademy@gmail.com";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v, max = 120) => String(v ?? "").trim().slice(0, max);

const freeExamsByCategory = async () => {
  const exams = await Exam.find({ isFreeTest: true, status: "active" })
    .select("examCode questions subject subTopic order")
    .populate({ path: "subject", select: "name category subtopics" })
    .lean();
  const map = new Map();
  for (const e of exams) {
    const cat = e.subject?.category;
    if (!cat) continue;
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(e);
  }
  return map;
};

// GET /api/free-test/options (public)
const getFreeTestOptions = async (req, res) => {
  try {
    const byCat = await freeExamsByCategory();
    const data = EXAM_CATEGORIES.map((category) => {
      const exams = byCat.get(category) || [];
      const first = exams[0];
      const subTopic = first?.subject?.subtopics?.find((s) => String(s._id) === String(first.subTopic));
      return {
        category,
        label: EXAM_CATEGORY_LABELS[category],
        available: exams.length > 0,
        title: first ? [first.subject?.name, subTopic?.name].filter(Boolean).join(" – ") : null,
        questionCount: first ? (first.questions || []).length : 0,
      };
    });
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to load free tests.", error: error.message });
  }
};

// POST /api/free-test/register (public)
const registerForFreeTest = async (req, res) => {
  try {
    const b = req.body || {};
    const name = clean(b.name, 50);
    const email = clean(b.email, 200).toLowerCase();
    const phone = clean(b.phone, 20).replace(/[^\d+]/g, "");
    const city = clean(b.city, 80);
    const category = clean(b.category, 30);
    const password = String(b.password || "");

    if (name.length < 2) return res.status(400).json({ success: false, message: "Please enter your full name." });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ success: false, message: "Please enter a valid email address." });
    if (phone.replace(/\D/g, "").length < 10) {
      return res.status(400).json({ success: false, message: "Please enter a valid 10-digit mobile number." });
    }
    if (!city) return res.status(400).json({ success: false, message: "Please enter your city." });
    if (!EXAM_CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, message: "Please choose your target exam." });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
    }
    if (!b.consent) {
      return res.status(400).json({ success: false, message: "Please agree to be contacted by the academy." });
    }

    const byCat = await freeExamsByCategory();
    if (!(byCat.get(category) || []).length) {
      return res.status(400).json({ success: false, message: "The free test for this exam is not open yet. Please check back soon." });
    }

    const existing = await userModel.findOne({ email }).select("accountType role");
    if (existing) {
      return res.status(409).json({
        success: false,
        message:
          existing.accountType === "free_trial"
            ? "You have already registered with this email. Please log in to take or review your free test."
            : "This email already has an academy account. Please log in.",
      });
    }

    const hashed = await bcrypt.hash(password, await bcrypt.genSalt(10));
    const details = {
      phone,
      city,
      qualification: clean(b.qualification),
      college: clean(b.college),
      passingYear: clean(b.passingYear, 10),
      currentStatus: clean(b.currentStatus, 60),
      heardFrom: clean(b.heardFrom, 60),
      registeredAt: new Date(),
    };
    const user = await userModel.create({
      username: name,
      email,
      password: hashed,
      role: "student",
      category,
      accountType: "free_trial",
      freeTestDetails: details,
    });

    // Sign in straight away (same token rules as normal login).
    const token = jwt.sign({ userId: user._id, role: user.role }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || "180d",
    });
    await userModel.findByIdAndUpdate(user._id, { sessionToken: token, lastLoginAt: new Date() });

    // Enquiry record + email to the academy (best effort).
    EnrollmentLead.create({
      studentName: name,
      mobileNumber: phone,
      targetExam: EXAM_CATEGORY_LABELS[category],
      source: "free_test",
    }).catch((err) => console.error("Free test lead save failed:", err.message));
    const lines = [
      `Name: ${name}`,
      `Email: ${email}`,
      `Mobile: ${phone}`,
      `City: ${city}`,
      `Target exam: ${EXAM_CATEGORY_LABELS[category]}`,
      `Qualification: ${details.qualification || "-"}`,
      `College: ${details.college || "-"}`,
      `Year of passing: ${details.passingYear || "-"}`,
      `Current status: ${details.currentStatus || "-"}`,
      `Heard about us from: ${details.heardFrom || "-"}`,
    ];
    Promise.resolve(
      sendMail(
        [ADMIN_NOTIFY_EMAIL],
        `Free test registration: ${name} (${EXAM_CATEGORY_LABELS[category]})`,
        lines.join("\n"),
        `<p>New free test registration</p><p>${lines.map((l) => l.replace(/</g, "&lt;")).join("<br/>")}</p>`
      )
    ).catch((err) => console.error("Free test email failed:", err.message));

    const userResponse = user.toObject();
    delete userResponse.password;
    delete userResponse.sessionToken;
    res.status(201).json({ success: true, user: userResponse, token });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: "This email is already registered. Please log in." });
    }
    console.error("Free test registration failed:", error.message);
    res.status(500).json({ success: false, message: "Registration failed. Please try again.", error: error.message });
  }
};

// GET /api/free-test/registrations?category= (admin)
const listRegistrations = async (req, res) => {
  try {
    const filter = { accountType: "free_trial" };
    if (req.query.category) filter.category = req.query.category;
    const users = await userModel
      .find(filter)
      .select("username email category freeTestDetails createdAt lastLoginAt")
      .sort({ createdAt: -1 })
      .limit(2000)
      .lean();

    const freeExams = await Exam.find({ isFreeTest: true }).select("_id examCode").lean();
    const freeIds = freeExams.map((e) => e._id);
    const codeOf = new Map(freeExams.map((e) => [String(e._id), e.examCode]));

    // Rank among EVERYONE who took that free test (free + regular students).
    const all = await ExamSubmission.find({ examId: { $in: freeIds }, status: "completed" })
      .select("userId examId attemptNumber obtainedMark timetaken completedAt createdAt")
      .lean();
    const latest = getLatestAttemptsOnly(all);
    const byExam = new Map();
    for (const s of latest) {
      const k = String(s.examId);
      if (!byExam.has(k)) byExam.set(k, []);
      byExam.get(k).push(s);
    }
    for (const list of byExam.values()) {
      list.sort((a, b) => (b.obtainedMark || 0) - (a.obtainedMark || 0) || (a.timetaken || 0) - (b.timetaken || 0));
    }
    const resultOf = new Map();
    for (const [examId, list] of byExam) {
      list.forEach((s, i) => {
        resultOf.set(`${s.userId}`, {
          examCode: codeOf.get(examId),
          obtainedMark: s.obtainedMark,
          timeTakenSeconds: s.timetaken,
          rank: i + 1,
          totalTakers: list.length,
          completedAt: s.completedAt || s.createdAt,
          submissionId: s._id,
        });
      });
    }

    const data = users.map((u) => ({
      _id: u._id,
      name: u.username,
      email: u.email,
      category: u.category,
      categoryLabel: EXAM_CATEGORY_LABELS[u.category] || u.category,
      ...(u.freeTestDetails || {}),
      registeredAt: u.freeTestDetails?.registeredAt || u.createdAt,
      lastLoginAt: u.lastLoginAt,
      test: resultOf.get(String(u._id)) || null,
    }));
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to load registrations.", error: error.message });
  }
};

// PATCH /api/free-test/registrations/:userId/convert { registerNumber } (admin)
// Turns a free registrant who joined the academy into a regular student
// (they then fill the student profile; set their enrollment in Users).
const convertToStudent = async (req, res) => {
  try {
    const registerNumber = clean(req.body?.registerNumber, 40);
    if (!registerNumber) {
      return res.status(400).json({ success: false, message: "Register number is required." });
    }
    const taken = await userModel.findOne({ registerNumber }).select("_id");
    if (taken && String(taken._id) !== req.params.userId) {
      return res.status(409).json({ success: false, message: "That register number is already used." });
    }
    const user = await userModel.findOneAndUpdate(
      { _id: req.params.userId, accountType: "free_trial" },
      { $set: { accountType: "student", registerNumber } },
      { new: true }
    ).select("username email category accountType registerNumber");
    if (!user) return res.status(404).json({ success: false, message: "Free registrant not found." });
    res.status(200).json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to convert.", error: error.message });
  }
};

module.exports = { getFreeTestOptions, registerForFreeTest, listRegistrations, convertToStudent };
