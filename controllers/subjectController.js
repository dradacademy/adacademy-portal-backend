const subjectModel = require("../models/subjectModel");
const { EXAM_CATEGORIES, EXAM_CATEGORY_LABELS } = require("../constants/examCategories");
const { GATE_CIVIL_SYLLABUS } = require("../constants/gateCivilSyllabus");

// "Fluid Mechanics", "fluid  mechanics", "Fluid-Mechanics" → "fluidmechanics";
// "&" counts as "and". Used to match names without caring about case,
// spaces or punctuation.
const norm = (s = "") =>
  String(s)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const createSubject = async (req, res) => {
  try {
    const { name, subtopics, category } = req.body;
    if (!name || !subtopics) {
      return res.status(400).json({ error: "All fields are required" });
    }
    if (!EXAM_CATEGORIES.includes(category)) {
      return res.status(400).json({
        error: `A valid exam category is required (one of: ${EXAM_CATEGORIES.join(", ")}).`,
      });
    }
    // For checking if the subject already exists with case-insensitive
    const existingSubject = await subjectModel.findOne({
      name: { $regex: new RegExp(`^${name.toLowerCase()}$`, "i") },
    });

    if (existingSubject) {
      return res
        .status(400)
        .json({ error: "Subject with this name already exists" });
    }
    const subject = await subjectModel.create({ name, subtopics, category });
    res.status(201).json({ subject });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getSubjects = async (req, res) => {
  try {
    const filter = {};

    // A student only ever sees subjects in their own exam category — this
    // mirrors the same enforcement in examFunctionController.js's
    // getEligibleExamForUser, so a TNPSC student's Subjects dropdown (in
    // any admin-facing view they can somehow reach) or any other list of
    // subjects never includes GATE (or any other category's) subjects.
    // An anonymous visitor (the public homepage, not logged in) has no
    // req.user at all — treat that the same as the admin's view below
    // (all subjects, or filtered by an explicit ?category= query).
    if (req.user?.role === "student") {
      if (!req.user.category) {
        return res.status(200).json([]);
      }
      filter.category = req.user.category;
    } else if (req.query.category) {
      // Admin's category-organized workflow: optionally filter the list by
      // category (e.g. when working within one category's Subjects page).
      filter.category = req.query.category;
    }

    const subjects = await subjectModel.find(filter);
    res.status(200).json(subjects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const editSubjects = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, subtopics, category } = req.body;

    if (category && !EXAM_CATEGORIES.includes(category)) {
      return res.status(400).json({
        error: `A valid exam category is required (one of: ${EXAM_CATEGORIES.join(", ")}).`,
      });
    }

    const update = { name, subtopics };
    if (category) update.category = category;

    const subject = await subjectModel.findByIdAndUpdate(id, update, {
      new: true,
    });
    if (!subject) {
      return res.status(404).json({ error: "Subject not found" });
    }
    res.status(200).json({ subject });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const deleteSubject = async (req, res) => {
  try {
    const { id } = req.params;
    const subject = await subjectModel.findByIdAndDelete(id);
    if (!subject) {
      return res.status(404).json({ error: "Subject not found" });
    }
    res.status(200).json({ message: "Subject deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---------------------------------------------------------------------------
// Built-in syllabus (2026-10-31) — so subjects/subtopics for live and
// recorded classes don't have to be typed in by hand on the Subjects page.

// Find which existing subject (in this category) a syllabus entry matches:
// same name, or one of its aliases, ignoring case/spaces/punctuation.
const matchSyllabusEntry = (entry, subjects, category) => {
  const label = EXAM_CATEGORY_LABELS[category] || category || "";
  const names = [entry.name, ...(entry.aliases || [])];
  // Also the "Name (Exam)" form used when the plain name was taken.
  const keys = new Set([...names, ...names.map((n) => `${n} (${label})`)].map(norm));
  return subjects.find((s) => keys.has(norm(s.name))) || null;
};

const planSyllabus = async (category) => {
  const [inCategory, all] = await Promise.all([
    subjectModel.find({ category }).select("name category subtopics"),
    subjectModel.find({}).select("name category"),
  ]);
  return GATE_CIVIL_SYLLABUS.map((entry) => {
    const existing = matchSyllabusEntry(entry, inCategory, category);
    const have = new Set((existing?.subtopics || []).map((t) => norm(t.name)));
    const missing = entry.subtopics.filter((t) => !have.has(norm(t)));
    // Subject names are unique across ALL categories, so a brand-new subject
    // whose name is already used in another category gets the exam added.
    let createAs = entry.name;
    if (!existing) {
      const clash = all.find((s) => norm(s.name) === norm(entry.name));
      if (clash) createAs = `${entry.name} (${EXAM_CATEGORY_LABELS[category] || category})`;
    }
    return {
      section: entry.section,
      name: entry.name,
      subtopics: entry.subtopics,
      existingId: existing ? existing._id : null,
      existingName: existing ? existing.name : null,
      missingSubtopics: missing,
      createAs: existing ? null : createAs,
    };
  });
};

// GET /api/subjects/syllabus?category=gate (admin) — the built-in syllabus
// with, for each subject, whether it already exists here and which
// subtopics would be added. Nothing is changed.
const getSyllabus = async (req, res) => {
  try {
    const category = req.query.category || "gate";
    if (!EXAM_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: "Unknown exam category." });
    }
    const plan = await planSyllabus(category);
    res.status(200).json({ success: true, category, data: plan });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// POST /api/subjects/import-syllabus (admin) — body { category, names?: [...] }.
// Adds the chosen syllabus subjects (all when `names` is empty): new
// subjects are created, existing ones only get their missing subtopics.
// Never renames or removes anything.
const importSyllabus = async (req, res) => {
  try {
    const { category } = req.body || {};
    if (!EXAM_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: "Pick an exam category." });
    }
    const wanted = Array.isArray(req.body.names) && req.body.names.length ? new Set(req.body.names) : null;
    const plan = (await planSyllabus(category)).filter((p) => !wanted || wanted.has(p.name));

    let created = 0;
    let updated = 0;
    let subtopicsAdded = 0;
    for (const p of plan) {
      if (p.existingId) {
        if (!p.missingSubtopics.length) continue;
        await subjectModel.updateOne(
          { _id: p.existingId },
          { $push: { subtopics: { $each: p.missingSubtopics.map((name) => ({ name })) } } }
        );
        updated += 1;
        subtopicsAdded += p.missingSubtopics.length;
      } else {
        await subjectModel.create({ name: p.createAs, category, subtopics: p.subtopics.map((name) => ({ name })) });
        created += 1;
        subtopicsAdded += p.subtopics.length;
      }
    }
    res.status(200).json({ success: true, created, updated, subtopicsAdded });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// POST /api/subjects/quick-add (admin) — add a subject and/or subtopic right
// from the Go Live / Recorded Class form, without opening the Subjects page.
// Body: { category, subjectId?, subjectName?, subtopicName? }
//   - subjectName (no subjectId): uses the subject with that name in this
//     category if there is one, else creates it.
//   - subtopicName: added to that subject unless it's already there.
// Returns { subject, subtopicId } so the form can select them straight away.
const quickAdd = async (req, res) => {
  try {
    const { category, subjectId, subjectName, subtopicName } = req.body || {};
    if (!EXAM_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: "Pick an exam category first." });
    }
    let subject = null;
    if (subjectId) {
      subject = await subjectModel.findById(subjectId);
      if (!subject) return res.status(404).json({ error: "That subject no longer exists." });
      if (subject.category !== category) {
        return res.status(400).json({ error: "That subject is in a different exam category." });
      }
    } else {
      const name = String(subjectName || "").trim();
      if (!name) return res.status(400).json({ error: "Type a subject name." });
      const sameName = await subjectModel.findOne({ name: { $regex: new RegExp(`^${escapeRe(name)}$`, "i") } });
      if (sameName && sameName.category === category) subject = sameName;
      else if (sameName) {
        return res.status(400).json({
          error: `"${sameName.name}" already exists in ${EXAM_CATEGORY_LABELS[sameName.category] || sameName.category}. Use a slightly different name.`,
        });
      } else subject = await subjectModel.create({ name, category, subtopics: [] });
    }

    let subtopicId = null;
    const topic = String(subtopicName || "").trim();
    if (topic) {
      const found = subject.subtopics.find((t) => norm(t.name) === norm(topic));
      if (found) subtopicId = found._id;
      else {
        subject.subtopics.push({ name: topic });
        await subject.save();
        subtopicId = subject.subtopics[subject.subtopics.length - 1]._id;
      }
    }
    res.status(200).json({ success: true, subject, subtopicId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  createSubject,
  getSubjects,
  editSubjects,
  deleteSubject,
  getSyllabus,
  importSyllabus,
  quickAdd,
  _test: { norm, matchSyllabusEntry },
};
