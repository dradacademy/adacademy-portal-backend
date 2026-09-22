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
const GOLD_ACCENT = "#c9a227";
const LIGHT_BORDER = "#d9dee5";
const STATUS_GREEN = "#166534";
const STATUS_AMBER = "#b45309";

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
//
// Layout mirrors the academy's printed intake form: a navy/gold header band
// with a passport-photo box, a shaded banner + bordered two-column grid per
// section, a proper academic-records table, and a full rules/declaration
// section with typed-signature blocks — see the design review this was
// built against (student: Sakthivel G, 2026-09-22) for the reference look.
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

    const HEADER_H = 140;
    const PHOTO_W = 99; // ~35mm
    const PHOTO_H = 127; // ~45mm

    const doc = new PDFDocument({
      size: "A4",
      margins: { top: HEADER_H + 18, bottom: 46, left: 40, right: 40 },
      bufferPages: true,
    });

    const safeName = (student.username || "student").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}-profile.pdf"`);
    doc.pipe(res);

    const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bottomLimit = doc.page.height - doc.page.margins.bottom;
    const PHOTO_X = doc.page.width - doc.page.margins.right - PHOTO_W;
    const PHOTO_Y = 7;

    const categoryLabel = EXAM_CATEGORY_LABELS[student.category] || student.category || "—";

    // Full-width navy header band, redrawn on every page (addPage below
    // re-invokes this) so a printed page is always identifiable on its own
    // — but the photo box outline/image is only placed once, on page 1.
    let headerDrawCount = 0;
    const drawHeaderBand = () => {
      headerDrawCount += 1;
      doc.rect(0, 0, doc.page.width, HEADER_H).fill(BRAND_COLOR);
      doc.rect(0, HEADER_H - 3, doc.page.width, 3).fill(GOLD_ACCENT);
      doc
        .fillColor("#ffffff")
        .font("Helvetica-Bold")
        .fontSize(18)
        .text("Dr. A.D. Academy of Excellence", doc.page.margins.left, 22, { width: contentWidth - PHOTO_W - 14 });
      doc
        .font("Helvetica")
        .fontSize(11)
        .fillColor("#cfe0f2")
        .text("Student Enrollment & Profile Form", doc.page.margins.left, 47, { width: contentWidth - PHOTO_W - 14 });
      doc
        .font("Helvetica")
        .fontSize(8.5)
        .fillColor("#9db6d1")
        .text(`Register No: ${orDash(student.registerNumber)}   ·   ${categoryLabel}`, doc.page.margins.left, 66, {
          width: contentWidth - PHOTO_W - 14,
        });

      if (headerDrawCount === 1) {
        doc.rect(PHOTO_X, PHOTO_Y, PHOTO_W, PHOTO_H).lineWidth(1.5).stroke(GOLD_ACCENT);
      }

      doc.fillColor(TEXT_COLOR).font("Helvetica");
      doc.y = HEADER_H + 16;
    };

    doc.on("pageAdded", drawHeaderBand);
    drawHeaderBand();

    // Passport photo — placed into the header's photo box once, right after
    // the first header draw. Missing/corrupt GridFS entries are swallowed
    // here so a bad photo never fails the whole PDF; no photo on file just
    // leaves the gold-bordered box with a plain placeholder label.
    if (profile?.photoGridFsFileId) {
      try {
        const photoBuffer = await getFileBuffer(profile.photoGridFsFileId);
        doc.image(photoBuffer, PHOTO_X + 2, PHOTO_Y + 2, {
          width: PHOTO_W - 4,
          height: PHOTO_H - 4,
          fit: [PHOTO_W - 4, PHOTO_H - 4],
          align: "center",
          valign: "center",
        });
      } catch (photoError) {
        console.error("Profile PDF: failed to load photo, continuing without it:", photoError.message);
      }
    } else {
      doc
        .font("Helvetica")
        .fontSize(7)
        .fillColor("#ffffff")
        .text("Passport Size\nPhoto\n(35mm × 45mm)", PHOTO_X + 4, PHOTO_Y + PHOTO_H / 2 - 14, {
          width: PHOTO_W - 8,
          align: "center",
        });
      doc.fillColor(TEXT_COLOR);
    }

    const ensureSpace = (needed) => {
      if (doc.y + needed > bottomLimit) {
        doc.addPage();
      }
    };

    // Section banner. `solid` gives the special navy-fill treatment used
    // once, for the Enrollment & Course Details banner at the top — every
    // other section uses the lighter tint-on-navy-text style.
    const drawSectionHeader = (title, opts = {}) => {
      ensureSpace(30);
      const y = doc.y;
      const h = 22;
      if (opts.solid) {
        doc.rect(doc.page.margins.left, y, contentWidth, h).fill(BRAND_COLOR);
        doc.rect(doc.page.margins.left, y, 4, h).fill(GOLD_ACCENT);
        doc
          .fillColor("#ffffff")
          .font("Helvetica-Bold")
          .fontSize(10.5)
          .text(title, doc.page.margins.left + 12, y + 6, { width: contentWidth - 20 });
      } else {
        doc.rect(doc.page.margins.left, y, contentWidth, h).fill(BRAND_TINT);
        doc.rect(doc.page.margins.left, y, 4, h).fill(BRAND_COLOR);
        doc
          .fillColor(BRAND_COLOR)
          .font("Helvetica-Bold")
          .fontSize(10.5)
          .text(title, doc.page.margins.left + 12, y + 6, { width: contentWidth - 20 });
      }
      doc.y = y + h + 8;
      doc.fillColor(TEXT_COLOR).font("Helvetica");
    };

    // Bordered, two-column key/value grid — the main building block for
    // every section below the header. `fields` is [{label, value, full?}];
    // consecutive non-`full` fields are paired left/right, a `full` field
    // (e.g. a long address) gets its own full-width row. Row heights are
    // measured up front so long values wrap cleanly without overlap, and
    // the whole grid tries to stay together on one page.
    const drawKvGrid = (fields) => {
      const colGap = 14;
      const labelWidth = 108;
      const rowPadY = 5;
      const halfWidth = (contentWidth - colGap) / 2;

      doc.font("Helvetica").fontSize(9);

      const rows = [];
      let pending = null;
      fields.forEach((f) => {
        if (f.full) {
          if (pending) {
            rows.push([pending]);
            pending = null;
          }
          rows.push([f]);
        } else if (!pending) {
          pending = f;
        } else {
          rows.push([pending, f]);
          pending = null;
        }
      });
      if (pending) rows.push([pending]);

      const measured = rows.map((row) => {
        if (row.length === 1) {
          const valueWidth = contentWidth - labelWidth - 24;
          const h = doc.heightOfString(orDash(row[0].value), { width: valueWidth });
          return { row, height: Math.max(16, h + rowPadY * 2) };
        }
        const valueWidth = halfWidth - labelWidth - 14;
        const h1 = doc.heightOfString(orDash(row[0].value), { width: valueWidth });
        const h2 = row[1] ? doc.heightOfString(orDash(row[1].value), { width: valueWidth }) : 0;
        return { row, height: Math.max(16, Math.max(h1, h2) + rowPadY * 2) };
      });

      const totalHeight = measured.reduce((sum, r) => sum + r.height, 0);
      ensureSpace(totalHeight + 4);

      const gridTop = doc.y;
      const gridLeft = doc.page.margins.left;
      doc.rect(gridLeft, gridTop, contentWidth, totalHeight).lineWidth(0.75).stroke(LIGHT_BORDER);

      let rowY = gridTop;
      measured.forEach((m, idx) => {
        const { row, height } = m;
        if (row.length === 1) {
          const f = row[0];
          doc
            .font("Helvetica-Bold")
            .fontSize(9)
            .fillColor(MUTED_COLOR)
            .text(f.label, gridLeft + 8, rowY + rowPadY, { width: labelWidth });
          doc
            .font("Helvetica")
            .fontSize(9)
            .fillColor(TEXT_COLOR)
            .text(orDash(f.value), gridLeft + 8 + labelWidth + 6, rowY + rowPadY, {
              width: contentWidth - labelWidth - 30,
            });
        } else {
          const [f1, f2] = row;
          doc
            .font("Helvetica-Bold")
            .fontSize(9)
            .fillColor(MUTED_COLOR)
            .text(f1.label, gridLeft + 8, rowY + rowPadY, { width: labelWidth });
          doc
            .font("Helvetica")
            .fontSize(9)
            .fillColor(TEXT_COLOR)
            .text(orDash(f1.value), gridLeft + 8 + labelWidth + 6, rowY + rowPadY, {
              width: halfWidth - labelWidth - 14,
            });
          if (f2) {
            const col2X = gridLeft + halfWidth + colGap;
            doc
              .font("Helvetica-Bold")
              .fontSize(9)
              .fillColor(MUTED_COLOR)
              .text(f2.label, col2X, rowY + rowPadY, { width: labelWidth });
            doc
              .font("Helvetica")
              .fontSize(9)
              .fillColor(TEXT_COLOR)
              .text(orDash(f2.value), col2X + labelWidth + 6, rowY + rowPadY, {
                width: halfWidth - labelWidth - 14,
              });
          }
        }
        if (idx < measured.length - 1) {
          doc
            .moveTo(gridLeft, rowY + height)
            .lineTo(gridLeft + contentWidth, rowY + height)
            .lineWidth(0.5)
            .strokeColor(LIGHT_BORDER)
            .stroke();
        }
        rowY += height;
      });

      doc.y = gridTop + totalHeight + 10;
      doc.fillColor(TEXT_COLOR).font("Helvetica");
    };

    // --- Incomplete-profile notice (kept above Enrollment, same as before) ---
    if (!profile) {
      ensureSpace(20);
      doc
        .fontSize(9.5)
        .font("Helvetica-Bold")
        .fillColor(STATUS_AMBER)
        .text("This student has not started their profile yet — the fields below are blank.", { width: contentWidth });
      doc.moveDown(0.6);
      doc.fillColor(TEXT_COLOR).font("Helvetica");
    }

    // --- Enrollment & Course Details ---
    drawSectionHeader("Enrollment & Course Details", { solid: true });
    drawKvGrid([
      { label: "Register Number", value: student.registerNumber },
      { label: "Roll Number", value: profile?.rollNumber },
      { label: "Category", value: categoryLabel },
      { label: "Target Exam", value: profile?.targetExam },
      { label: "Date of Joining", value: formatPdfDate(profile?.dateOfJoining) },
      {
        label: "Batch Mode / Timing",
        value: [profile?.batchMode, profile?.batchTiming].filter(Boolean).join(" / ") || null,
      },
      { label: "Batch / Course", value: profile?.batchCourse },
    ]);

    // --- 1. Personal Details ---
    drawSectionHeader("1.  Student Personal Details");
    drawKvGrid([
      { label: "Full Name", value: profile?.fullName },
      { label: "Gender", value: profile?.gender },
      { label: "Date of Birth", value: formatPdfDate(profile?.dateOfBirth) },
      { label: "Blood Group", value: profile?.bloodGroup },
      { label: "Primary Mobile", value: profile?.primaryMobile },
      { label: "WhatsApp No.", value: profile?.whatsappNo },
      { label: "Personal Email", value: profile?.personalEmail || student.email },
      {
        label: "Student Type",
        value:
          profile?.studentType === "day_scholar"
            ? "Day Scholar"
            : profile?.studentType === "hosteller_pg"
            ? "Hosteller / PG"
            : profile?.studentType,
      },
      { label: "Aadhaar No.", value: profile?.aadhaarNo, full: true },
    ]);

    // --- 2. Parent / Guardian Details ---
    drawSectionHeader("2.  Parent / Guardian Details");
    drawKvGrid([
      { label: "Father's Name", value: profile?.fatherName },
      { label: "Father's Occupation", value: profile?.fatherOccupation },
      { label: "Mother's Name", value: profile?.motherName },
      { label: "Mother's Occupation", value: profile?.motherOccupation },
      { label: "Father's Contact No.", value: profile?.fatherContactNo },
      { label: "Mother's Contact No.", value: profile?.motherContactNo },
      { label: "Parent WhatsApp No.", value: profile?.parentWhatsappNo },
      { label: "Parent Email ID", value: profile?.parentEmailId },
      { label: "Permanent Home Address", value: profile?.permanentHomeAddress, full: true },
      {
        label: "District / State / PIN",
        value: [profile?.districtState, profile?.pinCode].filter(Boolean).join(" – ") || null,
        full: true,
      },
    ]);

    // --- 3. Emergency Contact & Accommodation ---
    drawSectionHeader("3.  Emergency Contact & Accommodation Details");
    drawKvGrid([
      { label: "Emergency Contact Person", value: profile?.emergencyContactPerson },
      { label: "Relationship", value: profile?.emergencyRelationship },
      { label: "Emergency Mobile No.", value: profile?.emergencyMobileNo },
      { label: "Alternative Phone No.", value: profile?.alternativePhoneNo },
      { label: "Hostel / PG Address", value: profile?.hostelPgRentalAddress },
      { label: "Local Guardian / Roommate", value: profile?.localGuardianRoommateName },
      { label: "Guardian / PG Contact No.", value: profile?.guardianPgContactNo, full: true },
    ]);

    // --- 4. Academic Background & Qualifications (table) ---
    // Forced page break here (not just an overflow-triggered one) so every
    // profile — long or short — lands Academic Records / Rules & Declaration
    // / Signatures on their own page, matching the printed form's fixed
    // page-1 / page-2 layout instead of letting them float wherever section
    // 1–3 happened to end.
    doc.addPage();
    drawSectionHeader("4.  Academic Background & Qualifications");
    const records = profile?.academicRecords || [];
    if (records.length === 0) {
      ensureSpace(20);
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
      doc.moveDown(0.6);
    }

    // --- 5. Academy Rules, Code of Conduct & Joint Declaration ---
    drawSectionHeader("5.  Academy Rules, Code of Conduct & Joint Declaration");

    const rules = [
      { pre: "A minimum of ", bold: "85% attendance", post: " is required for all scheduled classes and test series." },
      { pre: "Strict adherence to classroom discipline, batch timings, and digital portal guidelines is mandatory.", bold: "", post: "" },
      {
        pre: "Academy proprietary study materials, test booklets, and video lectures are strictly for ",
        bold: "personal use only",
        post: " and are non-transferable.",
      },
      { pre: "", bold: "Fee policy: ", post: "Fees paid are non-refundable and non-transferable under any circumstances." },
      { pre: "", bold: "Code of conduct: ", post: "Any misconduct will lead to immediate cancellation of admission." },
    ];

    rules.forEach((rule, idx) => {
      const fullText = `${rule.pre}${rule.bold}${rule.post}`;
      doc.font("Helvetica").fontSize(9);
      const h = doc.heightOfString(fullText, { width: contentWidth - 16 }) + 4;
      ensureSpace(h);
      doc.font("Helvetica-Bold").fontSize(9).fillColor(TEXT_COLOR).text(`${idx + 1}.`, doc.page.margins.left, doc.y, {
        continued: true,
        width: 14,
      });
      doc.font("Helvetica").text(` ${rule.pre}`, { continued: !!(rule.bold || rule.post) });
      if (rule.bold) {
        doc.font("Helvetica-Bold").text(rule.bold, { continued: !!rule.post });
      }
      if (rule.post) {
        doc.font("Helvetica").text(rule.post);
      }
      doc.moveDown(0.35);
      doc.font("Helvetica").fillColor(TEXT_COLOR);
    });
    doc.moveDown(0.2);

    // Declaration paragraph, in a shaded bordered box.
    const declText =
      "I/We, the undersigned student and parent/guardian, have read and understood the above rules and code of conduct of Dr. A.D. Academy of Excellence, and hereby agree to abide by them in full for the entire duration of the course. This declaration was recorded as a typed digital signature at the time of profile submission.";
    const declWidth = contentWidth - 24;
    doc.font("Helvetica").fontSize(8.5);
    const declHeight = doc.heightOfString(declText, { width: declWidth }) + 18;
    ensureSpace(declHeight + 8);
    const declY = doc.y;
    doc
      .rect(doc.page.margins.left, declY, contentWidth, declHeight)
      .lineWidth(0.75)
      .fillAndStroke("#f9fafb", LIGHT_BORDER);
    doc
      .font("Helvetica")
      .fontSize(8.5)
      .fillColor("#374151")
      .text(declText, doc.page.margins.left + 12, declY + 9, { width: declWidth });
    doc.y = declY + declHeight + 10;
    doc.fillColor(TEXT_COLOR);

    // Profile status line.
    ensureSpace(18);
    const submitted = profile?.status === "submitted";
    doc.font("Helvetica-Bold").fontSize(9).fillColor(TEXT_COLOR).text("Profile Status:  ", doc.page.margins.left, doc.y, {
      continued: true,
    });
    doc
      .fillColor(submitted ? STATUS_GREEN : STATUS_AMBER)
      .text(submitted ? "Submitted — Complete" : "Draft — Incomplete", { continued: true });
    doc
      .font("Helvetica")
      .fillColor(MUTED_COLOR)
      .text(submitted && profile?.studentSignedAt ? `   (Digitally agreed on ${formatPdfDate(profile.studentSignedAt)})` : "");
    doc.moveDown(1.1);
    doc.fillColor(TEXT_COLOR);

    // Signature blocks, side by side.
    ensureSpace(60);
    const sigY = doc.y;
    const sigColWidth = (contentWidth - 24) / 2;
    const drawSigBlock = (x, name, role, dateLabel) => {
      doc
        .font("Helvetica-Oblique")
        .fontSize(15)
        .fillColor(BRAND_COLOR)
        .text(orDash(name), x, sigY, { width: sigColWidth });
      const lineY = sigY + 24;
      doc.moveTo(x, lineY).lineTo(x + sigColWidth - 10, lineY).lineWidth(0.75).strokeColor(TEXT_COLOR).stroke();
      doc
        .font("Helvetica-Bold")
        .fontSize(8.4)
        .fillColor(TEXT_COLOR)
        .text(role, x, lineY + 5, { continued: true, width: sigColWidth });
      doc.font("Helvetica").fillColor(MUTED_COLOR).text(`   ·   Date: ${dateLabel}`);
    };
    drawSigBlock(
      doc.page.margins.left,
      profile?.studentSignatureName,
      "Student Signature",
      profile?.studentSignedAt ? formatPdfDate(profile.studentSignedAt) : "—"
    );
    drawSigBlock(
      doc.page.margins.left + sigColWidth + 24,
      profile?.parentSignatureName,
      "Parent / Guardian Signature",
      profile?.parentSignedAt ? formatPdfDate(profile.parentSignedAt) : "—"
    );
    doc.y = sigY + 48;
    doc.fillColor(TEXT_COLOR).font("Helvetica");

    // Footer with generation timestamp + page numbers on every page.
    const pageRange = doc.bufferedPageRange();
    for (let i = 0; i < pageRange.count; i++) {
      doc.switchToPage(pageRange.start + i);
      doc
        .fontSize(7.5)
        .fillColor(MUTED_COLOR)
        .text(
          `Dr. A.D. Academy of Excellence  ·  Generated ${formatPdfDate(new Date())}  ·  Page ${i + 1} of ${pageRange.count}  ·  This document is system-generated and confidential.`,
          doc.page.margins.left,
          doc.page.height - 28,
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
