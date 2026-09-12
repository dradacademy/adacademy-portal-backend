const express = require("express");
const router = express.Router();
const {
  registerUser,
  loginUser,
  getAllUsersData,
  getUserBasedOnId,
  updatePassword,
  logoutUser,
  getUserData,
  bulkCreateUsers,
  downloadUserTemplate,
} = require("../controllers/userController");
const upload = require("../utils/multerConfig");
const {
  verifyToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware");

router.get(
  "/download-template",
  verifyToken,
  authorizeRoles("admin"),
  downloadUserTemplate
);
router.post("/register", registerUser);
router.post(
  "/register/bulk-upload",
  verifyToken,
  authorizeRoles("admin"),
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err) {
        // Multer errors
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ 
            error: 'File too large. Maximum size is 5MB.' 
          });
        }
        if (err.message.includes('Invalid file')) {
          return res.status(400).json({ error: err.message });
        }
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  },
  bulkCreateUsers
);
router.post("/login", loginUser);
router.get("/getall", verifyToken, authorizeRoles("admin"), getAllUsersData);
router.get(
  "/get/:userId",
  verifyToken,
  authorizeRoles("admin", "student", "evaluator"),
  getUserBasedOnId
);
router.put(
  "/update/password/:userId",
  verifyToken,
  authorizeRoles("admin", "student"),
  updatePassword
);
router.get(
  "/me",
  verifyToken,
  authorizeRoles("admin", "student", "evaluator"),
  getUserData
);
router.post(
  "/logout",
  verifyToken,
  authorizeRoles("admin", "student", "evaluator"),
  logoutUser
);

module.exports = router;
