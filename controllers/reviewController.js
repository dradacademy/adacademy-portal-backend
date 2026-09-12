const { default: mongoose } = require("mongoose");
const reviewModel = require("../models/ReviewModel");

const getAllComment = async (req, res) => {
  try {
    const reviews = await reviewModel.aggregate([
      {
        $lookup: {
          from: "subjects",
          localField: "subject",
          foreignField: "_id",
          as: "subjectData",
        },
      },
      { $unwind: "$subjectData" },
      {
        $addFields: {
          matchingSubtopic: {
            $arrayElemAt: [
              {
                $filter: {
                  input: "$subjectData.subtopics",
                  as: "subtopic",
                  cond: { $eq: ["$$subtopic._id", "$subTopic"] },
                },
              },
              0,
            ],
          },
        },
      },
      {
        $project: {
          _id: 1,
          evaluator: 1,
          subject: {
            _id: "$subjectData._id",
            name: "$subjectData.name",
            subtopic: "$matchingSubtopic",
            createdAt: "$subjectData.createdAt",
            updatedAt: "$subjectData.updatedAt",
            __v: "$subjectData.__v",
          },
          subTopic: 1,
          level: 1,
          startingPercentage: 1,
          endingPercentage: 1,
          message: 1,
        },
      },
    ]);

    const populatedReviews = await reviewModel.populate(reviews, {
      path: "evaluator",
      select: "username email",
    });

    return res.status(200).json(populatedReviews);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Unable to get the reviews",
    });
  }
};

const getCommentByEvaluator = async (req, res) => {
  try {
    const { evaluatorId } = req.params;

    if (!evaluatorId) {
      return res.status(400).json({
        success: false,
        message: "The Evaluator Id is required",
      });
    }

    const reviews = await reviewModel.aggregate([
      { $match: { evaluator: new mongoose.Types.ObjectId(evaluatorId) } },
      {
        $lookup: {
          from: "subjects",
          localField: "subject",
          foreignField: "_id",
          as: "subjectData",
        },
      },
      { $unwind: "$subjectData" },
      {
        $addFields: {
          matchingSubtopic: {
            $arrayElemAt: [
              {
                $filter: {
                  input: "$subjectData.subtopics",
                  as: "subtopic",
                  cond: { $eq: ["$$subtopic._id", "$subTopic"] },
                },
              },
              0,
            ],
          },
        },
      },
      {
        $project: {
          _id: 1,
          evaluator: 1,
          subject: {
            _id: "$subjectData._id",
            name: "$subjectData.name",
            subtopic: "$matchingSubtopic",
            createdAt: "$subjectData.createdAt",
            updatedAt: "$subjectData.updatedAt",
            __v: "$subjectData.__v",
          },
          subTopic: 1,
          level: 1,
          startingPercentage: 1,
          endingPercentage: 1,
          message: 1,
        },
      },
    ]);

    return res.status(200).json(reviews);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Unable to get the reviews of the evaluator",
    });
  }
};

const getCommentByRangeForStudents = async (req, res) => {
  try {
    const { subject, subTopic, level, percentage } = req.query;
    if (!subject || !subTopic || !level || percentage === undefined) {
      return res.status(400).json({
        success: false,
        message:
          "The Subject, Subtopic, Level, and Percentage fields are required",
      });
    }

    const parsedPercentage = parseFloat(percentage);
    if (isNaN(parsedPercentage)) {
      return res.status(400).json({
        success: false,
        message: "Percentage must be a valid number",
      });
    }

    const data = await reviewModel
      .find({
        subject,
        subTopic,
        level,
        startingPercentage: { $lte: parsedPercentage },
        endingPercentage: { $gte: parsedPercentage },
      })
      .populate({
        path: "evaluator",
        select: "email username",
      });

    res.status(200).json(data);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Unable to get the reviews",
    });
  }
};

const addComment = async (req, res) => {
  try {
    const {
      evaluator,
      subject,
      subTopic,
      level,
      startingPercentage,
      endingPercentage,
      message,
    } = req.body;

    if (
      !evaluator ||
      !subject ||
      !subTopic ||
      !level ||
      startingPercentage < 0 ||
      endingPercentage < 0 ||
      !message
    ) {
      return res.status(400).json({
        success: false,
        message:
          "All the fields are required and percentages must be non-negative",
      });
    }

    // Validate percentage range (0-100)
    if (
      startingPercentage < 0 ||
      startingPercentage > 100 ||
      endingPercentage < 0 ||
      endingPercentage > 100
    ) {
      return res.status(400).json({
        success: false,
        message: "Percentages must be between 0 and 100",
      });
    }

    if (startingPercentage > endingPercentage) {
      return res.status(500).json({
        success: false,
        message:
          "The starting percentage cannot be greater than ending percentage",
      });
    }
    const data = await reviewModel.create({
      evaluator,
      subject,
      subTopic,
      level,
      startingPercentage,
      endingPercentage,
      message,
    });

    const formattedReview = await reviewModel.aggregate([
      { $match: { _id: data._id } },
      {
        $lookup: {
          from: "subjects",
          localField: "subject",
          foreignField: "_id",
          as: "subjectData",
        },
      },
      { $unwind: "$subjectData" },
      {
        $addFields: {
          matchingSubtopic: {
            $arrayElemAt: [
              {
                $filter: {
                  input: "$subjectData.subtopics",
                  as: "subtopic",
                  cond: { $eq: ["$$subtopic._id", "$subTopic"] },
                },
              },
              0,
            ],
          },
        },
      },
      {
        $project: {
          _id: 1,
          evaluator: 1,
          subject: {
            _id: "$subjectData._id",
            name: "$subjectData.name",
            subtopic: "$matchingSubtopic",
            createdAt: "$subjectData.createdAt",
            updatedAt: "$subjectData.updatedAt",
            __v: "$subjectData.__v",
          },
          subTopic: 1,
          level: 1,
          startingPercentage: 1,
          endingPercentage: 1,
          message: 1,
        },
      },
    ]);

    return res.status(201).json(formattedReview[0]); // Return as object instead of array
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Error adding the comment",
    });
  }
};

const editComment = async (req, res) => {
  try {
    const { commentId } = req.params;
    const { startingPercentage, endingPercentage, message } = req.body;

    // Validate percentage range (0-100)
    if (
      startingPercentage < 0 ||
      startingPercentage > 100 ||
      endingPercentage < 0 ||
      endingPercentage > 100
    ) {
      return res.status(400).json({
        success: false,
        message: "Percentages must be between 0 and 100",
      });
    }

    if (startingPercentage > endingPercentage) {
      return res.status(400).json({
        success: false,
        message: "Starting percentage cannot be greater than ending percentage",
      });
    }

    const data = await reviewModel.findByIdAndUpdate(
      commentId,
      {
        startingPercentage,
        endingPercentage,
        message,
      },
      { new: true }
    );

    if (!data) {
      return res.status(404).json({
        success: false,
        message: "There is no review with the given Id",
      });
    }

    res.status(200).json(data);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Unable to Edit the Comment",
    });
  }
};

const deleteComment = async (req, res) => {
  try {
    const { commentId } = req.params;
    if (!commentId) {
      return res.status(400).json({
        success: false,
        message: "Comment Id is required",
      });
    }
    const deletedComment = await reviewModel.findByIdAndDelete(commentId);
    if (!deletedComment) {
      return res.status(404).json({
        success: false,
        message: "There is no review with the given Id",
      });
    }
    return res.status(200).json(deletedComment);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Error deleting the comment",
    });
  }
};

module.exports = {
  getAllComment,
  getCommentByEvaluator,
  getCommentByRangeForStudents,
  addComment,
  editComment,
  deleteComment,
};
