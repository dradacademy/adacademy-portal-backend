const enrollmentLeadModel = require("../models/enrollmentLeadModel");

// Loose on purpose — Indian mobile numbers are sometimes typed with a
// leading 0, a +91, spaces, or hyphens. This just rejects obvious junk.
const MOBILE_RE = /^[0-9+\-\s()]{7,20}$/;

const createEnrollmentLead = async (req, res) => {
  try {
    const studentName = (req.body.studentName || "").toString().trim();
    const mobileNumber = (req.body.mobileNumber || "").toString().trim();
    const targetExam = (req.body.targetExam || "").toString().trim();

    if (!studentName || !mobileNumber || !targetExam) {
      return res.status(400).json({
        success: false,
        message:
          "Student name, mobile number, and target exam are all required.",
      });
    }

    if (!MOBILE_RE.test(mobileNumber)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid mobile number.",
      });
    }

    const lead = await enrollmentLeadModel.create({
      studentName,
      mobileNumber,
      targetExam,
    });

    return res.status(201).json({
      success: true,
      message: "Thanks! Our admissions team will reach out to you shortly.",
      data: lead,
    });
  } catch (error) {
    console.error("createEnrollmentLead error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong. Please call or WhatsApp us directly.",
    });
  }
};

module.exports = {
  createEnrollmentLead,
};
