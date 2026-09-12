const subjectModel = require("../models/subjectModel");

const createSubject = async (req, res) => {
  try {
    const { name, subtopics } = req.body;
    if (!name || !subtopics) {
      return res.status(400).json({ error: "All fields are required" });
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
    const subject = await subjectModel.create({ name, subtopics });
    res.status(201).json({ subject });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getSubjects = async (req, res) => {
  try {
    const subjects = await subjectModel.find();
    res.status(200).json(subjects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const editSubjects = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, subtopics } = req.body;
    const subject = await subjectModel.findByIdAndUpdate(
      id,
      { name, subtopics },
      { new: true }
    );
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
