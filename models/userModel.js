const mongoose = require("mongoose");
const { EXAM_CATEGORIES } = require("../constants/examCategories");

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      minlength: 3,
      maxlength: 200,
      unique: true,
    },
    registerNumber: {
      type: String,
      unique: true,
      sparse: true,
    },
    username: {
      type: String,
      minlength: 2,
      maxlength: 50,
      required: true,
    },
    role: {
      type: String,
      required: true,
      enum: ["student", "evaluator", "admin"],
    },
    // Which exam category this student belongs to (gate/tnpsc-ae/tnpsc-jdo/
    // ssc-rrb-je). Required for role "student" (enforced in userController,
    // not here, matching this codebase's existing pattern of controller-
    // level conditional validation rather than schema-level conditionals);
    // left null for "admin" (the single admin manages every category) and
    // "evaluator" (evaluators remain global/unscoped for now). This field
    // is what every exam-listing/eligibility check filters on to keep one
    // category's students from ever seeing another category's content.
    category: {
      type: String,
      enum: EXAM_CATEGORIES,
      default: null,
    },
    password: { type: String, required: true, minlength: 3, maxlength: 1024 },
    sessionToken: {
      type: String,
      default: null,
    },
    // Admin-controlled enable/disable switch (Controllers/Control Panel —
    // "enable/disable student access"). A disabled account is rejected both
    // at login and on every existing authenticated request (see
    // authMiddleware.js's verifyToken), so disabling takes effect
    // immediately even if the student already has a valid session token.
    isDisabled: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Performance index for role-based queries
userSchema.index({ role: 1, createdAt: -1 });
userSchema.index({ role: 1, category: 1 });

const userModel = mongoose.model("User", userSchema);

module.exports = userModel;
