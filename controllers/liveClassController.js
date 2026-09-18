const liveClassModel = require("../models/liveClassModel");
const enrollmentModel = require("../models/enrollmentModel");
const { isEnrollmentActive } = require("../models/enrollmentModel");
const { extractYoutubeVideoId } = require("../utils/youtube");

// POST /api/live-classes (admin only) — "Go Live": the admin pastes the
// YouTube Live watch link for the stream they've already started on
// YouTube (this doesn't start anything on YouTube's side — it just tells
// the app which stream to show students right now). If this category
// already has an active live class, it's automatically ended first, so a
// category never shows two "live now" entries at once.
const startLiveClass = async (req, res) => {
  try {
    const { title, category, subject, youtubeUrl } = req.body;

    if (!title || !category || !youtubeUrl) {
      return res.status(400).json({
        success: false,
        message: "title, category, and a YouTube Live link are required.",
      });
    }

    const youtubeVideoId = extractYoutubeVideoId(youtubeUrl);
    if (!youtubeVideoId) {
      return res.status(400).json({
        success: false,
        message:
          "That doesn't look like a valid YouTube link. Paste the full YouTube Live watch URL (e.g. https://youtube.com/watch?v=VIDEOID) or the 11-character video ID.",
      });
    }

    // End any live class already in progress for this category — only one
    // "live now" at a time per category.
    await liveClassModel.updateMany(
      { category, active: true },
      { $set: { active: false, endedAt: new Date() } }
    );

    const liveClass = await liveClassModel.create({
      title,
      category,
      subject: subject || null,
      youtubeVideoId,
      active: true,
      startedBy: req.user._id,
      startedAt: new Date(),
    });

    res.status(201).json({ success: true, data: liveClass });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to start live class.",
      error: error.message,
    });
  }
};

// PATCH /api/live-classes/:id/end (admin only) — "End Live". Doesn't touch
// YouTube itself (the admin ends the actual broadcast there, same as
// always) — this just stops the app from showing it as ongoing.
const endLiveClass = async (req, res) => {
  try {
    const { id } = req.params;

    const liveClass = await liveClassModel.findByIdAndUpdate(
      id,
      { active: false, endedAt: new Date() },
      { new: true }
    );

    if (!liveClass) {
      return res.status(404).json({ success: false, message: "Live class not found." });
    }

    res.status(200).json({ success: true, data: liveClass });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to end live class.",
      error: error.message,
    });
  }
};

// GET /api/live-classes (admin only) — recent history (active + ended),
// newest first, optionally filtered by category. Mainly so the admin can
// see "did I actually go live" / confirm the current state.
const listLiveClasses = async (req, res) => {
  try {
    const { category } = req.query;
    const filter = category ? { category } : {};

    const liveClasses = await liveClassModel
      .find(filter)
      .populate("subject", "name")
      .populate("startedBy", "username email")
      .sort({ startedAt: -1 })
      .limit(50);

    res.status(200).json({ success: true, data: liveClasses });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to list live classes.",
      error: error.message,
    });
  }
};

// GET /api/live-classes/current (student) — any live class currently
// active in the student's own category (normally 0 or 1). Deliberately
// does NOT return the YouTube video ID here — same two-step pattern as
// recorded classes (see videoPlaybackController.js): a student with a
// lapsed enrollment should still see "a class is live right now" (and why
// they can't join), not silently see nothing. The actual video ID is only
// handed over by joinLiveClass below, once enrollment is confirmed.
const listCurrentLiveClasses = async (req, res) => {
  try {
    if (!req.user.category) {
      return res.status(200).json({ success: true, data: [] });
    }

    const [liveClasses, enrollment] = await Promise.all([
      liveClassModel
        .find({ category: req.user.category, active: true })
        .select("title category subject startedAt")
        .sort({ startedAt: -1 }),
      enrollmentModel.findOne({
        userId: req.user._id,
        category: req.user.category,
      }),
    ]);

    const enrollmentActive = isEnrollmentActive(enrollment);

    const data = liveClasses.map((liveClass) => ({
      _id: liveClass._id,
      title: liveClass.title,
      startedAt: liveClass.startedAt,
      enrollmentActive,
    }));

    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to check for a live class.",
      error: error.message,
    });
  }
};

// GET /api/live-classes/:id/join (student) — the actual access-control
// chokepoint, same rule as recorded-class playback: category match AND an
// active (non-revoked, non-expired) Enrollment record. Returns the
// YouTube video ID for the frontend's YouTube IFrame Player to embed. Same
// honest limitation as recorded classes: this controls who gets in-app
// access to press play, not what a viewer can do with the stream once
// they're watching it.
const joinLiveClass = async (req, res) => {
  try {
    const { id } = req.params;

    const liveClass = await liveClassModel.findById(id);
    if (!liveClass || !liveClass.active) {
      return res.status(404).json({
        success: false,
        message: "This live class has ended or is not available.",
      });
    }

    if (!req.user.category || liveClass.category !== req.user.category) {
      return res.status(403).json({
        success: false,
        message: "This live class is not available for your course category.",
      });
    }

    const enrollment = await enrollmentModel.findOne({
      userId: req.user._id,
      category: liveClass.category,
    });

    if (!isEnrollmentActive(enrollment)) {
      return res.status(403).json({
        success: false,
        message:
          "Your enrollment for this course has expired or is not active. Contact the academy to renew access.",
      });
    }

    res.status(200).json({
      success: true,
      youtubeVideoId: liveClass.youtubeVideoId,
      title: liveClass.title,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to join live class.",
      error: error.message,
    });
  }
};

module.exports = {
  startLiveClass,
  endLiveClass,
  listLiveClasses,
  listCurrentLiveClasses,
  joinLiveClass,
};
