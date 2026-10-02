const mongoose = require("mongoose");

// Single settings document for the AI credits meter.
//  baselineInr / baselineAt : the credit balance the admin read from Google's
//    billing page, and when. The meter's "remaining" is that balance minus the
//    estimated cost of every paid call made AFTER baselineAt.
const aiUsageSettingSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "ai-usage" },
    baselineInr: { type: Number, default: null },
    baselineAt: { type: Date, default: null },
    usdToInr: { type: Number, default: 88 },
    lowBalanceInr: { type: Number, default: 100 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("AiUsageSetting", aiUsageSettingSchema);
