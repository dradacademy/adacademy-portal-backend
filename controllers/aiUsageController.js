const { loadPriceTable, priceFor } = require("../utils/aiUsageCost");

const DEFAULT_USD_TO_INR = 88;
const DEFAULT_LOW_BALANCE_INR = 100;
const MAX_ROWS = 5000;

const round = (n, d = 2) => {
  const f = Math.pow(10, d);
  return Math.round((Number(n) || 0) * f) / f;
};

// Pure: turns usage rows + settings into everything the panel shows. Kept free
// of database calls so it can be tested on its own.
const summarizeUsage = (rows, settings = {}, now = new Date()) => {
  const usdToInr = Number(settings.usdToInr) > 0 ? Number(settings.usdToInr) : DEFAULT_USD_TO_INR;
  const lowBalanceInr = Number.isFinite(Number(settings.lowBalanceInr)) ? Number(settings.lowBalanceInr) : DEFAULT_LOW_BALANCE_INR;
  const baselineAt = settings.baselineAt ? new Date(settings.baselineAt) : null;
  const baselineInr = settings.baselineInr === null || settings.baselineInr === undefined ? null : Number(settings.baselineInr);
  const hasBaseline = baselineInr !== null && Number.isFinite(baselineInr) && !!baselineAt;

  const paidRows = rows.filter((r) => r.keyLabel === "paid");
  const freeRows = rows.filter((r) => r.keyLabel !== "paid");
  const paidSince = hasBaseline ? paidRows.filter((r) => new Date(r.createdAt) > baselineAt) : paidRows;

  const sum = (list, f) => list.reduce((s, r) => s + (Number(r[f]) || 0), 0);
  const spentUsdSince = sum(paidSince, "estCostUsd");
  const spentInrSince = spentUsdSince * usdToInr;
  const remainingInr = hasBaseline ? Math.max(0, baselineInr - spentInrSince) : null;
  const avgInrPerImport = paidSince.length ? spentInrSince / paidSince.length : null;

  const byModel = {};
  paidRows.forEach((r) => {
    const m = (byModel[r.model] = byModel[r.model] || { model: r.model, calls: 0, inputTokens: 0, outputTokens: 0, costInr: 0 });
    m.calls += 1;
    m.inputTokens += Number(r.inputTokens) || 0;
    m.outputTokens += Number(r.outputTokens) || 0;
    m.costInr += (Number(r.estCostUsd) || 0) * usdToInr;
  });

  return {
    configured: hasBaseline,
    baselineInr: hasBaseline ? round(baselineInr) : null,
    baselineAt: hasBaseline ? baselineAt.toISOString() : null,
    usdToInr,
    lowBalanceInr,
    paid: {
      calls: paidRows.length,
      callsSinceBaseline: paidSince.length,
      inputTokens: sum(paidRows, "inputTokens"),
      outputTokens: sum(paidRows, "outputTokens"),
      spentInrSinceBaseline: round(spentInrSince),
      spentInrTotalTracked: round(sum(paidRows, "estCostUsd") * usdToInr),
    },
    free: { calls: freeRows.length, tokens: sum(freeRows, "totalTokens") },
    remainingInr: remainingInr === null ? null : round(remainingInr),
    percentRemaining: hasBaseline && baselineInr > 0 ? Math.round((remainingInr / baselineInr) * 100) : null,
    isLow: hasBaseline ? remainingInr <= lowBalanceInr : false,
    avgInrPerPaidCall: avgInrPerImport === null ? null : round(avgInrPerImport),
    callsLeftEstimate: avgInrPerImport && remainingInr !== null ? Math.floor(remainingInr / avgInrPerImport) : null,
    hasUnknownPrice: paidRows.some((r) => r.priceKnown === false),
    byModel: Object.values(byModel).map((m) => ({ ...m, costInr: round(m.costInr) })),
    recent: rows.slice(0, 15).map((r) => ({
      at: r.createdAt,
      key: r.keyLabel,
      model: r.model,
      source: r.source,
      inputTokens: Number(r.inputTokens) || 0,
      outputTokens: Number(r.outputTokens) || 0,
      costInr: round((Number(r.estCostUsd) || 0) * usdToInr, 3),
    })),
    prices: Object.entries(loadPriceTable()).map(([model]) => ({ model, ...priceFor(model, now) })),
    note:
      "Estimate from token counts x Google's published prices (excluding any tax/rounding Google adds). Google's billing page is the exact figure - re-enter your balance from it whenever you like to re-calibrate.",
  };
};

const getAiUsage = async (req, res) => {
  try {
    const AiUsage = require("../models/aiUsageModel");
    const AiUsageSetting = require("../models/aiUsageSettingModel");
    const [rows, settings] = await Promise.all([
      AiUsage.find({}).sort({ createdAt: -1 }).limit(MAX_ROWS).lean(),
      AiUsageSetting.findById("ai-usage").lean(),
    ]);
    return res.status(200).json({ success: true, ...summarizeUsage(rows, settings || {}) });
  } catch (error) {
    console.error("Error reading AI usage:", error);
    return res.status(500).json({ success: false, message: "Could not load the AI usage summary." });
  }
};

// Body: { remainingInr?, usdToInr?, lowBalanceInr? }.
// remainingInr = the credit balance shown on Google's billing page RIGHT NOW;
// it becomes the new baseline, so the meter re-calibrates to Google's figure.
const updateAiUsageSettings = async (req, res) => {
  try {
    const { remainingInr, usdToInr, lowBalanceInr } = req.body || {};
    const update = { updatedBy: req.user?._id || null };
    const bad = (name) => res.status(400).json({ success: false, message: `${name} must be a valid number.` });

    if (remainingInr !== undefined && remainingInr !== "") {
      const n = Number(remainingInr);
      if (!Number.isFinite(n) || n < 0 || n > 10000000) return bad("The credit balance");
      update.baselineInr = n;
      update.baselineAt = new Date();
    }
    if (usdToInr !== undefined && usdToInr !== "") {
      const n = Number(usdToInr);
      if (!Number.isFinite(n) || n <= 0 || n > 1000) return bad("The dollar-to-rupee rate");
      update.usdToInr = n;
    }
    if (lowBalanceInr !== undefined && lowBalanceInr !== "") {
      const n = Number(lowBalanceInr);
      if (!Number.isFinite(n) || n < 0) return bad("The low-balance alert amount");
      update.lowBalanceInr = n;
    }
    if (Object.keys(update).length === 1) {
      return res.status(400).json({ success: false, message: "Nothing to update." });
    }

    const AiUsageSetting = require("../models/aiUsageSettingModel");
    await AiUsageSetting.findOneAndUpdate({ _id: "ai-usage" }, { $set: update }, { upsert: true, new: true, setDefaultsOnInsert: true });
    return getAiUsage(req, res);
  } catch (error) {
    console.error("Error updating AI usage settings:", error);
    return res.status(500).json({ success: false, message: "Could not save the AI usage settings." });
  }
};

module.exports = { getAiUsage, updateAiUsageSettings, summarizeUsage };
