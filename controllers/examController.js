const examModel = require("../models/examModel");
const questionModel = require("../models/questionModel");
const Subject = require("../models/subjectModel");
const examSubmissionSchema = require("../models/examSubmissionSchema");
const examPassModel = require("../models/examPassModel");
const attemptCounterModel = require("../models/attemptCounterModel");
const reviewModel = require("../models/ReviewModel");
const { retryTransaction } = require("../utils/transactionHelper");
const { createNotification } = require("./notificationController");
const { regradeExamSubmissions } = require("../utils/regradeHelper");
const { parseNumericAnswer } = require("../utils/ExamSubmissionHelper");

/**
 * For MCQ/MSQ: sanitize the index-based `correctOptionIndexes` — bounds-
 * checked against the (possibly just-resolved) options array, deduplicated,
 * integers only. Returns `undefined` (never `[]`) when there's no usable
 * index data, so the question is correctly treated as "no index identity"
 * everywhere downstream (grading, export, UI) and falls back to the legacy
 * text-based `correctAnswers` comparison instead of "explicitly zero
 * correct options." `resolvedOptions` lets callers pass the options array
 * that will actually be saved (which, on update, may fall back to the
 * existing question's options when the request omits `options`).
 */
const sanitizeCorrectOptionIndexes = (question, resolvedOptions) => {
  const { questionType, correctOptionIndexes } = question;
  if (
    (questionType !== "MCQ" && questionType !== "MSQ") ||
    !Array.isArray(resolvedOptions) ||
    !Array.isArray(correctOptionIndexes) ||
    correctOptionIndexes.length === 0
  ) {
    return undefined;
  }

  const validIndexes = [
    ...new Set(
      correctOptionIndexes.filter(
        (i) => Number.isInteger(i) && i >= 0 && i < resolvedOptions.length,
      ),
    ),
  ];

  return validIndexes.length > 0 ? validIndexes : undefined;
};

/**
 * For MCQ/MSQ: ensure correctAnswers contains only values
 * that exist in the options array. Map labels like "A" to the
 * matching option. Remove duplicates.
 *
 * Preferred path: when the question carries usable `correctOptionIndexes`
 * (see sanitizeCorrectOptionIndexes above), correctAnswers is rebuilt as a
 * pure TEXT MIRROR of those indexes, read straight off the options array.
 * This is what fixes the case reported in production: an MCQ/MSQ question
 * whose options are all image-only (blank text) previously had its
 * correct-answer identity resolved purely by TEXT, which collided whenever
 * more than one option shared the same (blank) text — every option lit up
 * as "correct" in the builder, and worse, the resolved blank-text answer
 * used to be silently dropped by a `.filter(Boolean)` at the end of this
 * function, making the question grade as always-Incorrect for every
 * student once actually saved. The index-based mirror can't collide (each
 * option has a unique position) and never produces an empty string that
 * looks falsy, so neither failure mode can happen when index data exists.
 *
 * Legacy fallback (no correctOptionIndexes yet — every question saved
 * before this fix): resolves each stored TEXT value against options,
 * unchanged from before, except the trailing filter now only discards a
 * genuinely-unresolved label, not a legitimately-matched blank string.
 */
const sanitizeCorrectAnswers = (question, resolvedOptions) => {
  const { questionType, correctAnswers } = question;
  const options = resolvedOptions ?? question.options;
  if (
    (questionType !== "MCQ" && questionType !== "MSQ") ||
    !Array.isArray(options) ||
    !Array.isArray(correctAnswers)
  ) {
    return correctAnswers || [];
  }

  const sanitizedIndexes = sanitizeCorrectOptionIndexes(question, options);
  if (sanitizedIndexes) {
    return [
      ...new Set(
        sanitizedIndexes.map((i) => {
          const opt = options[i];
          return typeof opt === "object" && opt !== null ? opt.text ?? "" : opt ?? "";
        }),
      ),
    ];
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
      // Genuinely unmatched (label doesn't resolve to any option) — drop it.
      return null;
    })
    // Previously `.filter(Boolean)`, which also silently dropped a
    // legitimately-resolved blank-text ("") correct answer — see the bug
    // note above. Only drop entries that are genuinely unresolved (null).
    .filter((v) => v !== null);

  // Deduplicate
  return [...new Set(resolved)];
};

/**
 * Resolves the NAT range-grading fields for a question being created or
 * updated. Only meaningful when the admin picked "range" mode for a
 * numeric-answer question — otherwise both fields are always forced back to
 * null, so a question that was previously in range mode and gets edited
 * back to exact mode (or to a non-numeric type) never keeps stale
 * rangeMin/rangeMax data from an earlier edit.
 */
const resolveNatRangeFields = (question) => {
  const mode = question.natAnswerMode === "range" ? "range" : "exact";
  return {
    natAnswerMode: mode,
    rangeMin: mode === "range" ? question.rangeMin ?? null : null,
    rangeMax: mode === "range" ? question.rangeMax ?? null : null,
  };
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
      status,
      questions,
      passPercentage,
      questionSelection,
      questionSets,
      scheduledDate,
      allNumericAnswerKeypad,
    } = req.body;

    if (
      !subject ||
      !subTopic ||
      !status ||
      !questions ||
      !passPercentage
    ) {
      return res.status(400).json({ error: "All fields are required" });
    }

    if (questions.some((q) => !q.level)) {
      return res
        .status(400)
        .json({ error: "Every question must have a level" });
    }

    // Auto-assign this exam's position in its subject+subTopic sequence.
    const lastExam = await examModel
      .findOne({ subject, subTopic })
      .sort({ order: -1 });
    const order = lastExam ? lastExam.order + 1 : 1;

    const examCode = await generateUniqueExamCode();

    await retryTransaction(async (session) => {
      const createdQuestions = await questionModel.create(
        questions.map((question) => ({
          subject,
          subTopic,
          level: question.level,
          marks: question.marks ?? null,
          negativeMark: question.negativeMark ?? null,
          duration: question.duration ?? null,
          questionType: question.questionType,
          questionText: question.questionText,
          options: question.options,
          correctAnswers: sanitizeCorrectAnswers(question, question.options),
          correctOptionIndexes: sanitizeCorrectOptionIndexes(question, question.options),
          // Bug fix: this was previously dropped on create — every
          // freshly-created question silently lost its "Numeric answer
          // (NAT-style)" checkbox state and fell back to the schema
          // default (false), regardless of what the admin ticked.
          isNumericAnswer: !!question.isNumericAnswer,
          ...resolveNatRangeFields(question),
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
            order,
            status,
            scheduledDate: scheduledDate || null,
            // Test is visible to students the moment it's created active.
            publishedAt: status === "active" ? new Date() : null,
            passPercentage: passPercentage || 90,
            allNumericAnswerKeypad: !!allNumericAnswerKeypad,
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

    // Notify students in this exam's category the moment it's posted live
    // — never for a draft/inactive status. Best-effort: never fails the
    // actual exam creation.
    if (status === "active") {
      Subject.findById(subject)
        .select("category name")
        .then((subjectDoc) => {
          if (!subjectDoc) return;
          return createNotification({
            category: subjectDoc.category,
            type: "test",
            title: `New test posted: ${subjectDoc.name} (${examCode})`,
            refId: createdExam._id,
            refModel: "Exam",
            createdBy: req.user._id,
          });
        })
        .catch((err) => console.error("Failed to create test notification:", err.message));
    }

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
        order: exam.order,
        status: exam.status,
        questions: exam.questions,
        poolQuestions: exam.poolQuestions,
        questionSets: exam.questionSets,
        activeQuestionSetId: exam.activeQuestionSetId,
        passPercentage: exam.passPercentage,
        examCode: exam.examCode,
        shuffleQuestion: exam.shuffleQuestion,
        allNumericAnswerKeypad: exam.allNumericAnswerKeypad,
        scheduledDate: exam.scheduledDate,
        publishedAt: exam.publishedAt,
        createdAt: exam.createdAt,
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
      status,
      questions,
      passPercentage,
      questionSelection,
      examCode,
      scheduledDate,
      allNumericAnswerKeypad,
    } = req.body;

    if (
      !subject ||
      !subTopic ||
      !status ||
      !questions ||
      !passPercentage
    ) {
      return res.status(400).json({ error: "All fields are required" });
    }

    if (questions.some((q) => !q.level)) {
      return res
        .status(400)
        .json({ error: "Every question must have a level" });
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
        // Match by _id when the client already knows which question this
        // is (e.g. editing an existing exam's question); this is more
        // reliable than matching by text+level now that level/marks/
        // duration are independently editable per question. Fall back to
        // the old text+level match for legacy payloads without an _id.
        const existingQuestion = question._id
          ? await questionModel.findById(question._id).session(session)
          : await questionModel
              .findOne({
                questionText: question.questionText,
                level: question.level,
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
                questionText: question.questionText,
                level: question.level,
                marks: question.marks ?? null,
                negativeMark: question.negativeMark ?? null,
                duration: question.duration ?? null,
                options: question.options ?? existingQuestion.options,
                correctAnswers: sanitizeCorrectAnswers(
                  question,
                  question.options ?? existingQuestion.options,
                ),
                correctOptionIndexes: sanitizeCorrectOptionIndexes(
                  question,
                  question.options ?? existingQuestion.options,
                ),
                // Bug fix: this was previously dropped on update too — even
                // re-editing an existing question and ticking "Numeric
                // answer (NAT-style)" never actually saved the change.
                isNumericAnswer: !!question.isNumericAnswer,
                ...resolveNatRangeFields(question),
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
                level: question.level,
                marks: question.marks ?? null,
                negativeMark: question.negativeMark ?? null,
                duration: question.duration ?? null,
                questionType: question.questionType,
                questionText: question.questionText,
                options: question.options,
                correctAnswers: sanitizeCorrectAnswers(question, question.options),
                correctOptionIndexes: sanitizeCorrectOptionIndexes(question, question.options),
                isNumericAnswer: !!question.isNumericAnswer,
                ...resolveNatRangeFields(question),
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
      // First time this exam is ever set to "active", stamp publishedAt —
      // the "date made available to students" tracked in the Test Tracking
      // dashboards. Never overwritten by a later re-activation, and never
      // cleared by deactivating, so it always reflects the original date.
      const publishedAtUpdate =
        status === "active" && !exam.publishedAt
          ? { publishedAt: new Date() }
          : {};

      await examModel.findByIdAndUpdate(
        examId,
        {
          $set: {
            subject,
            subTopic,
            status,
            scheduledDate:
              scheduledDate !== undefined ? scheduledDate || null : exam.scheduledDate,
            ...publishedAtUpdate,
            passPercentage: passPercentage || exam.passPercentage || 90,
            allNumericAnswerKeypad:
              allNumericAnswerKeypad !== undefined
                ? !!allNumericAnswerKeypad
                : exam.allNumericAnswerKeypad,
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

    // Retroactively re-grade every already-completed submission for this
    // exam against whatever the answer key/marks/pass percentage look
    // like now — e.g. an admin switching a NAT question to range mode, or
    // fixing a wrong answer key, must correct already-attempted students'
    // marks and pass/fail too, not just future attempts. See
    // utils/regradeHelper.js. Failure here must never fail the exam
    // update itself (the edit already succeeded and was already
    // committed) — log and report a null summary instead.
    let regradeSummary = null;
    try {
      regradeSummary = await regradeExamSubmissions(examId);
    } catch (regradeError) {
      console.error("Post-update regrade failed:", regradeError);
    }

    return res.status(200).json({
      success: true,
      message: "Exam and questions updated successfully",
      data: finalExam,
      regradeSummary,
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
        order: exam.order,
        status: exam.status,
        questions: exam.questions,
        examCode: exam.examCode,
        passPercentage: exam.passPercentage,
        shuffleQuestion: exam.shuffleQuestion,
        allNumericAnswerKeypad: exam.allNumericAnswerKeypad,
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

      // Delete this exam's pass records (now keyed directly by examId,
      // since level no longer identifies an exam uniquely).
      await examPassModel.deleteMany({ examId: exam._id }, { session });

      // NOTE: evaluator review records (ReviewModel) are still keyed by
      // subject+subTopic+level, a percentage-range review-criteria config
      // that isn't tied to one specific exam instance. Now that an exam no
      // longer carries a single `level`, this cleanup can't be expressed
      // correctly here — flagged as a follow-up (plan §8) to rekey/redesign
      // ReviewModel. Intentionally left untouched on exam delete for now.

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

// On-demand admin action: re-grade every already-completed submission for
// one exam against its CURRENT answer key/marks/pass percentage, without
// requiring the admin to touch anything else about the exam. Exists as a
// manual complement to updateExam's automatic post-save regrade — for an
// exam whose answer key was already edited (e.g. before this regrade
// mechanism existed), an admin can trigger the correction directly.
const regradeExam = async (req, res) => {
  try {
    const examId = req.params.id;

    const exam = await examModel.findById(examId);
    if (!exam) {
      return res.status(404).json({
        success: false,
        message: "Exam not found with the provided ID",
      });
    }

    const regradeSummary = await regradeExamSubmissions(examId);

    return res.status(200).json({
      success: true,
      message:
        regradeSummary.marksChanged > 0 || regradeSummary.passChanged > 0
          ? `Re-graded ${regradeSummary.totalChecked} completed attempt(s): ${regradeSummary.marksChanged} mark(s) updated, ${regradeSummary.passChanged} pass/fail status(es) changed.`
          : `Checked ${regradeSummary.totalChecked} completed attempt(s) — all already match the current answer key.`,
      regradeSummary,
    });
  } catch (error) {
    console.error("regradeExam error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to re-grade exam submissions",
      error: error.message,
    });
  }
};

// Matches a numeric tolerance range stated in prose, e.g. "Range: 1.09 to
// 1.11", "range 3.10 - 3.12", "(0.69 to 0.71)", or with a unit repeated on
// each number ("Range: 3.10 m to 3.12 m", "45 kN to 50 kN"). Deliberately
// permissive on the separator (to/-/–/—) since both AI-generated (PDF
// import) and manually-typed answer explanations phrase this differently,
// and on an optional short unit token immediately after either number.
const RANGE_TEXT_PATTERN =
  /(-?\d+(?:\.\d+)?)\s*[a-zA-Z°%\/²³]{0,12}\s*(?:to|-|–|—)\s*(-?\d+(?:\.\d+)?)\s*[a-zA-Z°%\/²³]{0,12}/i;

/**
 * Pulls a stated tolerance range out of a question's answerKeyText, e.g.
 * "1.10 (Range: 1.09 to 1.11)" → { rangeMin: "1.09", rangeMax: "1.11" }.
 * Strips HTML first (answerKeyText is routinely Quill-authored rich text),
 * and — when the word "range" appears — only searches from that point
 * onward so a coincidental "1 to 2" earlier in a free-text explanation
 * isn't mistaken for the answer tolerance. Returns null when no usable
 * range can be found, or when the two numbers are out of order.
 */
const extractRangeFromAnswerKeyText = (answerKeyText) => {
  if (typeof answerKeyText !== "string" || !answerKeyText.trim()) return null;

  const plainText = answerKeyText.replace(/<[^>]*>/g, " ");
  const rangeLabelIndex = plainText.search(/range/i);
  const searchText =
    rangeLabelIndex >= 0 ? plainText.slice(rangeLabelIndex) : plainText;

  const match = searchText.match(RANGE_TEXT_PATTERN);
  if (!match) return null;

  const min = parseFloat(match[1]);
  const max = parseFloat(match[2]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    return null;
  }

  return { rangeMin: match[1], rangeMax: match[2] };
};

/**
 * One-time (safely re-runnable) backfill for "Short Answer" questions that
 * were created before Short Answer supported structured range-mode grading
 * (see ExamSubmissionHelper.js's getAnswerStatus/calculateMarks). A GATE-
 * style numerical question entered as Short Answer often already states an
 * acceptable range in its answer explanation ("1.10 (Range: 1.09 to
 * 1.11)"), but that text is purely decorative prose with no structural
 * connection to grading — grading only ever compared the student's answer
 * against the single "Expected Keyword" via exact substring match, so an
 * in-range-but-not-identical answer (e.g. "1.09") was wrongly marked
 * Incorrect.
 *
 * This finds every affected question (Short Answer, not already in range
 * mode, exactly one keyword that is itself a plain number), extracts the
 * stated range from its answer explanation, sets natAnswerMode/rangeMin/
 * rangeMax on it, then re-grades every already-completed submission for
 * every exam that references it — so a single admin action corrects both
 * "present" (future) grading AND "previous" (already-completed) attempts,
 * without requiring the admin to manually re-open and re-save each
 * question in the exam builder one at a time.
 *
 * Deliberately conservative: a question with zero or multiple keywords, a
 * non-numeric keyword, or no parseable "X to Y" range in its explanation
 * text is left completely untouched (reported back as skipped) rather than
 * guessed at.
 */
const backfillShortAnswerRanges = async (req, res) => {
  try {
    const candidates = await questionModel.find({
      questionType: "Short Answer",
      natAnswerMode: { $ne: "range" },
      answerKeyText: { $exists: true, $ne: null, $ne: "" },
    });

    const updatedQuestionIds = [];
    // Broken down by reason so the admin action can report exactly why a
    // question was left untouched instead of one opaque total (a plain
    // total gives no way to tell "nothing needed fixing" apart from "the
    // range text just isn't being recognized").
    let multiOrZeroKeywordSkipped = 0;
    let nonNumericKeywordSkipped = 0;
    let noRangeFoundSkipped = 0;
    // A handful of concrete examples per skip reason, returned alongside
    // the counts, so a skip that turns out to be a bug (e.g. a range
    // phrasing the regex doesn't recognize) can be diagnosed directly from
    // the response instead of needing raw database access.
    const skippedSamples = [];
    const pushSample = (question, reason, extra) => {
      if (skippedSamples.length >= 10) return;
      skippedSamples.push({
        questionId: question._id,
        reason,
        correctAnswers: question.correctAnswers,
        ...extra,
      });
    };

    for (const question of candidates) {
      // Range mode only makes sense for a single numeric expected value —
      // a genuinely free-text Short Answer question, or one with several
      // acceptable keywords, is left alone entirely.
      if (
        !Array.isArray(question.correctAnswers) ||
        question.correctAnswers.length !== 1
      ) {
        multiOrZeroKeywordSkipped += 1;
        pushSample(question, "multi-or-zero-keyword");
        continue;
      }
      // parseNumericAnswer returns NaN (never null) for an unparseable
      // value — Number.isNaN is the correct check here.
      if (Number.isNaN(parseNumericAnswer(question.correctAnswers[0]))) {
        nonNumericKeywordSkipped += 1;
        pushSample(question, "non-numeric-keyword");
        continue;
      }

      const range = extractRangeFromAnswerKeyText(question.answerKeyText);
      if (!range) {
        noRangeFoundSkipped += 1;
        pushSample(question, "no-range-found-in-explanation", {
          answerKeyTextPreview: String(question.answerKeyText).slice(0, 300),
        });
        continue;
      }

      question.natAnswerMode = "range";
      question.rangeMin = range.rangeMin;
      question.rangeMax = range.rangeMax;
      await question.save();
      updatedQuestionIds.push(question._id);
    }

    const skippedCount =
      multiOrZeroKeywordSkipped + nonNumericKeywordSkipped + noRangeFoundSkipped;

    // Find every exam referencing any of the just-updated questions — a
    // question can be pulled into an exam via straight selection, the
    // random-pick pool, or a question set, so all three must be checked.
    let examsRegraded = 0;
    let totalChecked = 0;
    let marksChanged = 0;
    let passChanged = 0;

    if (updatedQuestionIds.length > 0) {
      const affectedExams = await examModel
        .find({
          $or: [
            { questions: { $in: updatedQuestionIds } },
            { poolQuestions: { $in: updatedQuestionIds } },
            { "questionSets.questions": { $in: updatedQuestionIds } },
          ],
        })
        .select("_id");

      for (const exam of affectedExams) {
        const examRegrade = await regradeExamSubmissions(exam._id);
        examsRegraded += 1;
        totalChecked += examRegrade.totalChecked;
        marksChanged += examRegrade.marksChanged;
        passChanged += examRegrade.passChanged;
      }
    }

    return res.status(200).json({
      success: true,
      message:
        updatedQuestionIds.length > 0
          ? `Updated ${updatedQuestionIds.length} Short Answer question(s) to range-mode grading. Re-graded ${examsRegraded} exam(s): ${marksChanged} mark(s) updated, ${passChanged} pass/fail status(es) changed.${
              skippedCount > 0
                ? ` (${skippedCount} other question(s) skipped: ${multiOrZeroKeywordSkipped} multi/zero-keyword, ${nonNumericKeywordSkipped} non-numeric, ${noRangeFoundSkipped} no range found.)`
                : ""
            }`
          : `No Short Answer questions needed updating (${skippedCount} checked and skipped — ${multiOrZeroKeywordSkipped} had zero/multiple expected keywords, ${nonNumericKeywordSkipped} had a non-numeric keyword, ${noRangeFoundSkipped} had no "X to Y" range found in their answer explanation).`,
      updatedQuestionCount: updatedQuestionIds.length,
      skippedCount,
      skippedBreakdown: {
        multiOrZeroKeyword: multiOrZeroKeywordSkipped,
        nonNumericKeyword: nonNumericKeywordSkipped,
        noRangeFoundInExplanation: noRangeFoundSkipped,
      },
      skippedSamples,
      examsRegraded,
      totalChecked,
      marksChanged,
      passChanged,
    });
  } catch (error) {
    console.error("backfillShortAnswerRanges error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to backfill Short Answer range grading",
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
  regradeExam,
  backfillShortAnswerRanges,
};
