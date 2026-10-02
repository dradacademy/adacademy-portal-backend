const mongoose = require("mongoose");

// One row per SUCCESSFUL Gemini call made by the question importer (failed /
// retried calls cost nothing and are not recorded). Powers the admin "AI
// credits" meter on the import screen. Cost is stored in USD at the price in
// effect when the call was made; rupees are derived at read time.
const aiUsageSchema = new mongoose.Schema(
  {
    keyLabel: { type: String, enum: ["free", "paid", "primary"], required: true },
    model: { type: String, required: true },
    source: { type: String, default: "pdf" }, // pdf | images | answer-key
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 }, // includes "thinking" tokens
    thoughtsTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    estCostUsd: { type: Number, default: 0 },
    priceKnown: { type: Boolean, default: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);
aiUsageSchema.index({ createdAt: -1 });

module.exports = mongoose.model("AiUsage", aiUsageSchema);
