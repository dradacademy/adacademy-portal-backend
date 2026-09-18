const notificationModel = require("../models/notificationModel");
const userModel = require("../models/userModel");

// Internal helper — NOT a route handler. Other controllers call this
// directly (recordedClassController on a new video, examController on a
// newly posted test, attachmentController on a new attachment) right
// after they create something students should hear about. Deliberately
// fire-and-forget from the caller's point of view: a notification write
// failing should never fail the actual create — see the try/catch at each
// call site, which logs and continues rather than throwing.
const createNotification = async ({
  category = null,
  type,
  title,
  message = "",
  refId = null,
  refModel = null,
  createdBy = null,
}) => {
  return notificationModel.create({
    category,
    type,
    title,
    message,
    refId,
    refModel,
    createdBy,
  });
};

// POST /api/notifications/announcement (admin only) — a direct message to
// students, independent of any video/test/attachment being posted. category
// omitted or null reaches every student.
const createAnnouncement = async (req, res) => {
  try {
    const { category, title, message } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, message: "title is required." });
    }

    const notification = await createNotification({
      category: category || null,
      type: "announcement",
      title,
      message: message || "",
      createdBy: req.user._id,
    });

    res.status(201).json({ success: true, data: notification });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to post announcement.",
      error: error.message,
    });
  }
};

// GET /api/notifications (any logged-in user) — the most recent
// notifications relevant to this user (their own category, plus any
// global ones), each flagged `isNew` against their rolling watermark.
const listNotifications = async (req, res) => {
  try {
    const filter = {
      $or: [{ category: null }, { category: req.user.category || "__none__" }],
    };

    const [notifications, user] = await Promise.all([
      notificationModel.find(filter).sort({ createdAt: -1 }).limit(50),
      userModel.findById(req.user._id).select("lastSeenNotificationsAt"),
    ]);

    const watermark = user?.lastSeenNotificationsAt
      ? new Date(user.lastSeenNotificationsAt)
      : new Date(0);

    const data = notifications.map((n) => ({
      _id: n._id,
      category: n.category,
      type: n.type,
      title: n.title,
      message: n.message,
      refId: n.refId,
      refModel: n.refModel,
      createdAt: n.createdAt,
      isNew: new Date(n.createdAt) > watermark,
    }));

    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch notifications.",
      error: error.message,
    });
  }
};

// POST /api/notifications/mark-seen (any logged-in user) — advances this
// user's watermark to now, so every currently-listed notification stops
// counting as "new" the next time they're fetched (until something newer
// arrives). Called when the student opens the notification panel/bell.
const markNotificationsSeen = async (req, res) => {
  try {
    await userModel.findByIdAndUpdate(req.user._id, {
      lastSeenNotificationsAt: new Date(),
    });
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to update notification watermark.",
      error: error.message,
    });
  }
};

module.exports = {
  createNotification,
  createAnnouncement,
  listNotifications,
  markNotificationsSeen,
};
