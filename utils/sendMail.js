const { Resend } = require("resend");
require("dotenv").config();

// Switched from Gmail SMTP (via MailTransporter.js/nodemailer) to Resend.
// Railway blocks raw outbound SMTP connections (every send was failing with
// "Error: Connection timeout" / ETIMEDOUT at the TCP-connect stage, before
// auth was ever attempted), so nodemailer could never have worked here no
// matter what NODEMAILER_USER/PASS were set to. Resend sends over a normal
// HTTPS API call instead of raw SMTP, so it isn't affected by that block.
//
// Setup required on Railway: add a RESEND_API_KEY variable (sign up at
// resend.com, create an API key). Without a verified sending domain,
// Resend's shared "resend.dev" address can only deliver to the email
// address you signed up to Resend with — sign up with dradacademy@gmail.com
// and it works immediately with zero other setup, since that's exactly
// where these notifications are sent. To send to additional addresses (or
// from a custom @dradacademy.com address) later, verify a domain in the
// Resend dashboard and set RESEND_FROM_EMAIL to an address on it.
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL || "Dr.AD.Academy <onboarding@resend.dev>";

const sendMail = async (recipientEmail, subject, text, html) => {
  if (!resend) {
    console.warn(
      "sendMail: RESEND_API_KEY is not set — skipping email send (nothing else is affected; the underlying data is still saved)."
    );
    return;
  }

  try {
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: recipientEmail, // array of addresses — Resend accepts this directly
      subject,
      text,
      html,
    });

    if (error) {
      console.error("Error sending email: ", error);
      return;
    }

    console.log("Email sent: " + data?.id);
  } catch (error) {
    console.error("Error sending email: ", error);
  }
};

module.exports = sendMail;
