const examModel = require("../models/examModel");
const questionModel = require("../models/questionModel");
const Subject = require("../models/subjectModel");
const examSubmissionSchema = require("../models/examSubmissionSchema");
const userPassSchema = require("../models/userPassSchema");
const attemptCounterModel = require("../models/attemptCounterModel");
const reviewModel = require("../models/ReviewModel");
const { retryTransaction } = require("../utils/transactionHelper");

/**
 * For MCQ/MSQ: ensure correctAnswers contains only values
 * that exist in the options array. Map labels like "A" to the
 * matching option. Remove duplicates.
 */
const sanitizeCorrectAnswers = (question) => {
  const { questionType, options, correctAnswers } = question;
  if (
    (questionType !== "MCQ" && questionType !== "MSQ") ||
    !Array.isArray(options) ||
    !Array.isArray(correctAnswers)
  ) {
    return correctAnswers || [];
  }

  const resolved = correctAnswers
    .map((ans) => {
      if (typeof ans !== "string") return null;
      const trimmed = ans.trim();
      
      // Direct match
      const exactMatch = options.find((opt) => {
        const text = typeof opt === "object" && opt !== null ? opt.text : opt;
        return text === trimmed;
      });
      if (exactMatch) return trimmed;

      // Label match: "A" → "A. Liquid limit"
      const labelMatch = options.find((opt) => {
        const text = typeof opt === "object" && opt !== null ? opt.text : opt;
        return typeof text === "string" && text.split(".")[0].trim().toUpperCase() === trimmed.toUpperCase();
      });
      if (labelMatch) {
        return typeof labelMatch === "object" && labelMatch !== null ? labelMatch.text : labelMatch;
      }
      return null;
    })
    .filter(Boolean);

  // Deduplicate
  return [...new Set(resolved)];
};

const selectRandomQuestions = (pool, config, typeMap = null) => {
  const poolByType = {};

  pool.forEach((item, idx) => {
    const type = item.questionType ?? (typeMap ? typeMap[idx] : undefined);
    if (!type) return;
    if (!poolByType[type]) poolByType[type] = [];
    poolByType[type].push(item._id ?? item);
  });

  const selected = [];
  for (const [type, typeConfig] of Object.entries(config || {})) {
    if (poolByType[type] && typeConfig.count > 0) {
      const shuffled = [...poolByType[type]].sort(() => 0.5 - Math.random());
      selected.push(...shuffled.slice(0, typeConfig.count));
    }
  }
  return selected;
};

const generateUniqueExamCode = async () => {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let examCode;
  let exists = true;

  while (exists) {
    examCode = "";
    for (let i = 0; i < 6; i++) {
      examCode += characters.charAt(
        Math.floor(Math.random() * characters.length),
      );
    }

    const existingExam = await examModel.findOne({ examCode });
    if (!existingExam) {
      exists = false;
    }
  }

  return examCode;
};

const createExam = async (req, res) => {
  try {
    const {
      subject,
      subTopic,
      level,
      status,
      questions,
      passPercentage,
      questionSelection,
      questionSets,
    } = req.body;

    if (
      !subject ||
      !subTopic ||
      !level ||
      !status ||
      !questions ||
      !passPercentage
    ) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const existingExam = await examModel.findOne({ subject, subTopic, level });
    if (existingExam) {
      return res.status(409).json({
        error: "Exam with this subject, subTopic, and level already exists",
      });
    }

    const examCode = await generateUniqueExamCode();

    await retryTransaction(async (session) => {
      const createdQuestions = await questionModel.create(
        questions.map((question) => ({
          subject,
          subTopic,
          level,
          questionType: question.questionType,
          questionText: question.questionText,
          options: question.options,
          correctAnswers: sanitizeCorrectAnswers(question),
          image: question.image,
          answerKeyText: question.answerKeyText,
          answerKeyImage: question.answerKeyImage,
        })),
        { session, ordered: true },
      );

      const processedQuestionSets = (questionSets || []).map((set) => {
        let setQuestions = [];

        if (set.selectionType === "manual" && Array.isArray(set.questions)) {
          setQuestions = set.questions
            .map((index) => {
              if (
                typeof index === "number" &&
                index >= 0 &&
                index < createdQuestions.length
              ) {
                return createdQuestions[index]._id;
              }
              return null;
            })
            .filter(Boolean); // Remove any invalid mappings
        }

        return { ...set, questions: setQuestions };
      });

      const activeSetIndex =
        req.body.activeQuestionSetIndex !== undefined
          ? req.body.activeQuestionSetIndex
          : 0;

      const selectRandomQuestions = (pool, config) => {
        const poolByType = pool.reduce((acc, q) => {
          if (!acc[q.questionType]) acc[q.questionType] = [];
          acc[q.questionType].push(q._id);
          return acc;
        }, {});

        const selected = [];
        for (const [type, typeConfig] of Object.entries(config || {})) {
          if (poolByType[type] && typeConfig.count > 0) {
            const shuffled = [...poolByType[type]].sort(
              () => 0.5 - Math.random(),
            );
            selected.push(...shuffled.slice(0, typeConfig.count));
          }
        }
        return selected;
      };

      let activeQuestions = [];

      if (processedQuestionSets.length > 0) {
        const activeSet = processedQuestionSets[activeSetIndex];

        if (activeSet) {
          if (activeSet.selectionType === "manual") {
            activeQuestions = activeSet.questions;
          } else {
            activeQuestions = selectRandomQuestions(
              createdQuestions,
              activeSet.config,
            );
          }
        } else {
          // Fallback: use all questions if the specified set index doesn't exist
          activeQuestions = createdQuestions.map((q) => q._id);
        }
      } else {
        // No sets defined — use all questions (legacy / default behaviour)
        activeQuestions = createdQuestions.map((q) => q._id);
      }

      // 4. Create the exam document
      const examDocs = await examModel.create(
        [
          {
            subject,
            subTopic,
            level,
            status,
            passPercentage: passPercentage || 90,
            examCode,
            poolQuestions: createdQuestions.map((q) => q._id), // Full question pool
            questions: activeQuestions, // Active questions only
            questionSets: processedQuestionSets,
            questionSelection: questionSelection || {
              MCQ: { startIndex: 0, count: 0 },
              MSQ: { startIndex: 0, count: 0 },
              "Fill in the Blanks": { startIndex: 0, count: 0 },
              "Short Answer": { startIndex: 0, count: 0 },
            },
          },
        ],
        { session, ordered: true },
      );

      const newExam = examDocs[0];

      // 5. Set activeQuestionSetId if question sets are present
      //    ✅ Use findByIdAndUpdate instead of newExam.save() to avoid
      //       session/transaction-number mismatch on retries
      if (processedQuestionSets.length > 0) {
        const activeSet = newExam.questionSets[activeSetIndex];
        if (activeSet) {
          await examModel.findByIdAndUpdate(
            newExam._id,
            { $set: { activeQuestionSetId: activeSet._id } },
            { session, new: true },
          );
        }
      }
    });

    // ── Fetch the fully-populated exam to return in the response ──────────────
    const createdExam = await examModel
      .findOne({ examCode })
      .populate("questions");

    return res.status(201).json({
      success: true,
      message: "Exam created successfully",
      data: createdExam,
    });
  } catch (error) {
    console.error("createExam error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create exam",
      error: error.message,
    });
  }
};

// const getAllExams = async (req, res) => {
//   try {
//     const exams = await examModel
//       .find()
//       .populate("subject questions poolQuestions");

//     const examsWithNames = await Promise.all(
//       exams.map(async (exam) => {
//         const subject = await Subject.findById(exam.subject);
//         const subTopic = subject?.subtopics.find(
//           (sub) => sub._id.toString() === exam.subTopic.toString(),
//         );

//         return {
//           _id: exam._id,
//           subject: subject?.name || "Unknown Subject",
//           subjectId: subject?._id,
//           subTopic: subTopic?.name || "Unknown Subtopic",
//           subTopicId: subTopic._id,
//           level: exam.level,
//           status: exam.status,
//           questions: exam.questions,
//           poolQuestions: exam.poolQuestions, // Return the full pool
//           questionSets: exam.questionSets, // ensuring questionSets are returned too (though likely already included in doc)
//           activeQuestionSetId: exam.activeQuestionSetId,
//           passPercentage: exam.passPercentage,
//           examCode: exam.examCode,
//           shuffleQuestion: exam.shuffleQuestion,
//         };
//       }),
//     );

//     res.status(200).json(examsWithNames);
//   } catch (error) {
//     res.status(500).json({ success: false, message: error.message });
//   }
// };

const getAllExams = async (req, res) => {
  try {
    const exams = await examModel
      .find()
      .populate("subject questions poolQuestions");

    const examsWithNames = exams.map((exam) => {
      const subject = exam.subject; // already populated, no extra DB call needed

      const subTopic = subject?.subtopics?.find(
        (sub) => sub._id.toString() === exam.subTopic?.toString(),
      );

      return {
        _id: exam._id,
        subject: subject?.name || "Unknown Subject",
        subjectId: subject?._id,
        subTopic: subTopic?.name || "Unknown Subtopic",
        subTopicId: subTopic?._id ?? null, // ← safe access
        level: exam.level,
        status: exam.status,
        questions: exam.questions,
        poolQuestions: exam.poolQuestions,
        questionSets: exam.questionSets,
        activeQuestionSetId: exam.activeQuestionSetId,
        passPercentage: exam.passPercentage,
        examCode: exam.examCode,
        shuffleQuestion: exam.shuffleQuestion,
      };
    });

    res.status(200).json(examsWithNames);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const updateExam = async (req, res) => {
  try {
    const examId = req.params.id;
    const {
      subject,
      subTopic,
      level,
      status,
      questions,
      passPercentage,
      questionSelection,
      examCode,
    } = req.body;

    if (
      !subject ||
      !subTopic ||
      !level ||
      !status ||
      !questions ||
      !passPercentage
    ) {
      return res.status(400).json({ error: "All fields are required" });
    }

    if (passPercentage < 0 || passPercentage > 100) {
      return res
        .status(400)
        .json({ error: "Pass percentage must be between 0 and 100" });
    }

    if (questions.length > 200) {
      return res
        .status(400)
        .json({ error: "Cannot add more than 200 questions to a single exam" });
    }

    const exam = await examModel.findById(examId);
    if (!exam) {
      return res.status(404).json({
        success: false,
        message: "Exam not found with the provided ID",
      });
    }

    await retryTransaction(async (session) => {
      // ── Validate exam code uniqueness if changed ──────────────────────────
      if (examCode && examCode !== exam.examCode) {
        const duplicate = await examModel
          .findOne({ examCode })
          .session(session);
        if (duplicate) throw new Error("DUPLICATE_EXAM_CODE");
      }

      // ── Upsert questions ──────────────────────────────────────────────────
      // ✅ Use findByIdAndUpdate instead of existingQuestion.save({ session })
      //    to avoid transaction number mismatches on retries.
      const updatedQuestionIds = [];

      for (const question of questions) {
        const existingQuestion = await questionModel
          .findOne({
            questionText: question.questionText,
            level,
            subject,
            subTopic,
          })
          .session(session);

        if (existingQuestion) {
          await questionModel.findByIdAndUpdate(
            existingQuestion._id,
            {
              $set: {
                questionType: question.questionType,
                options: question.options ?? existingQuestion.options,
                correctAnswers: sanitizeCorrectAnswers(question),
                image: question.image ?? existingQuestion.image,
                answerKeyText: question.answerKeyText ?? existingQuestion.answerKeyText,
                answerKeyImage: question.answerKeyImage ?? existingQuestion.answerKeyImage,
              },
            },
            { session },
          );
          updatedQuestionIds.push(existingQuestion._id);
        } else {
          const [newQuestion] = await questionModel.create(
            [
              {
                subject,
                subTopic,
                level,
                questionType: question.questionType,
                questionText: question.questionText,
                options: question.options,
                correctAnswers: sanitizeCorrectAnswers(question),
                image: question.image,
                answerKeyText: question.answerKeyText,
                answerKeyImage: question.answerKeyImage,
              },
            ],
            { session, ordered: true },
          );
          updatedQuestionIds.push(newQuestion._id);
        }
      }

      // ── Process questionSets ──────────────────────────────────────────────
      const incomingQuestionSets = req.body.questionSets;
      const activeQuestionSetId = req.body.activeQuestionSetId;
      const activeQuestionSetIndex = req.body.activeQuestionSetIndex;

      let processedQuestionSets = [];

      if (incomingQuestionSets && Array.isArray(incomingQuestionSets)) {
        processedQuestionSets = incomingQuestionSets.map((set) => {
          let setQuestions = [];
          if (set.selectionType === "manual" && Array.isArray(set.questions)) {
            setQuestions = set.questions
              .map((index) =>
                typeof index === "number" &&
                index >= 0 &&
                index < updatedQuestionIds.length
                  ? updatedQuestionIds[index]
                  : null,
              )
              .filter(Boolean);
          }
          return { ...set, questions: setQuestions };
        });
      }

      // ── Determine active questions ────────────────────────────────────────
      let nextActiveQuestions = updatedQuestionIds; // default: all questions

      if (processedQuestionSets.length > 0) {
        let activeSet = null;

        if (
          activeQuestionSetIndex !== undefined &&
          activeQuestionSetIndex >= 0 &&
          activeQuestionSetIndex < processedQuestionSets.length
        ) {
          activeSet = processedQuestionSets[activeQuestionSetIndex];
        } else if (activeQuestionSetId) {
          activeSet = processedQuestionSets.find(
            (s) => s._id && s._id.toString() === activeQuestionSetId,
          );
        }

        if (activeSet) {
          if (activeSet.selectionType === "manual") {
            nextActiveQuestions = activeSet.questions;
          } else {
            // typeMap lets selectRandomQuestions look up types by index
            // since updatedQuestionIds are plain IDs, not full docs
            const typeMap = questions.map((q) => q.questionType);
            nextActiveQuestions = selectRandomQuestions(
              updatedQuestionIds,
              activeSet.config,
              typeMap,
            );
          }
        }
      }

      // ── Persist all changes atomically ────────────────────────────────────
      // ✅ Single findByIdAndUpdate instead of multiple exam.save({ session }) calls
      await examModel.findByIdAndUpdate(
        examId,
        {
          $set: {
            subject,
            subTopic,
            level,
            status,
            passPercentage: passPercentage || exam.passPercentage || 90,
            ...(examCode ? { examCode } : {}),
            poolQuestions: updatedQuestionIds,
            questions: nextActiveQuestions,
            questionSets: processedQuestionSets,
            questionSelection: questionSelection ||
              exam.questionSelection || {
                MCQ: { startIndex: 0, count: 0 },
                MSQ: { startIndex: 0, count: 0 },
                "Fill in the Blanks": { startIndex: 0, count: 0 },
                "Short Answer": { startIndex: 0, count: 0 },
              },
          },
        },
        { session },
      );

      // ── Set activeQuestionSetId after subdoc _ids are assigned by Mongo ───
      // Re-fetch within session to read the real subdoc _ids
      const savedExam = await examModel.findById(examId).session(session);

      let resolvedActiveSetId = null;

      if (processedQuestionSets.length > 0) {
        if (
          activeQuestionSetIndex !== undefined &&
          savedExam.questionSets[activeQuestionSetIndex]
        ) {
          resolvedActiveSetId =
            savedExam.questionSets[activeQuestionSetIndex]._id;
        } else if (activeQuestionSetId) {
          resolvedActiveSetId = activeQuestionSetId;
        }
      }

      if (resolvedActiveSetId) {
        await examModel.findByIdAndUpdate(
          examId,
          { $set: { activeQuestionSetId: resolvedActiveSetId } },
          { session },
        );
      }
    });

    const finalExam = await examModel.findById(examId).populate("questions");

    return res.status(200).json({
      success: true,
      message: "Exam and questions updated successfully",
      data: finalExam,
    });
  } catch (error) {
    console.error("updateExam error:", error);

    if (error.message === "ACTIVE_SUBMISSIONS") {
      return res.status(400).json({
        success: false,
        message: `Cannot modify exam: ${error.count} student(s) currently taking it`,
      });
    }
    if (error.message === "COMPLETED_SUBMISSIONS") {
      return res.status(400).json({
        success: false,
        message: `Cannot modify questions, marks, or pass percentage after ${error.count} submission(s) exist. Only status and shuffle settings can be changed.`,
        breakingChanges: error.breakingChanges,
      });
    }
    if (error.message === "DUPLICATE_EXAM_CODE") {
      return res
        .status(409)
        .json({ success: false, message: "Exam code already exists" });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to update exam",
      error: error.message,
    });
  }
};

const updateShuffleQuestion = async (req, res) => {
  try {
    const { id } = req.params;
    const exam = await examModel.findById(id);
    if (!exam) {
      return res
        .status(404)
        .json({ success: false, message: "Exam not found" });
    }

    // Check for active submissions before allowing shuffle change
    const activeSubmissions = await examSubmissionSchema.countDocuments({
      examId: id,
      status: "started",
    });

    if (activeSubmissions > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot change shuffle setting: ${activeSubmissions} student(s) currently taking exam`,
      });
    }

    await examModel.findByIdAndUpdate(id, {
      shuffleQuestion: !exam.shuffleQuestion,
    });

    res.status(200).json({
      success: true,
      message: "Questions shuffle updated successfully",
      data: exam,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Unable to update the question shuffle",
      error: error.message,
    });
  }
};

const getExamById = async (req, res) => {
  try {
    const { id } = req.params;
    const exam = await examModel.findById(id).populate("questions");

    if (!exam) {
      return res.status(404).json({
        success: false,
        message: "Exam not found with the provided ID",
      });
    }

    const examWithNames = async () => {
      const subject = await Subject.findById(exam.subject);
      const subTopic = subject?.subtopics.find(
        (sub) => sub._id.toString() === exam.subTopic.toString(),
      );

      return {
        _id: exam._id,
        subject: subject?.name || "Unknown Subject",
        subjectId: subject?._id,
        subTopic: subTopic?.name || "Unknown Subtopic",
        subTopicId: subTopic?._id || null,
        level: exam.level,
        status: exam.status,
        questions: exam.questions,
        examCode: exam.examCode,
        passPercentage: exam.passPercentage,
        shuffleQuestion: exam.shuffleQuestion,
      };
    };

    const processedExam = await examWithNames();

    res.status(200).json(processedExam);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch exam details",
      error: error.message,
    });
  }
};

const deleteExam = async (req, res) => {
  try {
    const { id } = req.params;

    const exam = await examModel.findById(id);
    if (!exam) {
      return res
        .status(404)
        .json({ success: false, message: "Exam not found" });
    }

    await retryTransaction(async (session) => {
      // Delete all submissions for this exam (including in-progress ones)
      await examSubmissionSchema.deleteMany({ examId: id }, { session });

      // Delete attempt counters for this exam
      await attemptCounterModel.deleteMany({ examId: id }, { session });

      // Delete level-pass records for the exam's subject/subTopic/level
      await userPassSchema.deleteMany(
        { subject: exam.subject, subTopic: exam.subTopic, level: exam.level },
        { session },
      );

      // Delete review records for the exam's subject/subTopic/level
      await reviewModel.deleteMany(
        { subject: exam.subject, subTopic: exam.subTopic, level: exam.level },
        { session },
      );

      // Delete ALL questions in the pool (not just the active set)
      await questionModel.deleteMany(
        { _id: { $in: exam.poolQuestions } },
        { session },
      );

      // Finally, delete the exam itself
      await examModel.findByIdAndDelete(id, { session });
    });

    return res.status(200).json({
      success: true,
      message: "Exam and all associated data deleted successfully",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to delete exam",
      error: error.message,
    });
  }
};

module.exports = {
  createExam,
  getAllExams,
  updateExam,
  updateShuffleQuestion,
  getExamById,
  deleteExam,
};
