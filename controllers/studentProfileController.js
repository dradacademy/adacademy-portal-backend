const studentProfileModel = require("../models/studentProfileModel");
const userModel = require("../models/userModel");
const { uploadBufferToGridFs, streamFileToResponse, deleteFile } = require("../utils/gridfsHelper");

const FIELD_KEYS = [
  "rollNumber",
  "batchCourse",
  "targetExam",
  "dateOfJoining",
  "batchMode",
  "batchTiming",
  "fullName",
  "gender",
  "dateOfBirth",
  "aadhaarNo",
  "bloodGroup",
  "primaryMobile",
  "whatsappNo",
  "personalEmail",
  "studentType",
  "fatherName",
  "fatherOccupation",
  "motherName",
  "motherOccupation",
  "fatherContactNo",
  "motherContactNo",
  "parentWhatsappNo",
  "parentEmailId",
  "permanentHomeAddress",
  "districtState",
  "pinCode",
  "emergencyContactPerson",
  "emergencyRelationship",
  "emergencyMobileNo",
  "alternativePhoneNo",
  "hostelPgRentalAddress",
  "localGuardianRoommateName",
  "guardianPgContactNo",
  "academicRecords",
  "studentAgreed",
  "studentSignatureName",
  "parentAgreed",
  "parentSignatureName",
];

// GET /api/student-profiles/me (student) — fetch (or lazily create) this
// student's own profile document.
const getMyProfile = async (req, res) => {
  try {
    let profile = await studentProfileModel.findOne({ userId: req.user._id });
    if (!profile) {
      profile = await studentProfileModel.create({
        userId: req.user._id,
        fullName: req.user.username || "",
        rollNumber: req.user.registerNumber || "",
      });
    }
    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load your profile.",
      error: error.message,
    });
  }
};

// PATCH /api/student-profiles/me (student) — saves any subset of the
// profile's fields. Declaration signatures are accepted here too (the
// student's own form submits everything, including both typed
// signatures, in one save) — a signature is only actually recorded (with
// its timestamp) the moment its matching "agreed" flag is sent true, and
// re-saving with the flag already true does NOT refresh the timestamp
// (the original agreement moment is what matters, not every later edit to
// an unrelated field).
const saveMyProfile = async (req, res) => {
  try {
    const existing = await studentProfileModel.findOne({ userId: req.user._id });
    const profile =
      existing || new studentProfileModel({ userId: req.user._id });

    for (const key of FIELD_KEYS) {
      if (req.body[key] === undefined) continue;
      if (key === "studentAgreed") {
        const wasAgreed = profile.studentAgreed;
        profile.studentAgreed = !!req.body.studentAgreed;
        if (profile.studentAgreed && !wasAgreed) {
          profile.studentSignedAt = new Date();
        }
        if (!profile.studentAgreed) {
          profile.studentSignedAt = null;
        }
        continue;
      }
      if (key === "parentAgreed") {
        const wasAgreed = profile.parentAgreed;
        profile.parentAgreed = !!req.body.parentAgreed;
        if (profile.parentAgreed && !wasAgreed) {
          profile.parentSignedAt = new Date();
        }
        if (!profile.parentAgreed) {
          profile.parentSignedAt = null;
        }
        continue;
      }
      profile[key] = req.body[key];
    }

    profile.status =
      profile.studentAgreed && profile.parentAgreed && profile.studentSignatureName && profile.parentSignatureName
        ? "submitted"
        : "draft";

    await profile.save();
    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to save your profile.",
      error: error.message,
    });
  }
};

// POST /api/student-profiles/me/photo (student, multipart "photo" field)
const uploadMyPhoto = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "A photo is required." });
    }

    const profile = await studentProfileModel.findOneAndUpdate(
      { userId: req.user._id },
      {},
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const oldFileId = profile.photoGridFsFileId;
    const newFileId = await uploadBufferToGridFs(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype
    );
    profile.photoGridFsFileId = newFileId;
    await profile.save();

    if (oldFileId) deleteFile(oldFileId).catch(() => {});

    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to upload photo.",
      error: error.message,
    });
  }
};

// GET /api/student-profiles/:userId/photo (the owning student, or admin) —
// streams the passport photo inline, same "no direct file URL" pattern
// used everywhere else in this app.
const getProfilePhoto = async (req, res) => {
  try {
    const { userId } = req.params;
    if (req.user.role !== "admin" && req.user._id.toString() !== userId) {
      return res.status(403).json({ success: false, message: "Forbidden." });
    }

    const profile = await studentProfileModel.findOne({ userId }).select("photoGridFsFileId");
    if (!profile || !profile.photoGridFsFileId) {
      return res.status(404).json({ success: false, message: "No photo on file." });
    }

    res.setHeader("Content-Disposition", "inline");
    await streamFileToResponse(profile.photoGridFsFileId, res);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: "Failed to load photo.",
        error: error.message,
      });
    }
  }
};

// GET /api/student-profiles (admin only) — every student, with their
// profile completion status, for the admin's "Student Profiles" list.
const listProfilesAdmin = async (req, res) => {
  try {
    const { category, search, status } = req.query;

    const userMatch = { role: "student" };
    if (category) userMatch.category = category;
    if (search) {
      const regex = new RegExp(search.trim(), "i");
      userMatch.$or = [{ username: regex }, { email: regex }, { registerNumber: regex }];
    }

    const students = await userModel
      .find(userMatch)
      .select("username email registerNumber category")
      .lean();
    const studentIds = students.map((s) => s._id);

    const profiles = await studentProfileModel
      .find({ userId: { $in: studentIds } })
      .select("userId status studentAgreed parentAgreed fullName rollNumber updatedAt")
      .lean();
    const profileByUser = new Map(profiles.map((p) => [p.userId.toString(), p]));

    let rows = students.map((s) => {
      const p = profileByUser.get(s._id.toString());
      return {
        studentId: s._id,
        name: s.username,
        email: s.email,
        registerNumber: s.registerNumber,
        category: s.category,
        profileStatus: p?.status || "not_started",
        studentAgreed: !!p?.studentAgreed,
        parentAgreed: !!p?.parentAgreed,
        lastUpdatedAt: p?.updatedAt || null,
      };
    });

    if (status) rows = rows.filter((r) => r.profileStatus === status);

    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to list student profiles.",
      error: error.message,
    });
  }
};

// GET /api/student-profiles/:userId (admin only) — the full profile detail
// exactly as the student submitted it, matching every section of the
// printed intake form.
const getProfileAdmin = async (req, res) => {
  try {
    const { userId } = req.params;
    const student = await userModel
      .findById(userId)
      .select("username email registerNumber category");
    if (!student || student.role === "admin") {
      return res.status(404).json({ success: false, message: "Student not found." });
    }

    const profile = await studentProfileModel.findOne({ userId });

    res.status(200).json({
      success: true,
      data: {
        student: {
          studentId: student._id,
          name: student.username,
          email: student.email,
          registerNumber: student.registerNumber,
          category: student.category,
        },
        profile: profile || null,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load student profile.",
      error: error.message,
    });
  }
};

module.exports = {
  getMyProfile,
  saveMyProfile,
  uploadMyPhoto,
  getProfilePhoto,
  listProfilesAdmin,
  getProfileAdmin,
};
