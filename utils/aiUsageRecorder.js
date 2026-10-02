const { estimateCostUsd, readUsage } = require("./aiUsageCost");

// Writes one usage row for a successful Gemini call. Fire-and-forget by design:
// the usage meter must NEVER slow down or break a question import, so every
// failure (no usageMetadata, database hiccup) is swallowed after a log line.
const recordAiUsage = ({ response, model, keyLabel, source, userId }) => {
  try {
    const usage = readUsage(response);
    if (!usage) return Promise.resolve(null);
    const { usd, priceKnown } = estimateCostUsd({
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
    const label = keyLabel === "paid key" ? "paid" : keyLabel === "primary key" ? "primary" : "free";
    // Required lazily so a problem loading the model can never break an import.
    const AiUsage = require("../models/aiUsageModel");
    return Promise.resolve(
      AiUsage.create({
        keyLabel: label,
        model,
        source: source || "pdf",
        ...usage,
        // Only the paid key spends prepaid credits; the free key costs nothing.
        estCostUsd: label === "paid" ? usd : 0,
        priceKnown,
        requestedBy: userId || null,
      }),
    ).catch((e) => {
      console.error("AI usage not recorded:", e && e.message);
      return null;
    });
  } catch (e) {
    console.error("AI usage not recorded:", e && e.message);
    return Promise.resolve(null);
  }
};

module.exports = { recordAiUsage };
