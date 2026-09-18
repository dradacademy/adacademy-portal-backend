const mongoose = require("mongoose");

// One document per student — the full registration profile matching the
// academy's printed "Student Profile" + "Rules & Code of Conduct" intake
// form (sections and field names deliberately mirror that document exactly,
// so what the admin sees here matches what they already collect on paper).
// This is filled in by the STUDENT, from their own login, and is visible to
// the admin exactly as submitted — there is no separate parent login in
// this app, so both the student's and the parent's declaration signature
// are captured as typed full names within the same student-submitted form
// (the admin's own instruction: "their digital sign is enough... it should
// mention that they agree with the declarations").
const academicRecordSchema = new mongoose.Schema(
  {
    // Free label matching the printed form's row labels — "B.E. / B.Tech /
    // Degree", "Diploma / HSC (12th)", "SSLC (10th)" — kept as free text
    // (not an enum) so the academy can add a row later without a code
    // change.
    level: { type: String, default: "" },
    institutionName: { type: String, default: "" },
    branchSpecialization: { type: String, default: "" },
    year: { type: String, default: "" },
    percentageOrCgpa: { type: String, default: "" },
  },
  { _id: false }
);

const studentProfileSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },

    // --- Header strip ---
    rollNumber: { type: String, default: "" },
    batchCourse: { type: String, default: "" },
    targetExam: { type: String, default: "" },
    dateOfJoining: { type: Date, default: null },
    batchMode: { type: String, enum: ["", "offline", "online", "hybrid"], default: "" },
    batchTiming: { type: String, enum: ["", "morning", "evening", "weekend"], default: "" },

    // --- 1. Student Personal Details ---
    fullName: { type: String, default: "" },
    gender: { type: String, enum: ["", "male", "female"], default: "" },
    dateOfBirth: { type: Date, default: null },
    aadhaarNo: { type: String, default: "" },
    bloodGroup: { type: String, default: "" },
    primaryMobile: { type: String, default: "" },
    whatsappNo: { type: String, default: "" },
    personalEmail: { type: String, default: "" },
    studentType: { type: String, enum: ["", "day_scholar", "hosteller_pg"], default: "" },
    // The passport-size photo — stored in the same shared GridFS bucket as
    // attachments/answer sheets (see utils/gridfsHelper.js).
    photoGridFsFileId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // --- 2. Parent / Permanent Guardian Details ---
    fatherName: { type: String, default: "" },
    fatherOccupation: { type: String, default: "" },
    motherName: { type: String, default: "" },
    motherOccupation: { type: String, default: "" },
    fatherContactNo: { type: String, default: "" },
    motherContactNo: { type: String, default: "" },
    parentWhatsappNo: { type: String, default: "" },
    parentEmailId: { type: String, default: "" },
    permanentHomeAddress: { type: String, default: "" },
    districtState: { type: String, default: "" },
    pinCode: { type: String, default: "" },

    // --- 3. Emergency Contact & Local Accommodation Details ---
    emergencyContactPerson: { type: String, default: "" },
    emergencyRelationship: { type: String, default: "" },
    emergencyMobileNo: { type: String, default: "" }, // marked "Mandatory" on the form
    alternativePhoneNo: { type: String, default: "" },
    hostelPgRentalAddress: { type: String, default: "" },
    localGuardianRoommateName: { type: String, default: "" },
    guardianPgContactNo: { type: String, default: "" },

    // --- 4. Academic Background & Qualifications ---
    academicRecords: { type: [academicRecordSchema], default: [] },

    // --- Joint Declaration & Undertaking ---
    // Both signatures are typed full names, captured with the exact
    // acknowledgment text they agreed to and a timestamp — a lightweight
    // "digital signature" per the admin's explicit instruction not to
    // pursue anything heavier.
    studentAgreed: { type: Boolean, default: false },
    studentSignatureName: { type: String, default: "" },
    studentSignedAt: { type: Date, default: null },
    parentAgreed: { type: Boolean, default: false },
    parentSignatureName: { type: String, default: "" },
    parentSignedAt: { type: Date, default: null },

    // "draft" until the student has saved at least once; "submitted" once
    // both declaration signatures are in place — this is what the admin's
    // list view uses to see who has completed their registration profile.
    status: { type: String, enum: ["draft", "submitted"], default: "draft" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("StudentProfile", studentProfileSchema);
