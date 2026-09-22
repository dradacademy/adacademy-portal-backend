const PDFDocument = require("pdfkit");
const studentProfileModel = require("../models/studentProfileModel");
const userModel = require("../models/userModel");
const { uploadBufferToGridFs, streamFileToResponse, getFileBuffer, deleteFile } = require("../utils/gridfsHelper");
const { EXAM_CATEGORY_LABELS } = require("../constants/examCategories");

// Brand navy used across the manifest/theme — reused here so the PDF reads
// as the same "brand" as the app/site rather than a generic document.
const BRAND_COLOR = "#0f2a4a";
const BRAND_TINT = "#e8edf3";
const TEXT_COLOR = "#1f2933";
const MUTED_COLOR = "#6b7280";

const formatPdfDate = (value) => {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

const orDash = (value) => (value === undefined || value === null || value === "" ? "—" : String(value));

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

// GET /api/student-profiles/:userId/pdf (admin only) — a neatly laid out,
// color, A4-print-ready PDF of the student's full profile, generated live
// from whatever is currently in the database. Nothing is pre-rendered or
// cached, so this works identically for a profile submitted years ago and
// one submitted a minute ago — there's no separate "PDF export" data path
// to keep in sync with the form.
const generateProfilePdf = async (req, res) => {
  try {
    const { userId } = req.params;
    const student = await userModel
      .findById(userId)
      .select("username email registerNumber category");
    if (!student || student.role === "admin") {
      return res.status(404).json({ success: false, message: "Student not found." });
    }

    const profile = await studentProfileModel.findOne({ userId });

    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 90, bottom: 48, left: 48, right: 48 },
      bufferPages: true,
    });

    const safeName = (student.username || "student").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}-profile.pdf"`);
    doc.pipe(res);

    const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bottomLimit = doc.page.height - doc.page.margins.bottom;

    // Full-width navy header band with the academy name — drawn on every
    // page (addPage below re-invokes this), so a printed page is always
    // identifiable even if pages get separated.
    const drawHeaderBand = () => {
      doc.rect(0, 0, doc.page.width, 64).fill(BRAND_COLOR);
      doc
        .fillColor("#ffffff")
        .font("Helvetica-Bold")
        .fontSize(15)
        .text("Dr. A.D. Academy of Excellence", doc.page.margins.left, 18, { width: contentWidth });
      doc
        .font("Helvetica")
        .fontSize(10)
        .fillColor("#cbd5e1")
        .text("Student Profile", doc.page.margins.left, 40, { width: contentWidth });
      doc.fillColor(TEXT_COLOR).font("Helvetica");
      doc.y = 82;
    };

    doc.on("pageAdded", drawHeaderBand);
    drawHeaderBand();

    const ensureSpace = (needed) => {
      if (doc.y + needed > bottomLimit) {
        doc.addPage();
      }
    };

    const drawSectionHeader = (title) => {
      ensureSpace(34);
      const y = doc.y;
      doc.rect(doc.page.margins.left, y, contentWidth, 20).fill(BRAND_TINT);
      doc
        .fillColor(BRAND_COLOR)
        .font("Helvetica-Bold")
        .fontSize(10.5)
        .text(title, doc.page.margins.left + 8, y + 5, { width: contentWidth - 16 });
      doc.y = y + 20 + 8;
      doc.fillColor(TEXT_COLOR).font("Helvetica");
    };

    const writeField = (label, value) => {
      ensureSpace(16);
      doc
        .fontSize(9.5)
        .font("Helvetica-Bold")
        .fillColor(MUTED_COLOR)
        .text(`${label}:  `, doc.page.margins.left, doc.y, { continued: true, width: contentWidth })
        .font("Helvetica")
        .fillColor(TEXT_COLOR)
        .text(orDash(value));
      doc.moveDown(0.3);
    };

    // --- Student header strip ---
    if (!profile) {
      doc
        .fontSize(10)
        .fillColor("#b45309")
        .text(
          "This student has not started their profile yet — the fields below are blank.",
          { width: contentWidth }
        );
      doc.moveDown(0.5);
      doc.fillColor(TEXT_COLOR);
    }

    writeField("Register Number", student.registerNumber);
    writeField("Category", EXAM_CATEGORY_LABELS[student.category] || student.category);
    writeField("Roll Number", profile?.rollNumber);
    writeField("Batch / Course", profile?.batchCourse);
    writeField("Target Exam", profile?.targetExam);
    writeField("Date of Joining", formatPdfDate(profile?.dateOfJoining));
    writeField("Batch Mode / Timing", [profile?.batchMode, profile?.batchTiming].filter(Boolean).join(" / "));
    doc.moveDown(0.4);

    // Passport photo — own row, top-right, drawn independently of the text
    // flow below so it never overlaps a field row. Missing/corrupt GridFS
    // entries are swallowed here so a bad photo never fails the whole PDF.
    if (profile?.photoGridFsFileId) {
      try {
        const photoBuffer = await getFileBuffer(profile.photoGridFsFileId);
        const photoWidth = 78;
        const photoHeight = 94;
        const photoX = doc.page.width - doc.page.margins.right - photoWidth;
        const photoY = doc.y;
        doc.save();
        doc.rect(photoX - 2, photoY - 2, photoWidth + 4, photoHeight + 4).lineWidth(1).stroke(MUTED_COLOR);
        doc.image(photoBuffer, photoX, photoY, { width: photoWidth, height: photoHeight, fit: [photoWidth, photoHeight] });
        doc.restore();
      } catch (photoError) {
        console.error("Profile PDF: failed to load photo, continuing without it:", photoError.message);
      }
    }

    // --- 1. Personal Details ---
    drawSectionHeader("1. Student Personal Details");
    writeField("Full Name", profile?.fullName);
    writeField("Gender", profile?.gender);
    writeField("Date of Birth", formatPdfDate(profile?.dateOfBirth));
    writeField("Aadhaar No.", profile?.aadhaarNo);
    writeField("Blood Group", profile?.bloodGroup);
    writeField("Primary Mobile", profile?.primaryMobile);
    writeField("WhatsApp No.", profile?.whatsappNo);
    writeField("Personal Email", profile?.personalEmail || student.email);
    writeField("Student Type", profile?.studentType === "day_scholar" ? "Day Scholar" : profile?.studentType === "hosteller_pg" ? "Hosteller / PG" : profile?.studentType);

    // --- 2. Parent / Guardian Details ---
    drawSectionHeader("2. Parent / Permanent Guardian Details");
    writeField("Father's Name", profile?.fatherName);
    writeField("Father's Occupation", profile?.fatherOccupation);
    writeField("Mother's Name", profile?.motherName);
    writeField("Mother's Occupation", profile?.motherOccupation);
    writeField("Father's Contact No.", profile?.fatherContactNo);
    writeField("Mother's Contact No.", profile?.motherContactNo);
    writeField("Parent WhatsApp No.", profile?.parentWhatsappNo);
    writeField("Parent Email ID", profile?.parentEmailId);
    writeField("Permanent Home Address", profile?.permanentHomeAddress);
    writeField("District / State", profile?.districtState);
    writeField("PIN Code", profile?.pinCode);

    // --- 3. Emergency Contact & Local Accommodation ---
    drawSectionHeader("3. Emergency Contact & Local Accommodation Details");
    writeField("Emergency Contact Person", profile?.emergencyContactPerson);
    writeField("Relationship", profile?.emergencyRelationship);
    writeField("Emergency Mobile No.", profile?.emergencyMobileNo);
    writeField("Alternative Phone No.", profile?.alternativePhoneNo);
    writeField("Hostel / PG Rental Address", profile?.hostelPgRentalAddress);
    writeField("Local Guardian / Roommate Name", profile?.localGuardianRoommateName);
    writeField("Guardian / PG Contact No.", profile?.guardianPgContactNo);

    // --- 4. Academic Background & Qualifications (table) ---
    drawSectionHeader("4. Academic Background & Qualifications");
    const records = profile?.academicRecords || [];
    if (records.length === 0) {
      doc.fontSize(9.5).fillColor(MUTED_COLOR).text("No academic records provided.", { width: contentWidth });
      doc.fillColor(TEXT_COLOR);
      doc.moveDown(0.5);
    } else {
      const colFractions = [0.2, 0.28, 0.24, 0.12, 0.16];
      const colLabels = ["Level", "Institution", "Branch / Specialization", "Year", "% / CGPA"];
      const colWidths = colFractions.map((f) => f * contentWidth);
      const colX = [doc.page.margins.left];
      for (let i = 0; i < colWidths.length - 1; i++) colX.push(colX[i] + colWidths[i]);

      const rowHeight = 22;
      ensureSpace(rowHeight);
      let y = doc.y;
      doc.rect(doc.page.margins.left, y, contentWidth, rowHeight).fill(BRAND_COLOR);
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8.5);
      colLabels.forEach((label, i) => {
        doc.text(label, colX[i] + 4, y + 7, { width: colWidths[i] - 8 });
      });
      doc.y = y + rowHeight;
      doc.fillColor(TEXT_COLOR).font("Helvetica");

      records.forEach((record, idx) => {
        ensureSpace(rowHeight);
        y = doc.y;
        if (idx % 2 === 1) {
          doc.rect(doc.page.margins.left, y, contentWidth, rowHeight).fill("#f5f6f8");
          doc.fillColor(TEXT_COLOR);
        }
        doc.font("Helvetica").fontSize(8.5);
        const values = [
          record.level,
          record.institutionName,
          record.branchSpecialization,
          record.year,
          record.percentageOrCgpa,
        ];
        values.forEach((value, i) => {
          doc.fillColor(TEXT_COLOR).text(orDash(value), colX[i] + 4, y + 7, { width: colWidths[i] - 8 });
        });
        doc.y = y + rowHeight;
      });
      doc.moveDown(0.5);
    }

    // --- Declaration & Undertaking ---
    drawSectionHeader("Joint Declaration & Undertaking");
    ensureSpace(60);
    doc
      .fontSize(9)
      .fillColor(MUTED_COLOR)
      .text(
        "The student and parent/guardian each declared agreement to the academy's Rules & Code of Conduct via a typed digital signature.",
        { width: contentWidth }
      );
    doc.moveDown(0.5);
    doc.fillColor(TEXT_COLOR);
    writeField("Student Signature (typed name)", profile?.studentSignatureName);
    writeField("Student Agreed", profile?.studentAgreed ? `Yes — ${formatPdfDate(profile?.studentSignedAt)}` : "Not yet agreed");
    writeField("Parent/Guardian Signature (typed name)", profile?.parentSignatureName);
    writeField("Parent/Guardian Agreed", profile?.parentAgreed ? `Yes — ${formatPdfDate(profile?.parentSignedAt)}` : "Not yet agreed");
    writeField("Profile Status", profile?.status === "submitted" ? "Submitted (complete)" : "Draft (incomplete)");

    // Footer with generation timestamp + page numbers on every page.
    const pageRange = doc.bufferedPageRange();
    for (let i = 0; i < pageRange.count; i++) {
      doc.switchToPage(pageRange.start + i);
      doc
        .fontSize(7.5)
        .fillColor(MUTED_COLOR)
        .text(
          `Generated ${formatPdfDate(new Date())} · Dr. A.D. Academy of Excellence · Page ${i + 1} of ${pageRange.count}`,
          doc.page.margins.left,
          doc.page.height - 30,
          { width: contentWidth, align: "center" }
        );
    }

    doc.end();
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: "Failed to generate profile PDF.",
        error: error.message,
      });
    } else {
      // Headers (and likely some PDF bytes) already went out — can't send a
      // JSON error at this point, just end the response so it doesn't hang.
      res.end();
    }
  }
};

module.exports = {
  getMyProfile,
  saveMyProfile,
  uploadMyPhoto,
  getProfilePhoto,
  listProfilesAdmin,
  getProfileAdmin,
  generateProfilePdf,
};
