const { transporter } = require("./MailTransporter");
require("dotenv").config();

const sendMail = async (recipientEmail, subject, text, html) => {
  const mailOptions = {
    from: `"Dr.AD.Academy" ${process.env.NODEMAILER_USER}`,
    to: recipientEmail.join(","),
    subject: subject,
    text: text,
    html: html,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("Email sent: " + info.response);
  } catch (error) {
    console.error("Error sending email: ", error);
  }
};

module.exports = sendMail;
