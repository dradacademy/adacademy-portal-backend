const mongoose = require("mongoose");

const durationSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: "duration-in-seconds",
    },
    level1Duration: {
      type: Number,
      required: true,
      default: 45,
    },
    level2Duration: {
      type: Number,
      required: true,
      default: 90,
    },
    level3Duration: {
      type: Number,
      required: true,
      default: 120,
    },
    level4Duration: {
      type: Number,
      required: true,
      default: 150,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Duration", durationSchema);
