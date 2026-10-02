const { GoogleGenAI, Type } = require("@google/genai");

// Clients are built lazily (one per API-key variable) so a missing key never
// crashes the server on boot. Two keys are supported:
//   GEMINI_API_KEY       - the normal key (free tier or paid, whatever it is)
//   GEMINI_API_KEY_PAID  - OPTIONAL key from a billing-enabled Google project.
//                          When set, it is used automatically as soon as the
//                          first key fails (overloaded / rate-limited / quota).
const clientCache = {};
const getClientFor = (keyName) => {
  if (!clientCache[keyName]) {
    clientCache[keyName] = new GoogleGenAI({ apiKey: process.env[keyName] });
  }
  return clientCache[keyName];
};

// Model names come from env vars so a retired/renamed model is a Railway
// variable change, never a redeploy. GEMINI_PDF_MODEL is the primary model;
// GEMINI_PDF_FALLBACK_MODELS is an optional comma-separated list tried in
// order if the primary is overloaded (503), rate-limited (429) or retired
// (404). The default below is the model Google's own 404 message pointed to
// when gemini-2.5-flash was retired (2026-09-28).
const GEMINI_MODEL = process.env.GEMINI_PDF_MODEL || "gemini-3.8-flash";
const MODEL_CHAIN = [
  GEMINI_MODEL,
  ...String(process.env.GEMINI_PDF_FALLBACK_MODELS || process.env.GEMINI_PDF_FALLBACK_MODEL || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean),
].filter((m, i, arr) => arr.indexOf(m) === i);

// Waits (ms) between retries of a transient error on the same model:
// 3 attempts per model by default.
const RETRY_DELAYS_MS = String(process.env.GEMINI_RETRY_DELAYS_MS || "3000,8000")
  .split(",")
  .map((n) => parseInt(n, 10))
  .filter((n) => Number.isFinite(n) && n >= 0);

// A very long paper may need several passes ("continue after question N").
const MAX_PASSES = parseInt(process.env.GEMINI_PDF_MAX_PASSES, 10) || 4;

// When a paid key exists, the first (free) key only gets a short try before we
// move to the paid key, so the admin isn't left waiting on a busy free tier.
const FREE_RETRY_DELAYS_MS = String(process.env.GEMINI_FREE_RETRY_DELAYS_MS || "3000")
  .split(",")
  .map((n) => parseInt(n, 10))
  .filter((n) => Number.isFinite(n) && n >= 0);

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

// ---------------------------------------------------------------------------
// Tamil / bilingual paper support. Gemini reads Tamil natively, so this is a
// prompt-level addition appended to the base prompt on every extraction.
// ---------------------------------------------------------------------------
const LANGUAGE_NOTE = `LANGUAGE RULES (the paper may be English, Tamil, or bilingual Tamil + English, e.g. TNPSC papers):
- Tamil text (தமிழ்) must be copied exactly as proper Unicode Tamil. Never translate it, never transliterate/romanize it, never replace it with English. If the source PDF uses an old non-Unicode Tamil font and the text looks garbled when read as text, read the page visually and write the correct Unicode Tamil instead.
- If a question is printed in both Tamil and English, keep BOTH in questionText (in the order printed, separated by a blank line). Do the same for options: keep both languages inside the same option string, separated by " / ". Never split one question into two questions because it is bilingual.
- Remove option labels from option text — (A) (B) (C) (D), A. B., (1) (2) (3) (4), and Tamil labels such as அ ஆ இ ஈ or (அ) (ஆ) (இ) (ஈ) — but keep the options in their original order. The option text itself must stay verbatim.
- Answer keys often give a letter or a Tamil label instead of the answer text (A/B/C/D = 1/2/3/4 = அ/ஆ/இ/ஈ in order). Always convert that to the EXACT option text of the matching option in correctAnswers — never put just a letter or number there for MCQ/MSQ.
- Tamil words and sentences are plain text. Never wrap them in math delimiters; only the mathematical expression itself goes inside \\( \\).`;

const buildPromptText = (hasAnswerKeyDocument) =>
  [EXTRACTION_PROMPT_BASE, LANGUAGE_NOTE, hasAnswerKeyDocument ? ANSWER_KEY_DOCUMENT_NOTE : null]
    .filter(Boolean)
    .join("\n\n");

// ---------------------------------------------------------------------------
// Resilient Gemini calling. The free tier regularly answers 503 "high demand"
// (a temporary Google-side overload, not a bug in this app) and occasionally
// retires a model name (404). So: retry transient errors with backoff, then
// fall back to the next configured model, and only then give up.
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const errorStatus = (e) => Number(e?.status ?? e?.code ?? e?.error?.code) || null;
const errorText = (e) => String(e?.message || e || "");

// "transient" -> wait and retry the same model; "next-model" -> this model is
// unusable right now (retired / rate-limited), move straight to the next one;
// "fatal" -> nothing else will help (bad key etc.), stop immediately.
const classifyGeminiError = (e) => {
  const status = errorStatus(e);
  const text = errorText(e);
  if (status === 401 || status === 403 || /API key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(text)) {
    return "fatal";
  }
  if (status === 404 || /no longer available|not found|NOT_FOUND/i.test(text)) return "next-model";
  if (status === 429 || /RESOURCE_EXHAUSTED/i.test(text)) return "next-model";
  if (
    [500, 502, 503, 504].includes(status) ||
    /UNAVAILABLE|high demand|overloaded|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(text)
  ) {
    return "transient";
  }
  return "fatal";
};

// Order of attempts. With only GEMINI_API_KEY set: that key, full model chain
// (same as before). With GEMINI_API_KEY_PAID also set: the first key tries
// ONLY the primary model briefly, then the paid key runs the full chain, so a
// free-tier overload never lowers accuracy by dropping to a weaker model while
// a paid key is available.
const buildAttemptPlan = () => {
  const hasPaid = Boolean(process.env.GEMINI_API_KEY_PAID);
  const plan = [];
  if (process.env.GEMINI_API_KEY) {
    plan.push({
      keyName: "GEMINI_API_KEY",
      label: hasPaid ? "free/first key" : "primary key",
      models: hasPaid ? [MODEL_CHAIN[0]] : MODEL_CHAIN,
      delays: hasPaid ? FREE_RETRY_DELAYS_MS : RETRY_DELAYS_MS,
    });
  }
  if (hasPaid) {
    plan.push({
      keyName: "GEMINI_API_KEY_PAID",
      label: "paid key",
      models: MODEL_CHAIN,
      delays: RETRY_DELAYS_MS,
    });
  }
  return plan;
};

const generateWithResilience = async (parts) => {
  const plan = buildAttemptPlan();
  if (plan.length === 0) {
    const err = new Error("No Gemini API key is configured on the server.");
    err.code = "MISSING_API_KEY";
    throw err;
  }

  let lastError;
  for (let stepIndex = 0; stepIndex < plan.length; stepIndex++) {
    const step = plan[stepIndex];
    const isLastStep = stepIndex === plan.length - 1;
    const client = getClientFor(step.keyName);

    for (const model of step.models) {
      for (let attempt = 1; attempt <= step.delays.length + 1; attempt++) {
        try {
          const response = await client.models.generateContent({
            model,
            contents: [{ role: "user", parts }],
            config: {
              responseMimeType: "application/json",
              responseSchema: EXTRACTION_RESPONSE_SCHEMA,
              maxOutputTokens: GEMINI_PDF_MAX_OUTPUT_TOKENS,
              temperature: 0,
            },
          });
          if (stepIndex > 0) console.log(`PDF extraction succeeded via ${step.label} (model ${model}).`);
          return { response, model };
        } catch (e) {
          lastError = e;
          const kind = classifyGeminiError(e);
          console.error(
            `Gemini API error during PDF question extraction (${step.label}, model ${model}, attempt ${attempt}, ${kind}):`,
            errorStatus(e),
            errorText(e).slice(0, 400),
          );
          // A bad/blocked key only stops everything if there is no other key to try.
          if (kind === "fatal") {
            if (isLastStep) throw e;
            break;
          }
          if (kind === "transient" && attempt <= step.delays.length) {
            await sleep(step.delays[attempt - 1]);
            continue;
          }
          break; // next model in this key's chain
        }
      }
    }
    if (!isLastStep) {
      console.warn(`Gemini ${step.label} could not complete the request; failing over to the next key.`);
    }
  }
  throw lastError;
};

// Pulls every COMPLETE question object out of a JSON response that was cut
// off mid-way (output-token limit, dropped connection). Quote/escape-aware,
// so braces inside question text can't confuse it.
const salvageQuestions = (raw) => {
  if (typeof raw !== "string") return [];
  const keyAt = raw.indexOf('"questions"');
  if (keyAt === -1) return [];
  const arrayStart = raw.indexOf("[", keyAt);
  if (arrayStart === -1) return [];

  const found = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectStart = -1;

  for (let i = arrayStart + 1; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === "{") {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && objectStart !== -1) {
        try {
          found.push(JSON.parse(raw.slice(objectStart, i + 1)));
        } catch (_) {
          /* skip a malformed object, keep going */
        }
        objectStart = -1;
      }
    } else if (c === "]" && depth === 0) {
      break;
    }
  }
  return found;
};

const questionKey = (q) =>
  String(q?.questionText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160)
    .toLowerCase();

const continuationNote = (questions) => {
  const lastFew = questions
    .slice(-3)
    .map((q, i) => `${questions.length - Math.min(3, questions.length) + i + 1}. ${String(q.questionText || "").replace(/\s+/g, " ").slice(0, 120)}`)
    .join("\n");
  return `CONTINUATION: ${questions.length} question(s) from this paper have already been extracted. The last ones were:\n${lastFew}\nReturn ONLY the questions that come AFTER those, in original order. Do not repeat any question already extracted. If there are no more questions, return {"questions": []}.`;
};

// One extraction pass -> { questions, cut } where `cut` means the response
// was truncated (so more questions may remain).
const runExtractionPass = async (parts) => {
  const { response } = await generateWithResilience(parts);
  const finishReason = response?.candidates?.[0]?.finishReason;
  const rawText = typeof response?.text === "function" ? response.text() : response?.text;

  let questions;
  let cut = finishReason === "MAX_TOKENS";
  try {
    const parsed = JSON.parse(rawText);
    questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
  } catch (_) {
    console.error(
      "Gemini returned non-JSON/truncated output for PDF extraction:",
      typeof rawText === "string" ? rawText.slice(0, 500) : rawText,
    );
    questions = salvageQuestions(rawText);
    cut = true;
  }
  if (cut) {
    console.error(
      `Gemini response was cut short (finishReason=${finishReason || "n/a"}); salvaged ${questions.length} complete question(s).`,
    );
  }
  return { questions, cut };
};

// Builds a clear, specific message from a Gemini SDK error instead of a
// generic "try again" — a real problem must be diagnosable from the toast.
const describeGeminiError = (apiError) => {
  const status = errorStatus(apiError);
  const rawMessage = errorText(apiError);

  if (status === 429 || /RESOURCE_EXHAUSTED|rate.?limit/i.test(rawMessage)) {
    return "The question-extraction service has hit its free-tier rate limit. Wait a minute and try again — if this keeps happening, the free daily quota may be used up for today.";
  }
  if (status === 401 || status === 403 || /API key|permission|unauthenticated/i.test(rawMessage)) {
    return "The question-extraction service's API key is missing, invalid, or restricted. Please contact the administrator to check the GEMINI_API_KEY setting.";
  }
  if (status === 404 || /no longer available|NOT_FOUND/i.test(rawMessage)) {
    return "The AI model configured for PDF import is no longer available from Google. Please ask the administrator to update the GEMINI_PDF_MODEL setting.";
  }
  if (status === 503 || /UNAVAILABLE|high demand/i.test(rawMessage)) {
    return "Google's AI service is overloaded right now (it was retried automatically, including on the backup key if one is set). This is temporary — please try again in a few minutes.";
  }
  if (/quota|billing|credit/i.test(rawMessage)) {
    return `The question-extraction service reported a quota/billing problem: ${rawMessage}`;
  }
  return `Failed to reach the question-extraction service: ${rawMessage || "unknown error"}. Please try again.`;
};

// Extracts structured draft questions from an admin-uploaded PDF question
// paper using the Gemini API. This never writes to the database — the admin
// reviews/edits the returned draftQuestions client-side and only explicit
// confirmation merges them into the normal exam create/update flow.
const extractQuestionsFromPdf = async (req, res) => {
  try {
    // questionImportRoute.js uses upload.fields([...]), so files arrive as
    // req.files.<fieldname>[0]. "file" (the question paper) is required;
    // "answerKeyFile" (a separate answer key/solutions PDF) is optional.
    const questionFile = req.files?.file?.[0];
    const answerKeyFile = req.files?.answerKeyFile?.[0];

    if (!questionFile) {
      return res.status(400).json({ success: false, message: "No PDF file uploaded." });
    }

    if (buildAttemptPlan().length === 0) {
      console.error("PDF import called without GEMINI_API_KEY configured.");
      return res.status(500).json({
        success: false,
        message: "PDF import is not configured on the server yet. Please contact the administrator.",
      });
    }

    const baseParts = [
      { inlineData: { mimeType: "application/pdf", data: questionFile.buffer.toString("base64") } },
    ];
    if (answerKeyFile) {
      baseParts.push({
        inlineData: { mimeType: "application/pdf", data: answerKeyFile.buffer.toString("base64") },
      });
    }
    const promptText = buildPromptText(Boolean(answerKeyFile));

    const allQuestions = [];
    const seen = new Set();
    let stillCut = false;
    let emptyRetries = 0;
    let pass = 0;

    while (pass < MAX_PASSES) {
      pass++;
      const text = allQuestions.length ? `${promptText}\n\n${continuationNote(allQuestions)}` : promptText;

      let result;
      try {
        result = await runExtractionPass([...baseParts, { text }]);
      } catch (apiError) {
        if (allQuestions.length > 0) {
          // Keep what we already have instead of throwing it all away.
          console.error("Later extraction pass failed; returning partial results:", errorText(apiError).slice(0, 300));
          stillCut = true;
          break;
        }
        return res.status(502).json({ success: false, message: describeGeminiError(apiError) });
      }

      const fresh = result.questions.filter((q) => {
        const key = questionKey(q);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      allQuestions.push(...fresh);

      if (allQuestions.length === 0 && fresh.length === 0 && emptyRetries < 1) {
        // Nothing usable on the very first try — one clean retry before failing.
        emptyRetries++;
        pass--;
        continue;
      }

      if (!result.cut) {
        stillCut = false;
        break;
      }
      stillCut = true;
      if (fresh.length === 0) break; // continuation produced nothing new
    }

    if (allQuestions.length === 0) {
      return res.status(422).json({
        success: false,
        message: "Could not extract any questions from this PDF. Please check the file and try again.",
      });
    }

    const draftQuestions = allQuestions.map(buildDraftQuestion);
    const withAnswerKey = draftQuestions.filter((q) => q.answerKeyText).length;

    let message = answerKeyFile
      ? `Extracted ${draftQuestions.length} question(s), with ${withAnswerKey} answer-key explanation(s) matched from the separate answer key PDF. Review and edit before adding them to the exam.`
      : `Extracted ${draftQuestions.length} question(s)${withAnswerKey ? ` (${withAnswerKey} with an answer-key explanation found in the document)` : ""}. Review and edit before adding them to the exam.`;
    if (stillCut) {
      message += ` Note: the paper was long, so extraction may have stopped early — check the last question against the PDF and import any remaining pages as a separate PDF.`;
    }

    return res.status(200).json({ success: true, message, draftQuestions });
  } catch (error) {
    console.error("Error extracting questions from PDF:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while extracting questions from the PDF.",
    });
  }
};

module.exports = {
  extractQuestionsFromPdf,
  // Exposed for unit tests only.
  _internals: { salvageQuestions, classifyGeminiError, generateWithResilience, buildPromptText, buildAttemptPlan },
};
