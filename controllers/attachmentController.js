const attachmentModel = require("../models/attachmentModel");
const attachmentProgressModel = require("../models/attachmentProgressModel");
const enrollmentModel = require("../models/enrollmentModel");
const { isEnrollmentActive } = require("../models/enrollmentModel");
const { uploadBufferToGridFs, streamFileToResponse, deleteFile } = require("../utils/gridfsHelper");
const { createNotification } = require("./notificationController");

// File types the in-app viewer can actually RENDER inline in a browser
// without any extra work — PDFs only. PPT/DOC/DOCX are still uploaded,
// stored, and access-controlled exactly the same way, but there is no
// guaranteed in-app preview for them in this version (see the frontend
// AttachmentViewer component) — converting them server-side (LibreOffice)
// or previewing via a third-party viewer were both rejected: the former
// needs a custom deploy buildpack this project's simple "paste files and
// redeploy" Railway setup doesn't have, the latter would send the file
// bytes to a third party without asking the admin first. Flagged plainly
// to the admin rather than silently shipping a broken PPT preview.
const PREVIEWABLE_CONTENT_TYPE = "application/pdf";

// POST /api/attachments (admin only, multipart with a single "file" field)
const uploadAttachment = async (req, res) => {
  try {
    const { title, description, category, subject } = req.body;

    if (!title || !category) {
      return res.status(400).json({
        success: false,
        message: "title and category are required.",
      });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: "A file is required." });
    }

    const gridFsFileId = await uploadBufferToGridFs(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype
    );

    const attachment = await attachmentModel.create({
      title,
      description: description || "",
      category,
      subject: subject || null,
      fileName: req.file.originalname,
      contentType: req.file.mimetype,
      fileSize: req.file.size,
      gridFsFileId,
      uploadedBy: req.user._id,
    });

    // Best-effort, matching the same fire-and-forget pattern used for new
    // recorded classes / newly posted tests — a notification failing to
    // write should never fail the actual upload.
    createNotification({
      category,
      type: "attachment",
      title: `New material: ${title}`,
      refId: attachment._id,
      refModel: "Attachment",
      createdBy: req.user._id,
    }).catch((err) => console.error("Failed to create attachment notification:", err.message));

    res.status(201).json({ success: true, data: attachment });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to upload attachment.",
      error: error.message,
    });
  }
};

// GET /api/attachments (admin only)
const listAttachments = async (req, res) => {
  try {
    const { category } = req.query;
    const filter = category ? { category } : {};

    const attachments = await attachmentModel
      .find(filter)
      .populate("subject", "name")
      .populate("uploadedBy", "username email")
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, data: attachments });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to list attachments.",
      error: error.message,
    });
  }
};

// PATCH /api/attachments/:id (admin only) — edit metadata and/or retire; an
// optional new file replaces the old GridFS blob.
const updateAttachment = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, category, subject, active } = req.body;

    const existing = await attachmentModel.findById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Attachment not found." });
    }

    if (title !== undefined) existing.title = title;
    if (description !== undefined) existing.description = description;
    if (category !== undefined) existing.category = category;
    if (subject !== undefined) existing.subject = subject || null;
    if (active !== undefined) existing.active = active;

    if (req.file) {
      const oldFileId = existing.gridFsFileId;
      existing.gridFsFileId = await uploadBufferToGridFs(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype
      );
      existing.fileName = req.file.originalname;
      existing.contentType = req.file.mimetype;
      existing.fileSize = req.file.size;
      // Best-effort cleanup of the replaced file — never blocks the update.
      deleteFile(oldFileId).catch(() => {});
    }

    await existing.save();

    res.status(200).json({ success: true, data: existing });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to update attachment.",
      error: error.message,
    });
  }
};

// DELETE /api/attachments/:id (admin only)
const deleteAttachment = async (req, res) => {
  try {
    const { id } = req.params;
    const attachment = await attachmentModel.findByIdAndDelete(id);
    if (!attachment) {
      return res.status(404).json({ success: false, message: "Attachment not found." });
    }

    await deleteFile(attachment.gridFsFileId);

    res.status(200).json({ success: true, message: "Attachment removed." });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to delete attachment.",
      error: error.message,
    });
  }
};

// GET /api/attachments/available (student) — every active attachment in
// this student's category, annotated with whether they've already viewed it
// and whether the in-app viewer can even render it inline (PDF only, for
// now — see PREVIEWABLE_CONTENT_TYPE above).
const listAvailableAttachments = async (req, res) => {
  try {
    if (!req.user.category) {
      return res.status(200).json({ success: true, data: [] });
    }

    const [attachments, enrollment, progressRows] = await Promise.all([
      attachmentModel
        .find({ category: req.user.category, active: true })
        .select("title description category subject contentType fileSize createdAt")
        .sort({ createdAt: -1 }),
      enrollmentModel.findOne({ userId: req.user._id, category: req.user.category }),
      attachmentProgressModel.find({ userId: req.user._id }),
    ]);

    const progressByAttachmentId = new Map(
      progressRows.map((p) => [p.attachmentId.toString(), p])
    );
    const enrollmentActive = isEnrollmentActive(enrollment);

    const data = attachments.map((att) => ({
      _id: att._id,
      title: att.title,
      description: att.description,
      contentType: att.contentType,
      fileSize: att.fileSize,
      createdAt: att.createdAt,
      viewed: (progressByAttachmentId.get(att._id.toString())?.viewCount || 0) > 0,
      isPreviewable: att.contentType === PREVIEWABLE_CONTENT_TYPE,
      enrollmentActive,
      accessLevel: enrollment?.accessLevel || "full",
    }));

    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to list available attachments.",
      error: error.message,
    });
  }
};

// GET /api/attachments/:id/view (student) — the access-control chokepoint,
// mirroring videoPlaybackController.getPlaybackToken: category match PLUS
// an active Enrollment record are both required. On success, streams the
// file inline (Content-Disposition: inline, never "attachment") so the
// browser renders it directly rather than offering a save dialog — there is
// no separate download route anywhere in this API.
const viewAttachmentFile = async (req, res) => {
  try {
    const { id } = req.params;

    const attachment = await attachmentModel.findById(id);
    if (!attachment || !attachment.active) {
      return res.status(404).json({ success: false, message: "This material is not available." });
    }

    if (!req.user.category || attachment.category !== req.user.category) {
      return res.status(403).json({
        success: false,
        message: "This material is not available for your course category.",
      });
    }

    const enrollment = await enrollmentModel.findOne({
      userId: req.user._id,
      category: attachment.category,
    });

    if (!isEnrollmentActive(enrollment)) {
      return res.status(403).json({
        success: false,
        message:
          "Your enrollment for this course has expired or is not active. Contact the academy to renew access.",
      });
    }

    // Test-Series-Only students get tests only — course materials are
    // excluded even while their enrollment is otherwise fully active.
    if (enrollment.accessLevel === "test_series_only") {
      return res.status(403).json({
        success: false,
        message:
          "Your plan is Test Series Only — course materials aren't included. Contact the academy to upgrade to Full Course Access.",
      });
    }

    // Record the view (best-effort — a tracking-write failure should never
    // block the student from actually seeing the file).
    attachmentProgressModel
      .findOneAndUpdate(
        { userId: req.user._id, attachmentId: attachment._id },
        {
          $inc: { viewCount: 1 },
          $set: { lastViewedAt: new Date() },
          $setOnInsert: { firstViewedAt: new Date() },
        },
        { upsert: true, setDefaultsOnInsert: true }
      )
      .catch((err) => console.error("Failed to record attachment view:", err.message));

    res.setHeader("Content-Type", attachment.contentType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(attachment.fileName)}"`
    );
    // Defense-in-depth alongside "no download button in the UI" — asks the
    // browser itself not to offer a save action where it honors this.
    res.setHeader("X-Content-Type-Options", "nosniff");

    await streamFileToResponse(attachment.gridFsFileId, res);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: "Failed to load this material.",
        error: error.message,
      });
    }
  }
};

module.exports = {
  uploadAttachment,
  listAttachments,
  updateAttachment,
  deleteAttachment,
  listAvailableAttachments,
  viewAttachmentFile,
};
