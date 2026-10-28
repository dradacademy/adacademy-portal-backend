// Daily Study Tracker (TNPSC JDO) — 2026-10-28.
//
// The fixed study list the students follow: four subjects, each split into
// units, and for every unit the study materials they must finish. A unit is
// "finished" only when EVERY material of that unit is at 100%.
//
// Students report progress per material (¼, ½, ¾, full). A report only
// counts after the student passes a short random-question check on that
// unit (see controllers/studyTrackerController.js).

const TRACKER_CATEGORY = "tnpsc-jdo";

const SUBJECTS = ["GS", "Civil", "Aptitude", "Language"];

const SUBJECT_LABELS = {
  GS: "General Studies",
  Civil: "Civil Engineering",
  Aptitude: "Aptitude",
  Language: "English",
};

const UNITS = {
  GS: [
    "General Science",
    "Geography",
    "History (India)",
    "INM",
    "Polity",
    "Economy",
    "Unit 6 (TN History)",
  ],
  Civil: [
    "C1 Engineering Mechanics",
    "C2 Mechanics of Structure",
    "C3 Construction Materials & Practice",
    "C4 Transportation Engg",
    "C5 Hydraulics",
    "C6 Surveying & Remote Sensing",
    "C7 Environmental Engg",
    "C8 Estimating & Costing",
    "C9 Structural Engg",
    "C10 Constr. Mgmt & Computer Appl.",
  ],
  Aptitude: [
    "Simplification",
    "Percentage",
    "HCF",
    "LCM",
    "Ratio & Proportion",
    "Simple Interest",
    "Compound Interest",
    "Area",
    "Volume",
    "Time & Work",
    "Logical Reasoning",
    "Puzzles",
    "Dice",
    "Visual Reasoning",
    "Alpha-numeric Reasoning",
    "Number Series",
  ],
  Language: [
    "L1 Grammar",
    "L2 Vocabulary",
    "L3 Writing Skill",
    "L4 Technical Terms",
    "L5 Reading Comprehension",
    "L6 Translation",
    "L7 Literature & Scholars",
  ],
};

const MATERIALS = {
  GS: ["Old notes", "New notes", "New notes MCQ", "Presentation MCQ"],
  Civil: ["Old notes", "New notes", "MCQ book", "PYQ"],
  Aptitude: ["Old notes", "New notes", "New sums"],
  Language: ["Old notes", "New notes"],
};

// Old notes were never uploaded to the portal, so the check for "Old notes"
// uses the same question pool as "New notes" (the admin's instruction).
const POOL_FALLBACK = { "Old notes": "New notes" };

// Aptitude and English have ONE target date for the whole subject; GS and
// Civil have one date per unit.
const SUBJECT_LEVEL_DATES = ["Aptitude", "Language"];

const PROGRESS_STEPS = [0.25, 0.5, 0.75, 1];

const DEFAULT_CONFIG = {
  quizQuestionCount: 10,
  passPercent: 75,
  reminderTime: "17:30", // IST, HH:MM
  reminderEndTime: "23:59",
  enabled: true,
};

const poolKey = (subject, unit, material) => `${subject}::${unit}::${material}`;
const planKeyFor = (subject, unit) =>
  SUBJECT_LEVEL_DATES.includes(subject) ? subject : unit;

const isValidUnit = (subject, unit) =>
  Boolean(UNITS[subject] && UNITS[subject].includes(unit));
const isValidMaterial = (subject, material) =>
  Boolean(MATERIALS[subject] && MATERIALS[subject].includes(material));

// Every key a target date can be stored under.
const ALL_PLAN_KEYS = [
  ...UNITS.GS.map((u) => ({ key: u, subject: "GS" })),
  ...UNITS.Civil.map((u) => ({ key: u, subject: "Civil" })),
  { key: "Aptitude", subject: "Aptitude" },
  { key: "Language", subject: "Language" },
];

module.exports = {
  TRACKER_CATEGORY,
  SUBJECTS,
  SUBJECT_LABELS,
  UNITS,
  MATERIALS,
  POOL_FALLBACK,
  SUBJECT_LEVEL_DATES,
  PROGRESS_STEPS,
  DEFAULT_CONFIG,
  ALL_PLAN_KEYS,
  poolKey,
  planKeyFor,
  isValidUnit,
  isValidMaterial,
};
