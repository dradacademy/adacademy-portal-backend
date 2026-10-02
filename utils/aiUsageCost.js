// Estimated cost of Gemini calls, used only for the admin "AI credits" meter.
// These are ESTIMATES: per-1M-token prices (USD) as read from Google's pricing
// pages on 2026-10-02. Google can change them at any time, so every price is
// overridable from Railway without a redeploy via GEMINI_PRICES_JSON, e.g.
//   {"gemini-3.8-flash":{"in":0.75,"out":3.75}}
// An optional "from" date (YYYY-MM-DD) lets a price take effect later, e.g. the
// announced introductory-price end on 2027-01-01.

const DEFAULT_PRICES = {
  // model: array of { from?: 'YYYY-MM-DD', in: $/1M input tokens, out: $/1M output tokens }
  "gemini-3.8-flash": [
    { in: 0.75, out: 3.75 },
    { from: "2027-01-01", in: 1.5, out: 7.5 },
  ],
  "gemini-3.5-flash": [{ in: 1.5, out: 9.0 }],
  "gemini-3.5-flash-lite": [{ in: 0.3, out: 2.5 }],
};
// A model not in the table is priced like the primary model and flagged.
const FALLBACK_MODEL = "gemini-3.8-flash";

const loadPriceTable = () => {
  const table = { ...DEFAULT_PRICES };
  const raw = process.env.GEMINI_PRICES_JSON;
  if (!raw) return table;
  try {
    const parsed = JSON.parse(raw);
    Object.entries(parsed).forEach(([model, value]) => {
      const list = Array.isArray(value) ? value : [value];
      const clean = list
        .filter((p) => p && Number.isFinite(Number(p.in)) && Number.isFinite(Number(p.out)))
        .map((p) => ({ ...(p.from ? { from: String(p.from) } : {}), in: Number(p.in), out: Number(p.out) }));
      if (clean.length) table[model] = clean;
    });
  } catch (e) {
    console.error("GEMINI_PRICES_JSON is not valid JSON - using built-in prices:", e.message);
  }
  return table;
};

// Price in effect for `model` on `date` -> { in, out, known }
const priceFor = (model, date = new Date()) => {
  const table = loadPriceTable();
  const known = Object.prototype.hasOwnProperty.call(table, model);
  const list = table[known ? model : FALLBACK_MODEL];
  const day = new Date(date).toISOString().slice(0, 10);
  const active = list
    .filter((p) => !p.from || p.from <= day)
    .sort((a, b) => (a.from || "").localeCompare(b.from || ""))
    .pop() || list[0];
  return { in: active.in, out: active.out, known };
};

// Gemini bills output tokens AND "thinking" tokens at the output price.
const estimateCostUsd = ({ model, inputTokens = 0, outputTokens = 0, date }) => {
  const price = priceFor(model, date);
  const usd = (Number(inputTokens) * price.in + Number(outputTokens) * price.out) / 1_000_000;
  return { usd, priceKnown: price.known };
};

// Reads the token counts out of a Gemini SDK response.
const readUsage = (response) => {
  const u = response && response.usageMetadata;
  if (!u) return null;
  const input = Number(u.promptTokenCount) || 0;
  const candidates = Number(u.candidatesTokenCount) || 0;
  const thoughts = Number(u.thoughtsTokenCount) || 0;
  return {
    inputTokens: input,
    outputTokens: candidates + thoughts,
    thoughtsTokens: thoughts,
    totalTokens: Number(u.totalTokenCount) || input + candidates + thoughts,
  };
};

module.exports = { DEFAULT_PRICES, priceFor, estimateCostUsd, readUsage, loadPriceTable };
