const mongoose = require("mongoose");

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
    password: { type: String, required: true, minlength: 3, maxlength: 1024 },
    sessionToken: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Performance index for role-based queries
userSchema.index({ role: 1, createdAt: -1 });

const userModel = mongoose.model("User", userSchema);

module.exports = userModel;
