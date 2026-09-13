const express = require("express");
const {
  createEnrollmentLead,
} = require("../controllers/enrollmentLeadController");
const router = express.Router();

// Public — a prospective student has no account yet when they submit this.
router.post("/", createEnrollmentLead);

module.exports = router;
