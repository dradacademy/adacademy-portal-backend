const answerSheetModel = require("../models/answerSheetModel");
const examModel = require("../models/examModel");
const subjectModel = require("../models/subjectModel");
const { uploadBufferToGridFs, streamFileToResponse, deleteFile } = require("../utils/gridfsHelper");

// A student may only upload/view answer sheets for an exam within their own
// category — same isolation key used everywhere else in this app.
const examBelongsToStudentCategory = async (examId, category) => {
  if (!category) return false;
  const exam = await examModel.findById(examId).select("subject");
  if (!exam) return false;
  const subject = await subjectModel.findById(exam.subject).select("category");
  return !!subject && subject.category === category;
};

// POST /api/answer-sheets (student, multipart with an "images" field array,
// up to 10 photos) — body: { examId, attemptNumber? }.
const uploadAnswerSheet = async (req, res) => {
  try {
    const { examId, attemptNumber } = req.body;

    if (!examId) {
      return res.status(400).json({ success: false, message: "examId is required." });
    }
    if (!req.files || req.files.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "At least one answer-sheet photo is required." });
    }

    const allowed = await examBelongsToStudentCategory(examId, req.user.category);
    if (!allowed) {
      return res.status(403).json({
        success: false,
        message: "This exam is not available for your course category.",
      });
    }

    const images = [];
    for (const file of req.files) {
      const gridFsFileId = await uploadBufferToGridFs(
        file.buffer,
        file.originalname,
        file.mimetype
      );
      images.push({
        gridFsFileId,
        fileName: file.originalname,
        contentType: file.mimetype,
      });
    }

    const answerSheet = await answerSheetModel.create({
      userId: req.user._id,
      examId,
      attemptNumber:
        attemptNumber !== undefined && attemptNumber !== "" ? Number(attemptNumber) : null,
      images,
    });

    res.status(201).json({ success: true, data: answerSheet });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to upload answer sheet.",
      error: error.message,
    });
  }
};

// GET /api/answer-sheets/mine?examId= (student) — every answer sheet this
// student has uploaded, optionally scoped to one exam, newest first —
// including any mistakes the admin has already marked (their feedback).
const listMyAnswerSheets = async (req, res) => {
  try {
    const { examId } = req.query;
    const filter = { userId: req.user._id };
    if (examId) filter.examId = examId;

    const sheets = await answerSheetModel.find(filter).sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: sheets });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to list your answer sheets.",
      error: error.message,
    });
  }
};

// GET /api/answer-sheets/exam/:examId (admin) — every student's submission
// for this exam.
const listForExam = async (req, res) => {
  try {
    const { examId } = req.params;
    const sheets = await answerSheetModel
      .find({ examId })
      .populate("userId", "username email")
      .sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: sheets });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to list answer sheets for this exam.",
      error: error.message,
    });
  }
};

// GET /api/answer-sheets/student/:userId (admin) — every submission from
// one student, across all exams.
const listForStudent = async (req, res) => {
  try {
    const { userId } = req.params;
    const sheets = await answerSheetModel
      .find({ userId })
      .populate("examId", "examCode order")
      .sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: sheets });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to list this student's answer sheets.",
      error: error.message,
    });
  }
};

// Shared ownership/visibility check: an admin can see any sheet; a student
// can only see their own.
const canAccessSheet = (req, sheet) =>
  req.user.role === "admin" || sheet.userId.toString() === req.user._id.toString();

// GET /api/answer-sheets/:id (admin, or the student who owns it)
const getAnswerSheetDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const sheet = await answerSheetModel
      .findById(id)
      .populate("userId", "username email")
      .populate("examId", "examCode order");

    if (!sheet) {
      return res.status(404).json({ success: false, message: "Answer sheet not found." });
    }
    if (!canAccessSheet(req, sheet)) {
      return res.status(403).json({ success: false, message: "Forbidden." });
    }

    res.status(200).json({ success: true, data: sheet });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load answer sheet.",
      error: error.message,
    });
  }
};

// GET /api/answer-sheets/:id/image/:imageIndex (admin, or the owning
// student) — streams one page's image inline, same "no direct download
// link" pattern as attachmentController.viewAttachmentFile.
const getAnswerSheetImage = async (req, res) => {
  try {
    const { id, imageIndex } = req.params;
    const sheet = await answerSheetModel.findById(id).select("userId images");
    if (!sheet) {
      return res.status(404).json({ success: false, message: "Answer sheet not found." });
    }
    if (!canAccessSheet(req, sheet)) {
      return res.status(403).json({ success: false, message: "Forbidden." });
    }

    const image = sheet.images[Number(imageIndex)];
    if (!image) {
      return res.status(404).json({ success: false, message: "Image not found." });
    }

    res.setHeader("Content-Type", image.contentType);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(image.fileName)}"`);
    await streamFileToResponse(image.gridFsFileId, res);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: "Failed to load this image.",
        error: error.message,
      });
    }
  }
};

// POST /api/answer-sheets/:id/mistakes (admin) — click-to-pin a mistake
// marker: body { imageIndex, type: "silly"|"concept"|"application",
// xPercent, yPercent, note? }.
const addMistake = async (req, res) => {
  try {
    const { id } = req.params;
    const { imageIndex, type, xPercent, yPercent, note } = req.body;

    if (
      imageIndex === undefined ||
      !["silly", "concept", "application"].includes(type) ||
      xPercent === undefined ||
      yPercent === undefined
    ) {
      return res.status(400).json({
        success: false,
        message: "imageIndex, type, xPercent, and yPercent are required.",
      });
    }

    const sheet = await answerSheetModel.findByIdAndUpdate(
      id,
      {
        $push: {
          mistakes: {
            imageIndex: Number(imageIndex),
            type,
            xPercent: Number(xPercent),
            yPercent: Number(yPercent),
            note: note || "",
            markedBy: req.user._id,
          },
        },
      },
      { new: true }
    );

    if (!sheet) {
      return res.status(404).json({ success: false, message: "Answer sheet not found." });
    }

    res.status(201).json({ success: true, data: sheet });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to add mistake marker.",
      error: error.message,
    });
  }
};

// DELETE /api/answer-sheets/:id/mistakes/:mistakeId (admin)
const removeMistake = async (req, res) => {
  try {
    const { id, mistakeId } = req.params;
    const sheet = await answerSheetModel.findByIdAndUpdate(
      id,
      { $pull: { mistakes: { _id: mistakeId } } },
      { new: true }
    );
    if (!sheet) {
      return res.status(404).json({ success: false, message: "Answer sheet not found." });
    }
    res.status(200).json({ success: true, data: sheet });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to remove mistake marker.",
      error: error.message,
    });
  }
};

// PATCH /api/answer-sheets/:id/review (admin) — body { reviewed: boolean }
const markReviewed = async (req, res) => {
  try {
    const { id } = req.params;
    const { reviewed } = req.body;

    const sheet = await answerSheetModel.findByIdAndUpdate(
      id,
      {
        reviewed: !!reviewed,
        reviewedAt: reviewed ? new Date() : null,
        reviewedBy: reviewed ? req.user._id : null,
      },
      { new: true }
    );

    if (!sheet) {
      return res.status(404).json({ success: false, message: "Answer sheet not found." });
    }

    res.status(200).json({ success: true, data: sheet });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to update review status.",
      error: error.message,
    });
  }
};

// DELETE /api/answer-sheets/:id (admin, or the owning student — lets a
// student remove an accidental upload before it's reviewed).
const deleteAnswerSheet = async (req, res) => {
  try {
    const { id } = req.params;
    const sheet = await answerSheetModel.findById(id);
    if (!sheet) {
      return res.status(404).json({ success: false, message: "Answer sheet not found." });
    }
    if (!canAccessSheet(req, sheet)) {
      return res.status(403).json({ success: false, message: "Forbidden." });
    }

    await Promise.all(sheet.images.map((img) => deleteFile(img.gridFsFileId)));
    await answerSheetModel.findByIdAndDelete(id);

    res.status(200).json({ success: true, message: "Answer sheet removed." });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to delete answer sheet.",
      error: error.message,
    });
  }
};

module.exports = {
  uploadAnswerSheet,
  listMyAnswerSheets,
  listForExam,
  listForStudent,
  getAnswerSheetDetail,
  getAnswerSheetImage,
  addMistake,
  removeMistake,
  markReviewed,
  deleteAnswerSheet,
};
