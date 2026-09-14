const careerApplicationModel = require("../models/careerApplicationModel");
const sendMail = require("../utils/sendMail");

// Same loose check as enrollmentLeadController.js — just rejects obvious
// junk, tolerant of how people actually type Indian mobile numbers.
const MOBILE_RE = /^[0-9+\-\s()]{7,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ADMIN_NOTIFY_EMAIL = "dradacademy@gmail.com";

const notifyAdminOfApplication = (application) => {
  const subject = `New Career Application — ${application.fullName}`;
  const receivedAt = new Date(
    application.createdAt || Date.now()
  ).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });

  const rows = [
    ["Name", application.fullName],
    ["Contact", application.contactNumber],
    ["Email", application.email],
    ...(application.qualification
      ? [["Qualification", application.qualification]]
      : []),
    ...(application.college ? [["College/University", application.college]] : []),
    ...(application.cgpa ? [["CGPA/Percentage", application.cgpa]] : []),
    [
      "GATE Qualified",
      application.gateQualified
        ? `Yes${application.gateScore ? ` (Score: ${application.gateScore})` : ""}`
        : "No",
    ],
    ...(application.experience
      ? [["Experience", application.experience]]
      : []),
    ...(application.subjects?.length
      ? [["Subjects", application.subjects.join(", ")]]
      : []),
    ...(application.resumeUrl
      ? [["Resume", application.resumeUrl]]
      : [["Resume", "Not attached"]]),
    ["Received", `${receivedAt} IST`],
  ];

  const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n");
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#1a1a1a;">
      <h2 style="margin:0 0 12px;">New Career Application</h2>
      <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;">
        ${rows
          .map(
            ([k, v]) =>
              `<tr><td style="font-weight:bold;padding-right:16px;vertical-align:top;">${k}</td><td>${
                k === "Resume" && application.resumeUrl
                  ? `<a href="${v}">${v}</a>`
                  : v
              }</td></tr>`
          )
          .join("")}
      </table>
      <p style="margin-top:16px;color:#666;">Sent automatically from the Dr. A.D. Academy of Excellence website.</p>
    </div>
  `;

  // Fire-and-forget — sendMail already catches its own errors, so a missed
  // notification email never loses or delays the saved application.
  sendMail([ADMIN_NOTIFY_EMAIL], subject, text, html);
};

const createCareerApplication = async (req, res) => {
  try {
    const fullName = (req.body.fullName || "").toString().trim();
    const contactNumber = (req.body.contactNumber || "").toString().trim();
    const email = (req.body.email || "").toString().trim();
    const qualification = (req.body.qualification || "").toString().trim();
    const college = (req.body.college || "").toString().trim();
    const cgpa = (req.body.cgpa || "").toString().trim();
    const resumeUrl = (req.body.resumeUrl || "").toString().trim() || null;
    const gateQualified = req.body.gateQualified === true || req.body.gateQualified === "yes";
    const gateScore = (req.body.gateScore || "").toString().trim();
    const experience = (req.body.experience || "").toString().trim();
    const subjects = Array.isArray(req.body.subjects)
      ? req.body.subjects.filter((s) => typeof s === "string" && s.trim())
      : [];

    if (!fullName || !contactNumber || !email) {
      return res.status(400).json({
        success: false,
        message: "Full name, contact number, and email are all required.",
      });
    }

    if (!MOBILE_RE.test(contactNumber)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid contact number.",
      });
    }

    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid email address.",
      });
    }

    const application = await careerApplicationModel.create({
      fullName,
      contactNumber,
      email,
      qualification,
      college,
      cgpa,
      resumeUrl,
      gateQualified,
      gateScore: gateQualified ? gateScore : "",
      experience,
      subjects,
    });

    notifyAdminOfApplication(application);

    return res.status(201).json({
      success: true,
      message: "Thanks for applying — we've received your details and will reach out if there's a fit.",
      data: application,
    });
  } catch (error) {
    console.error("createCareerApplication error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong. Please call or WhatsApp us directly.",
    });
  }
};

module.exports = {
  createCareerApplication,
};
