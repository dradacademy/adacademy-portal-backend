const mongoose = require("mongoose");

const markSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: "mark-based-on-levels",
    },
    level1Mark: {
      type: Number,
      required: true,
      default: 1,
    },
    level1NegativeMark: {
      type: Number,
      required: true,
      default: 0.33,
    },
    level2Mark: {
      type: Number,
      required: true,
      default: 1,
    },
    level2NegativeMark: {
      type: Number,
      required: true,
      default: 0.66,
    },
    level3Mark: {
      type: Number,
      required: true,
      default: 2,
    },
    level3NegativeMark: {
      type: Number,
      required: true,
      default: 0.66,
    },
    level4Mark: {
      type: Number,
      required: true,
      default: 10,
    },
    level4NegativeMark: {
      type: Number,
      required: true,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Mark", markSchema);
