const { default: mongoose } = require("mongoose");
const examSubmissionSchema = require("../models/examSubmissionSchema");
const reviewModel = require("../models/ReviewModel");
const userModel = require("../models/userModel");
const userPassSchema = require("../models/userPassSchema");
const sendMail = require("../utils/sendMail");

const triggerMail = async (req, res) => {
  try {
    const { receivers, body, subject } = req.body;

    const receiptentsData = await userModel
      .find({ role: receivers })
      .select("email");

    const receiptentsEmails = receiptentsData.map((data) => data.email);

    await sendMail(receiptentsEmails, subject, body, body);

    res.status(200).json({
      success: true,
      message: "Mail sent successfully!",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Unable to send the mail",
    });
  }
};

const deleteUserEntirely = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { userId } = req.params;

    if (!userId) {
      await session.abortTransaction();
      return res
        .status(400)
        .json({ success: false, message: "User ID is required" });
    }

    const user = await userModel.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    if (user.role === "admin") {
      await session.abortTransaction();
      return res
        .status(403)
        .json({ success: false, message: "Admin users cannot be deleted" });
    }

    if (user.role === "student") {
      await examSubmissionSchema.deleteMany({ userId }, { session });
      await userPassSchema.deleteMany({ userId }, { session });
    }

    if (user.role === "evaluator") {
      // Remove all reviews added by this evaluator
      await reviewModel.deleteMany({ evaluator: userId }, { session });
      await examSubmissionSchema.updateMany(
        { "reviews.evaluator": userId },
        { $pull: { reviews: { evaluator: userId } } },
        { session }
      );
    }

    // Finally, delete the user itself
    await userModel.findByIdAndDelete(userId, { session });

    await session.commitTransaction();
    res
      .status(200)
      .json({ success: true, message: "User deleted successfully" });
  } catch (error) {
    await session.abortTransaction();
    console.error("Delete user transaction error:", error);
    res
      .status(500)
      .json({ success: false, message: "Unable to delete the user" });
  } finally {
    session.endSession();
  }
};

module.exports = { triggerMail, deleteUserEntirely };
