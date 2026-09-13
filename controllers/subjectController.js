const subjectModel = require("../models/subjectModel");
const { EXAM_CATEGORIES } = require("../constants/examCategories");

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
    if (req.user.role === "student") {
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

module.exports = { createSubject, getSubjects, editSubjects, deleteSubject };
