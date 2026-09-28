const { GoogleGenAI, Type } = require("@google/genai");

// Lazily constructed so a missing GEMINI_API_KEY doesn't crash the whole
// server on boot — it only surfaces as a clean error the first time this
// endpoint is actually called.
let geminiClient = null;
const getGeminiClient = () => {
  if (!geminiClient) {
    if (!process.env.GEMINI_API_KEY) {
      const err = new Error("GEMINI_API_KEY is not configured on the server.");
      err.code = "MISSING_API_KEY";
      throw err;
    }
    geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return geminiClient;
};

// Configurable via env var so a retired/renamed model can be swapped without
// a code change or redeploy — same pattern used elsewhere in this codebase
// (e.g. ANTHROPIC_PDF_MODEL previously). "gemini-2.5-flash" is Google's
// current free-tier-eligible model with native PDF understanding as of this
// writing (2026-09-28).
const GEMINI_MODEL = process.env.GEMINI_PDF_MODEL || "gemini-2.5-flash";

// A full question paper (especially one with many questions, long option
// lists, or a non-Latin script like Tamil, which tends to use more tokens
// per character) can produce a large JSON response. 8192 output tokens was
// found in practice to truncate mid-response on a real TNPSC paper, which
// then failed to parse as JSON. Raised generously and made configurable in
// case a future model has a different real ceiling.
const GEMINI_PDF_MAX_OUTPUT_TOKENS = parseInt(process.env.GEMINI_PDF_MAX_OUTPUT_TOKENS, 10) || 65536;

// Gemini's structured-output schema uses the SDK's own Type enum (rather
// than raw "object"/"string" strings) so the correct casing is guaranteed
// regardless of what the underlying REST API expects — this is the
// officially recommended way to build a responseSchema with this SDK.
const QUESTION_ITEM_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    questionType: {
      type: Type.STRING,
      enum: ["MCQ", "Fill in the Blanks", "MSQ", "Short Answer"],
      description:
        "MCQ = single correct option, MSQ = multiple correct options, Fill in the Blanks / Short Answer = no options.",
    },
    questionText: {
      type: Type.STRING,
      description:
        "The exact question text, verbatim — do not paraphrase or summarize. Any math must be written as KaTeX-flavored LaTeX and every complete math expression must be wrapped in \\( \\) delimiters (e.g. \"What is \\(x^{2}\\) when \\(x=3\\)?\", \"the equation reduces to \\(\\frac{d^{2}H}{dz^{2}} = 0\\)\"). Use proper LaTeX constructs for compound expressions instead of ASCII shorthand — \\frac{a}{b} not a/b, \\sqrt{x} not sqrt(x), \\times not x for multiplication — so a whole expression parses as one unit rather than a chain of loose symbols. A fill-in-the-blank marker (e.g. ____) is plain text, never wrapped in math delimiters.",
    },
    options: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        "Only for MCQ/MSQ — the answer options verbatim, in order. Omit entirely for Fill in the Blanks / Short Answer. Any math in an option must follow the exact same rule as questionText: KaTeX LaTeX wrapped in \\( \\) delimiters, real LaTeX constructs (\\frac, \\partial, \\sqrt, etc.), never raw Unicode math characters (no ², ³, ∂, √, × typed directly — always \\partial, \\sqrt{}, \\times inside \\( \\)). A short numeric or plain-text option like \"2\" or \"True\" needs no delimiters at all.",
    },
    correctAnswers: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        "The correct answer(s). For MCQ/MSQ, use the exact option text of the correct option(s). If an answer key is not present in the document, make a best-effort guess and never leave this empty.",
    },
    level: {
      type: Type.INTEGER,
      description:
        "Best-effort difficulty level from 1 (easiest) to 4 (hardest). Must be exactly 1, 2, 3, or 4. Default to 2 when genuinely ambiguous.",
    },
    marks: {
      type: Type.NUMBER,
      description:
        "Positive marks for this question, only if explicitly stated in the document. Omit if unknown — omission is safe and falls back to a level-based default.",
    },
    negativeMark: {
      type: Type.NUMBER,
      description:
        "Negative marks for a wrong answer, only if explicitly stated in the document. Omit if unknown.",
    },
    duration: {
      type: Type.NUMBER,
      description:
        "Suggested time budget in seconds for this question, only if explicitly stated or strongly implied by the document. Omit if unknown.",
    },
    explanation: {
      type: Type.STRING,
      description:
        "A step-by-step solution/explanation for the correct answer, if one is available anywhere in the source document(s) — printed right after the question, in an answer key/solutions section elsewhere in the same document, or in a separate answer-key document provided alongside the question paper. Matched to this question by its question number/order. Follow the same LaTeX math-delimiter rule as questionText when it contains formulas. Omit this field entirely if no explanation is available for this question — never invent one.",
    },
  },
  required: ["questionType", "questionText", "correctAnswers", "level"],
};

const EXTRACTION_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    questions: {
      type: Type.ARRAY,
      items: QUESTION_ITEM_SCHEMA,
    },
  },
  required: ["questions"],
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
- Return your entire answer as the structured JSON response described by the response schema. Do not include any other prose or commentary outside that JSON.`;

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

// Builds a clear, specific error message from a Gemini SDK error rather than
// a generic "try again" — a lesson learned the hard way from an earlier
// AI-provider outage on this exact feature, where a real billing/credit
// problem hid behind a message that told the admin nothing actionable and
// needed a server-log lookup to diagnose. Whatever isn't a recognized case
// still surfaces the SDK's own error text, so a genuinely new failure mode
// is diagnosable straight from the toast the admin sees.
const describeGeminiError = (apiError) => {
  const status = apiError?.status;
  const rawMessage = apiError?.message || String(apiError || "");

  if (status === 429 || /RESOURCE_EXHAUSTED|rate.?limit/i.test(rawMessage)) {
    return "The question-extraction service has hit its free-tier rate limit. Wait a minute and try again — if this keeps happening, the free daily quota may be used up for today.";
  }
  if (status === 401 || status === 403 || /API key|permission|unauthenticated/i.test(rawMessage)) {
    return "The question-extraction service's API key is missing, invalid, or restricted. Please contact the administrator to check the GEMINI_API_KEY setting.";
  }
  if (/quota|billing|credit/i.test(rawMessage)) {
    return `The question-extraction service reported a quota/billing problem: ${rawMessage}`;
  }
  return `Failed to reach the question-extraction service: ${rawMessage || "unknown error"}. Please try again.`;
};

// Extracts structured draft questions from an admin-uploaded PDF question
// paper using the Gemini API (Google's free-tier-eligible AI service). This
// never writes to the database — the admin reviews/edits the returned
// draftQuestions client-side and only explicit confirmation merges them into
// the normal exam create/update flow.
const extractQuestionsFromPdf = async (req, res) => {
  try {
    // questionImportRoute.js uses upload.fields([...]), so files arrive as
    // req.files.<fieldname>[0] instead of upload.single()'s req.file. "file"
    // (the question paper) is required; "answerKeyFile" (a separately-
    // uploaded answer key/solutions PDF) is optional.
    const questionFile = req.files?.file?.[0];
    const answerKeyFile = req.files?.answerKeyFile?.[0];

    if (!questionFile) {
      return res.status(400).json({ success: false, message: "No PDF file uploaded." });
    }

    let client;
    try {
      client = getGeminiClient();
    } catch (err) {
      if (err.code === "MISSING_API_KEY") {
        console.error("PDF import called without GEMINI_API_KEY configured.");
        return res.status(500).json({
          success: false,
          message: "PDF import is not configured on the server yet. Please contact the administrator.",
        });
      }
      throw err;
    }

    const base64Data = questionFile.buffer.toString("base64");
    const answerKeyBase64 = answerKeyFile ? answerKeyFile.buffer.toString("base64") : null;

    const parts = [
      {
        inlineData: {
          mimeType: "application/pdf",
          data: base64Data,
        },
      },
    ];

    if (answerKeyBase64) {
      parts.push({
        inlineData: {
          mimeType: "application/pdf",
          data: answerKeyBase64,
        },
      });
    }

    parts.push({
      text: answerKeyBase64
        ? `${EXTRACTION_PROMPT_BASE}\n\n${ANSWER_KEY_DOCUMENT_NOTE}`
        : EXTRACTION_PROMPT_BASE,
    });

    let response;
    try {
      response = await client.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: "user", parts }],
        config: {
          responseMimeType: "application/json",
          responseSchema: EXTRACTION_RESPONSE_SCHEMA,
          maxOutputTokens: GEMINI_PDF_MAX_OUTPUT_TOKENS,
        },
      });
    } catch (apiError) {
      console.error(
        "Gemini API error during PDF question extraction:",
        apiError?.status,
        apiError?.message || apiError,
      );
      return res.status(502).json({
        success: false,
        message: describeGeminiError(apiError),
      });
    }

    // A response cut short by the output-token cap is the most common real
    // cause of unparseable JSON (a long/dense document, e.g. many questions
    // or a non-Latin script, produces more output than the cap allows) — a
    // distinct, actionable case worth telling the admin about specifically,
    // rather than lumping it into the generic parse-failure message below.
    const finishReason = response?.candidates?.[0]?.finishReason;
    if (finishReason === "MAX_TOKENS") {
      console.error(
        `Gemini response truncated at the output-token limit (${GEMINI_PDF_MAX_OUTPUT_TOKENS}) during PDF extraction.`,
      );
      return res.status(502).json({
        success: false,
        message:
          "This document produced more content than the extraction service could return at once. Try splitting the PDF into smaller sections (e.g. by subject or a portion of the questions) and importing each separately.",
      });
    }

    // The SDK exposes the combined text output as a `.text` property (not a
    // method) on the response in the current @google/genai version — guard
    // for either shape defensively in case that changes in a future SDK
    // release.
    const rawText = typeof response?.text === "function" ? response.text() : response?.text;

    let parsedResponse;
    try {
      parsedResponse = JSON.parse(rawText);
    } catch (parseError) {
      console.error(
        "Gemini returned non-JSON output for PDF extraction:",
        typeof rawText === "string" ? rawText.slice(0, 2000) : rawText,
      );
      return res.status(502).json({
        success: false,
        message: "The extraction service returned an unexpected response. Please try again.",
      });
    }

    const extractedQuestions = parsedResponse?.questions;

    if (!Array.isArray(extractedQuestions) || extractedQuestions.length === 0) {
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
