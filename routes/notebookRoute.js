const express = require("express");
const { verifyToken, authorizeRoles } = require("../middlewares/authMiddleware");
const { getNotebook, setBookmark, practiceQuestion, setMastered } = require("../controllers/notebookController");

const router = express.Router();
router.use(verifyToken, authorizeRoles("student"));
router.get("/", getNotebook);
router.post("/bookmark", setBookmark);
router.post("/practice", practiceQuestion);
router.post("/mastered", setMastered);

module.exports = router;
