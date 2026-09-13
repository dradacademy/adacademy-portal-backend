// The four top-level exam categories the academy offers. These are the
// canonical machine keys — they match the portal-redirect keys already used
// in routes/portalRoute.js (/portal/gate, /portal/tnpsc-ae, etc.) so the
// whole app (subjects, students, portal routing) uses one consistent set of
// identifiers instead of three slightly-different ones.
//
// A student's `category` (see models/userModel.js) locks them to exactly
// one of these; a Subject's `category` (see models/subjectModel.js) says
// which category that subject belongs to. Every place a student can list or
// attend exams filters by this field — that's what keeps a TNPSC student
// from ever seeing GATE content and vice versa (see
// controllers/examFunctionController.js and middlewares/checkExamEligibility.js).
const EXAM_CATEGORIES = ["gate", "tnpsc-ae", "tnpsc-jdo", "ssc-rrb-je"];

const EXAM_CATEGORY_LABELS = {
  gate: "GATE Civil",
  "tnpsc-ae": "TNPSC AE Civil",
  "tnpsc-jdo": "TNPSC JDO Civil",
  "ssc-rrb-je": "SSC JE & RRB JE Civil",
};

module.exports = { EXAM_CATEGORIES, EXAM_CATEGORY_LABELS };
