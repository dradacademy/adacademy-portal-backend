const express = require("express");
const {
  createCareerApplication,
} = require("../controllers/careerApplicationController");
const router = express.Router();

// Public — an applicant has no account when they submit this.
router.post("/", createCareerApplication);

module.exports = router;
