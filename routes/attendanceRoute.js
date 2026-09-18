const express = require("express");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
const { getAttendanceReport } = require("../controllers/attendanceController");

const router = express.Router();

router.use(verifyToken, authorizeRoles("admin"));

router.get("/report", getAttendanceReport);

module.exports = router;
