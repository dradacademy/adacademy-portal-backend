const Anthropic = require("@anthropic-ai/sdk");

// Lazily constructed so a missing ANTHROPIC_API_KEY doesn't crash the whole
// server on boot — it only surfaces as a clean error the first time this
// endpoint is actually called.
let anthropicClient = null;
const getAnthropicClient = () => {
  if (!anthropicClient) {
    if (!process.env.ANTHROPIC_API_KEY) {
      const err = new Error("ANTHROPIC_API_KEY is not configured on the server.");
      err.code = "MISSING_API_KEY";
      throw err;
    }
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
};

const ANTHROPIC_MODEL = process.env.ANTHROPIC_PDF_MODEL || "claude-sonnet-4-5-20250929";

const EXTRACT_QUESTIONS_TOOL = {
  name: "extract_questions",
  description:
    "Return every exam question found in the PDF question paper, in the same order they appear in the document.",
  input_schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            questionType: {
              type: "string",
              enum: ["MCQ", "Fill in the Blanks", "MSQ", "Short Answer"],
              description:
                "MCQ = single correct option, MSQ = multiple correct options, Fill in the Blanks / Short Answer = no options.",
            },
            questionText: {
              type: "string",
              description:
                "The exact question text, verbatim — do not paraphrase or summarize. Any math must be written as KaTeX-flavored LaTeX and every complete math expression must be wrapped in \\( \\) delimiters (e.g. \"What is \\(x^{2}\\) when \\(x=3\\)?\", \"the equation reduces to \\(\\frac{d^{2}H}{dz^{2}} = 0\\)\"). Use proper LaTeX constructs for compound expressions instead of ASCII shorthand — \\frac{a}{b} not a/b, \\sqrt{x} not sqrt(x), \\times not x for multiplication — so a whole expression parses as one unit rather than a chain of loose symbols. A fill-in-the-blank marker (e.g. ____) is plain text, never wrapped in math delimiters.",
            },
            options: {
              type: "array",
              items: { type: "string" },
              description:
                "Only for MCQ/MSQ — the answer options verbatim, in order. Omit entirely for Fill in the Blanks / Short Answer. Any math in an option must follow the exact same rule as questionText: KaTeX LaTeX wrapped in \\( \\) delimiters, real LaTeX constructs (\\frac, \\partial, \\sqrt, etc.), never raw Unicode math characters (no ², ³, ∂, √, × typed directly — always \\partial, \\sqrt{}, \\times inside \\( \\)). A short numeric or plain-text option like \"2\" or \"True\" needs no delimiters at all.",
            },
            correctAnswers: {
              type: "array",
              items: { type: "string" },
              description:
                "The correct answer(s). For MCQ/MSQ, use the exact option text of the correct option(s). If an answer key is not present in the document, make a best-effort guess and never leave this empty.",
            },
            level: {
              type: "integer",
              enum: [1, 2, 3, 4],
              description:
                "Best-effort difficulty level from 1 (easiest) to 4 (hardest). Default to 2 when genuinely ambiguous.",
            },
            marks: {
              type: "number",
              description:
                "Positive marks for this question, only if explicitly stated in the document. Omit if unknown — omission is safe and falls back to a level-based default.",
            },
            negativeMark: {
              type: "number",
              description:
                "Negative marks for a wrong answer, only if explicitly stated in the document. Omit if unknown.",
            },
            duration: {
              type: "number",
              description:
                "Suggested time budget in seconds for this question, only if explicitly stated or strongly implied by the document. Omit if unknown.",
            },
            explanation: {
              type: "string",
              description:
                "A step-by-step solution/explanation for the correct answer, if one is available anywhere in the source document(s) — printed right after the question, in an answer key/solutions section elsewhere in the same document, or in a separate answer-key document provided alongside the question paper. Matched to this question by its question number/order. Follow the same LaTeX math-delimiter rule as questionText when it contains formulas. Omit this field entirely if no explanation is available for this question — never invent one.",
            },
          },
          required: ["questionType", "questionText", "correctAnswers", "level"],
        },
      },
    },
    required: ["questions"],
  },
};

const EXTRACTION_PROMPT_BASE = `You are extracting exam questions from an arbitrary, unstructured PDF question paper so an admin can review and import them into an exam builder.

Rules:
- Extract every question in the document, in original order, regardless of layout (single/multi-column, tables, numbered lists, mixed sections).
- Preserve exact wording — do not paraphrase, correct, or summarize question or option text.
- Write any mathematical notation as KaTeX-flavored LaTeX, and wrap every complete math expression in \\( \\) delimiters, e.g. "What is \\(x^{2}\\) when \\(x=3\\)?", "the equation reduces to \\(\\frac{d^{2}H}{dz^{2}} = 0\\), where...". This rule applies identically everywhere math appears — the question stem AND every answer option — never treat options as plain text by default just because they're short. Never leave bare LaTeX commands or sub/superscripts floating undelimited in the prose — the delimiters are what let the exam viewer tell math apart from ordinary text reliably. Use real LaTeX constructs for anything compound (\\frac{a}{b} for a fraction or derivative, \\partial for ∂, \\sqrt{x}, \\times, \\pi, \\alpha, etc.) rather than ASCII approximations or raw Unicode math characters (never type ², ³, ∂, √, × literally — always the LaTeX command inside \\( \\)) — a whole expression should be one delimited unit, not several bare symbols side by side, and never a mix of LaTeX commands and literal Unicode symbols in the same expression. Do not use images or unicode math symbols for anything LaTeX can express. A fill-in-the-blank marker (e.g. a line of underscores) is plain text and must never be placed inside math delimiters. A short plain-text/numeric option (e.g. "True", "2") needs no math treatment at all.
- Do not attempt to extract embedded diagrams, charts, or images as files, in questions OR in any answer key/explanation. If a question (or its explanation) references a diagram/image that is essential to it, say so plainly inline (e.g. "[Diagram referenced — needs manual image attachment]") but still extract the rest of the text around it.
- level, marks, negativeMark, and duration are best-effort. Only set marks/negativeMark/duration when the document actually states them (e.g. "2 marks each", "-1 for wrong answer", "90 seconds per question"); otherwise omit those fields entirely rather than guessing a number — omitting them is always safe. Default level to 2 when there's no basis to judge difficulty.
- explanation: if a written solution/explanation for a question's correct answer is available anywhere in the source — printed right after the question, in an answer key/solutions section elsewhere in the same document, or in a separate answer-key document provided alongside the question paper (see below if one was provided) — extract it into that question's \`explanation\` field, matched by question number/order. Apply the same LaTeX math-delimiter rule as questionText when it contains formulas. Omit the field entirely for a question with no available explanation — never invent one.
- correctAnswers must never be left empty: use the explicit answer key wherever one is available (inline, in an answer-key section, or in a separate document); only fall back to your own best-effort guess when no answer key for that question exists anywhere in the source(s).
- Call the extract_questions tool exactly once with the complete result. Do not include any other prose or commentary.`;

// Appended to the base prompt only when a second, separately-uploaded PDF
// is present — kept out of the prompt entirely on a single-file import so
// the model isn't told to look for a document that isn't there.
const ANSWER_KEY_DOCUMENT_NOTE = `A SECOND PDF has also been provided, immediately after the question paper above. It is a SEPARATE answer key / solutions document for the SAME question paper — it does not contain more questions to extract. Match each of its entries to the corresponding question above by question number (both documents are numbered/ordered the same way), and for every question you can match:
- Prefer the answer key document's stated correct answer for \`correctAnswers\` over guessing from the question paper alone.
- Use the answer key document's explanation/working, if it gives one, for \`explanation\`.
If the answer key document's numbering doesn't line up cleanly with a question, use your best judgment to match by order; if no reasonable match exists for a given question, just leave that question's \`correctAnswers\` as your best-effort guess and its \`explanation\` omitted rather than fabricating a match.`;

const buildDraftQuestion = (q) => {
  const isChoiceType = q.questionType === "MCQ" || q.questionType === "MSQ";
  return {
    questionType: q.questionType,
    questionText: q.questionText,
    options:
      isChoiceType && Array.isArray(q.options)
        ? q.options.map((text) => ({ text, image: null }))
        : undefined,
    correctAnswers: Array.isArray(q.correctAnswers)
      ? q.correctAnswers
      : q.correctAnswers != null
      ? [String(q.correctAnswers)]
      : [],
    level: [1, 2, 3, 4].includes(q.level) ? q.level : 2,
    marks: typeof q.marks === "number" ? q.marks : null,
    negativeMark: typeof q.negativeMark === "number" ? q.negativeMark : null,
    duration: typeof q.duration === "number" ? q.duration : null,
    image: null,
    // Populated from the model's extracted `explanation` when the source
    // document(s) actually had one (inline, an answer-key section, or a
    // separately-uploaded answer key PDF) — otherwise left null exactly
    // like before, so manual entry via the Answer Key section in
    // CreateExamAdminForm.jsx still works unchanged for anything the AI
    // couldn't find. answerKeyImage stays manual-only either way: figures
    // are always pasted in by hand, same as question/option images.
    answerKeyText:
      typeof q.explanation === "string" && q.explanation.trim()
        ? q.explanation.trim()
        : null,
    answerKeyImage: null,
  };
};

// Extracts structured draft questions from an admin-uploaded PDF question
// paper using the Anthropic API. This never writes to the database — the
// admin reviews/edits the returned draftQuestions client-side and only
// explicit confirmation merges them into the normal exam create/update flow.
const extractQuestionsFromPdf = async (req, res) => {
  try {
    // questionImportRoute.js now uses upload.fields([...]), so files arrive
    // as req.files.<fieldname>[0] instead of the old upload.single()'s
    // req.file. "file" (the question paper) is required; "answerKeyFile"
    // (a separately-uploaded answer key/solutions PDF) is optional.
    const questionFile = req.files?.file?.[0];
    const answerKeyFile = req.files?.answerKeyFile?.[0];

    if (!questionFile) {
      return res.status(400).json({ success: false, message: "No PDF file uploaded." });
    }

    let client;
    try {
      client = getAnthropicClient();
    } catch (err) {
      if (err.code === "MISSING_API_KEY") {
        console.error("PDF import called without ANTHROPIC_API_KEY configured.");
        return res.status(500).json({
          success: false,
          message: "PDF import is not configured on the server yet. Please contact the administrator.",
        });
      }
      throw err;
    }

    const base64Data = questionFile.buffer.toString("base64");
    const answerKeyBase64 = answerKeyFile ? answerKeyFile.buffer.toString("base64") : null;

    const content = [
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: base64Data,
        },
      },
    ];

    if (answerKeyBase64) {
      content.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: answerKeyBase64,
        },
      });
    }

    content.push({
      type: "text",
      text: answerKeyBase64
        ? `${EXTRACTION_PROMPT_BASE}\n\n${ANSWER_KEY_DOCUMENT_NOTE}`
        : EXTRACTION_PROMPT_BASE,
    });

    let response;
    try {
      response = await client.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 8192,
        tools: [EXTRACT_QUESTIONS_TOOL],
        tool_choice: { type: "tool", name: "extract_questions" },
        messages: [
          {
            role: "user",
            content,
          },
        ],
      });
    } catch (apiError) {
      console.error("Anthropic API error during PDF question extraction:", apiError?.message || apiError);
      return res.status(502).json({
        success: false,
        message: "Failed to reach the question-extraction service. Please try again.",
      });
    }

    const toolUseBlock = (response.content || []).find(
      (block) => block.type === "tool_use" && block.name === "extract_questions",
    );

    const extractedQuestions = toolUseBlock?.input?.questions;

    if (!toolUseBlock || !Array.isArray(extractedQuestions) || extractedQuestions.length === 0) {
      return res.status(422).json({
        success: false,
        message: "Could not extract any questions from this PDF. Please check the file and try again.",
      });
    }

    const draftQuestions = extractedQuestions.map(buildDraftQuestion);
    const withAnswerKey = draftQuestions.filter((q) => q.answerKeyText).length;

    return res.status(200).json({
      success: true,
      message: answerKeyBase64
        ? `Extracted ${draftQuestions.length} question(s), with ${withAnswerKey} answer-key explanation(s) matched from the separate answer key PDF. Review and edit before adding them to the exam.`
        : `Extracted ${draftQuestions.length} question(s)${withAnswerKey ? ` (${withAnswerKey} with an answer-key explanation found in the document)` : ""}. Review and edit before adding them to the exam.`,
      draftQuestions,
    });
  } catch (error) {
    console.error("Error extracting questions from PDF:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while extracting questions from the PDF.",
    });
  }
};

module.exports = { extractQuestionsFromPdf };
