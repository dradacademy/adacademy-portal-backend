const enrollmentLeadModel = require("../models/enrollmentLeadModel");
const sendMail = require("../utils/sendMail");

// Loose on purpose — Indian mobile numbers are sometimes typed with a
// leading 0, a +91, spaces, or hyphens. This just rejects obvious junk.
const MOBILE_RE = /^[0-9+\-\s()]{7,20}$/;

const VALID_SOURCES = ["enroll_form", "callback_request"];

// Every lead — whether the full enrollment form or the quick "Request a
// Callback" button — notifies the admissions inbox directly, so nobody has
// to check the database to know a prospective student reached out. This is
// best-effort: if it fails (or NODEMAILER_USER/PASS aren't configured), the
// lead is still saved and the public-facing request still succeeds.
const ADMIN_NOTIFY_EMAIL = "dradacademy@gmail.com";

const SOURCE_LABELS = {
  enroll_form: "Enrollment Inquiry",
  callback_request: "Callback Request",
};

const notifyAdminOfLead = (lead) => {
  const label = SOURCE_LABELS[lead.source] || "Website Lead";
  const subject = `New ${label} — ${lead.studentName}`;
  const receivedAt = new Date(lead.createdAt || Date.now()).toLocaleString(
    "en-IN",
    { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }
  );

  const rows = [
    ["Type", label],
    ["Name", lead.studentName],
    ["Mobile", lead.mobileNumber],
    ...(lead.targetExam ? [["Target Exam", lead.targetExam]] : []),
    ["Received", `${receivedAt} IST`],
  ];

  const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n");
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#1a1a1a;">
      <h2 style="margin:0 0 12px;">New ${label}</h2>
      <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;">
        ${rows
          .map(
            ([k, v]) =>
              `<tr><td style="font-weight:bold;padding-right:16px;">${k}</td><td>${v}</td></tr>`
          )
          .join("")}
      </table>
      <p style="margin-top:16px;color:#666;">Sent automatically from the Dr. A.D. Academy of Excellence website.</p>
    </div>
  `;

  // Fire-and-forget from the caller's perspective — sendMail already
  // catches its own errors and just logs them, so a lead is never lost or
  // delayed by an email hiccup.
  sendMail([ADMIN_NOTIFY_EMAIL], subject, text, html);
};

const createEnrollmentLead = async (req, res) => {
  try {
    const studentName = (req.body.studentName || "").toString().trim();
    const mobileNumber = (req.body.mobileNumber || "").toString().trim();
    const targetExam = (req.body.targetExam || "").toString().trim();
    const rawSource = (req.body.source || "").toString().trim();
    const source = VALID_SOURCES.includes(rawSource)
      ? rawSource
      : "enroll_form";

    if (!studentName || !mobileNumber) {
      return res.status(400).json({
        success: false,
        message: "Student name and mobile number are required.",
      });
    }

    // The full enrollment form still requires a target exam; the quick
    // "Request a Callback" button intentionally doesn't ask for one.
    if (source === "enroll_form" && !targetExam) {
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
      targetExam: targetExam || null,
      source,
    });

    notifyAdminOfLead(lead);

    return res.status(201).json({
      success: true,
      message:
        source === "callback_request"
          ? "Thanks! Our admissions team will call you back shortly."
          : "Thanks! Our admissions team will reach out to you shortly.",
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
