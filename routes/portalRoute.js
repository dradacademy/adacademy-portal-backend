const express = require("express");
const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────
// Per-exam-category "test portal" redirects.
//
// Today there is only ONE real test engine — this same app — so every
// category safely falls back to the shared login page below. Once any
// exam category gets its own dedicated portal/subdomain, set its env var
// on Railway and this route starts sending students there instead —
// no code change needed.
//
//   PORTAL_GATE_URL          e.g. https://gate.dradacademy.com
//   PORTAL_TNPSC_AE_URL      e.g. https://tnpsc-ae.dradacademy.com
//   PORTAL_TNPSC_JDO_URL     e.g. https://tnpsc-jdo.dradacademy.com
//   PORTAL_SSC_RRB_JE_URL    e.g. https://ssc-rrb-je.dradacademy.com
// ─────────────────────────────────────────────────────────────────────────

const FALLBACK_LOGIN_URL = `${process.env.CLIENT_URL || ""}/login`;

const PORTAL_URLS = {
  gate: process.env.PORTAL_GATE_URL || FALLBACK_LOGIN_URL,
  "tnpsc-ae": process.env.PORTAL_TNPSC_AE_URL || FALLBACK_LOGIN_URL,
  "tnpsc-jdo": process.env.PORTAL_TNPSC_JDO_URL || FALLBACK_LOGIN_URL,
  "ssc-rrb-je": process.env.PORTAL_SSC_RRB_JE_URL || FALLBACK_LOGIN_URL,
};

router.get("/gate", (req, res) => res.redirect(302, PORTAL_URLS.gate));
router.get("/tnpsc-ae", (req, res) =>
  res.redirect(302, PORTAL_URLS["tnpsc-ae"]),
);
router.get("/tnpsc-jdo", (req, res) =>
  res.redirect(302, PORTAL_URLS["tnpsc-jdo"]),
);
router.get("/ssc-rrb-je", (req, res) =>
  res.redirect(302, PORTAL_URLS["ssc-rrb-je"]),
);

module.exports = router;
