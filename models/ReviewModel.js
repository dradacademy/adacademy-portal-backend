const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema(
  {
    evaluator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    subject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      required: true,
    },
    subTopic: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    level: {
      type: Number,
      required: true,
      enum: [1, 2, 3, 4],
    },
    startingPercentage: {
      type: Number,
      required: true,
    },
    endingPercentage: {
      type: Number,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Performance indexes for aggregation queries
reviewSchema.index({ subject: 1, subTopic: 1, level: 1 });
reviewSchema.index({ evaluator: 1, createdAt: -1 });

const reviewModel = mongoose.model("Review", reviewSchema);

module.exports = reviewModel;
