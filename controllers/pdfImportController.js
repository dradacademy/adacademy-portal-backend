const { GoogleGenAI, Type } = require("@google/genai");
const { looksNumericAnswerKey } = require("../utils/ExamSubmissionHelper");

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
        "A step-by-step solution/explanation for the correct answer, if one is available anywhere in the source document(s) — printed right after the question, in an answer key/solutions section elsewhere in the same document, or in a separate answer-key document provided alongside the question paper. Matched to this question by its question number/order. Follow the same LaTeX math-delimiter rule as questionText when it contains formulas. Write it as the FULL worked solution, one step per line (separate steps with a newline character, e.g. \"1. ...\\n2. ...\\n3. ...\"), keeping every formula inside \\( \\) delimiters (a matrix as \\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}). Omit this field entirely if no explanation is available for this question — never invent one.",
    },
    answerKeyConflict: {
      type: Type.STRING,
      description:
        "Set ONLY when the answer key material contradicts itself for this question — for example a quick summary table gives one answer while the worked solution for the same question arrives at a different one. One short sentence stating both answers and which one correctAnswers uses. Omit entirely when there is no contradiction.",
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
- An answer key document often has TWO parts: a quick summary table of final answers at the top AND detailed worked solutions below. Its worked solutions are the authority: take \`correctAnswers\` from the answer each worked solution actually derives (its "Final Answer" line), re-checking the arithmetic yourself when something looks off. If the summary table disagrees with the worked solution for a question, still use the worked solution and describe the disagreement in that question's \`answerKeyConflict\`.
- Every question normally has a worked solution in that document — look for each question number and fill \`explanation\` for ALL of them, with the full step-by-step working (not a summary), one step per line.
If the answer key document's numbering doesn't line up cleanly with a question, use your best judgment to match by order; if no reasonable match exists for a given question, just leave that question's \`correctAnswers\` as your best-effort guess and its \`explanation\` omitted rather than fabricating a match.`;

const buildDraftQuestion = (q) => {
  const isChoiceType = q.questionType === "MCQ" || q.questionType === "MSQ";
  const correctAnswers = Array.isArray(q.correctAnswers)
    ? q.correctAnswers
    : q.correctAnswers != null
    ? [String(q.correctAnswers)]
    : [];
  return {
    questionType: q.questionType,
    questionText: q.questionText,
    options:
      isChoiceType && Array.isArray(q.options)
        ? q.options.map((text) => ({ text, image: null }))
        : undefined,
    correctAnswers,
    // A numeric-answer ("NAT") question: a Fill in the Blanks whose answer is a
    // number. Flagging it here means it is graded by value with the automatic
    // rounding tolerance and students get the number pad - no manual tick needed.
    isNumericAnswer: q.questionType === "Fill in the Blanks" && looksNumericAnswerKey(correctAnswers),
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
    answerKeyImages: [],
    // Shown to the admin in the review screen (never saved with the question):
    // set when the answer key contradicted itself for this question.
    answerKeyWarning:
      typeof q.answerKeyConflict === "string" && q.answerKeyConflict.trim()
        ? q.answerKeyConflict.trim()
        : null,
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

// ---------------------------------------------------------------------------
// Shared extraction engine, used by both the PDF endpoint and the screenshot
// endpoint. `batches` is an array of "parts" arrays (one Gemini call group
// each): a PDF is a single batch, screenshots are split into several batches
// so any number of screenshots can be imported without hitting request-size
// limits. Questions found in earlier batches are passed forward as a
// "continuation" note so a question that spans two batches isn't duplicated.
// Returns { questions, incomplete } or { error: { status, message } }.
// ---------------------------------------------------------------------------
const runExtraction = async (batches, promptText) => {
  const allQuestions = [];
  const seen = new Set();
  let incomplete = false;
  let emptyRetries = 0;

  for (let b = 0; b < batches.length; b++) {
    let pass = 0;
    let lastCut = false;

    while (pass < MAX_PASSES) {
      pass++;
      const text = allQuestions.length ? `${promptText}\n\n${continuationNote(allQuestions)}` : promptText;

      let result;
      try {
        result = await runExtractionPass([...batches[b], { text }]);
      } catch (apiError) {
        if (allQuestions.length > 0) {
          // Keep what we already have instead of throwing it all away.
          console.error("Later extraction pass failed; returning partial results:", errorText(apiError).slice(0, 300));
          return { questions: allQuestions, incomplete: true };
        }
        return { error: { status: 502, message: describeGeminiError(apiError) } };
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

      lastCut = result.cut;
      if (!result.cut) break;
      if (fresh.length === 0) break; // continuation produced nothing new
    }

    if (lastCut) incomplete = true;
  }

  return { questions: allQuestions, incomplete };
};

// A separately-uploaded answer key normally has a worked solution for EVERY
// question, but a single extraction call sometimes returns an explanation for
// only some of them. This runs one targeted follow-up asking for just the
// questions that came back without one, and merges the results in place.
const findCompletionMatch = (question, returned, position, total) => {
  const key = questionKey(question);
  const exact = returned.find((r) => questionKey(r) === key);
  if (exact) return exact;
  const stem = key.slice(0, 50);
  const byPrefix = stem && returned.find((r) => questionKey(r).startsWith(stem));
  if (byPrefix) return byPrefix;
  return returned.length === total ? returned[position] : null;
};

const fillMissingExplanations = async (baseParts, questions) => {
  const hasText = (q) => typeof q.explanation === "string" && q.explanation.trim() !== "";
  const missing = questions.filter((q) => !hasText(q));
  if (missing.length === 0) return 0;

  const list = missing
    .map((q) => `- ${String(q.questionText || "").replace(/\s+/g, " ").slice(0, 140)}`)
    .join("\n");
  const text = `${buildPromptText(true)}

EXPLANATION COMPLETION: the separate answer key document contains a worked solution for every question. These questions came back WITHOUT an explanation:
${list}
Return ONLY these questions again (same wording, options and correct answers as the question paper), this time with \`explanation\` filled in from the answer key document, matched by question number or by the problem statement. Do not return any other question.`;

  const { questions: returned } = await runExtractionPass([...baseParts, { text }]);
  let filled = 0;
  missing.forEach((q, i) => {
    const hit = findCompletionMatch(q, returned, i, missing.length);
    if (hit && hasText(hit)) {
      q.explanation = hit.explanation;
      if (!q.answerKeyConflict && hit.answerKeyConflict) q.answerKeyConflict = hit.answerKeyConflict;
      filled++;
    }
  });
  console.log(`Answer key completion pass: ${filled} of ${missing.length} missing explanation(s) filled.`);
  return filled;
};

const notConfigured = (res) => {
  console.error("Question import called without GEMINI_API_KEY configured.");
  return res.status(500).json({
    success: false,
    message: "Question import is not configured on the server yet. Please contact the administrator.",
  });
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
    if (buildAttemptPlan().length === 0) return notConfigured(res);

    const baseParts = [
      { inlineData: { mimeType: "application/pdf", data: questionFile.buffer.toString("base64") } },
    ];
    if (answerKeyFile) {
      baseParts.push({
        inlineData: { mimeType: "application/pdf", data: answerKeyFile.buffer.toString("base64") },
      });
    }

    const outcome = await runExtraction([baseParts], buildPromptText(Boolean(answerKeyFile)));
    if (outcome.error) {
      return res.status(outcome.error.status).json({ success: false, message: outcome.error.message });
    }
    if (outcome.questions.length === 0) {
      return res.status(422).json({
        success: false,
        message: "Could not extract any questions from this PDF. Please check the file and try again.",
      });
    }

    if (answerKeyFile) {
      try {
        await fillMissingExplanations(baseParts, outcome.questions);
      } catch (completionError) {
        // Never lose the questions we already have because the extra pass failed.
        console.error("Answer key completion pass failed:", errorText(completionError).slice(0, 300));
      }
    }

    const draftQuestions = outcome.questions.map(buildDraftQuestion);
    const withAnswerKey = draftQuestions.filter((q) => q.answerKeyText).length;
    const withConflict = draftQuestions.filter((q) => q.answerKeyWarning).length;

    let message = answerKeyFile
      ? `Extracted ${draftQuestions.length} question(s), with ${withAnswerKey} answer-key explanation(s) matched from the separate answer key PDF. Review and edit before adding them to the exam.`
      : `Extracted ${draftQuestions.length} question(s)${withAnswerKey ? ` (${withAnswerKey} with an answer-key explanation found in the document)` : ""}. Review and edit before adding them to the exam.`;
    if (answerKeyFile && withAnswerKey < draftQuestions.length) {
      message += ` ${draftQuestions.length - withAnswerKey} question(s) still have no explanation — fill those in manually.`;
    }
    if (withConflict > 0) {
      message += ` ${withConflict} question(s) have an answer key that contradicts itself — they are marked in amber; please check them.`;
    }
    if (outcome.incomplete) {
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

// ---------------------------------------------------------------------------
// Screenshot import: the admin pastes / uploads any number of screenshots of a
// question paper (in order) and they are read exactly like a PDF.
// ---------------------------------------------------------------------------
const IMAGES_NOTE = `INPUT FORMAT: the paper was captured as a series of SCREENSHOTS (not a PDF). Each one is labelled "Screenshot k of N" in the order the admin captured them. Treat them as consecutive pages of ONE question paper:
- A question, or its options, may continue from the bottom of one screenshot onto the top of the next — join them into a single question. Screenshots may also overlap and show the same question twice — extract it only once.
- Ignore browser/app chrome, taskbars, watermarks, page numbers, ads and cursor marks.
- A screenshot labelled "context only" was already processed in an earlier batch. Use it only to complete a question that continues onto the following screenshots; do NOT extract questions that were fully visible in it again.
- If a question depends on a diagram or figure, still extract the question text exactly as written; never invent the figure's content.
- If part of a screenshot is blurry or cut off, extract only what is actually readable; never guess missing words or options.
- If some screenshots show an answer key or solutions, use them to fill correctAnswers and answerKeyText for the matching question numbers instead of guessing.`;

const buildImagePromptText = () => [EXTRACTION_PROMPT_BASE, LANGUAGE_NOTE, IMAGES_NOTE].join("\n\n");

// Screenshots per Gemini call, and a byte ceiling per call (Gemini limits the
// total inline request size, so big screenshots get split across calls).
const IMAGE_BATCH_SIZE = parseInt(process.env.GEMINI_IMAGE_BATCH_SIZE, 10) || 8;
const IMAGE_BATCH_MAX_BYTES = 12 * 1024 * 1024;
const MAX_IMAGES = 40;

const makeImageBatches = (files) => {
  const batches = [];
  let current = [];
  let bytes = 0;
  files.forEach((file, index) => {
    if (current.length && (current.length >= IMAGE_BATCH_SIZE || bytes + file.buffer.length > IMAGE_BATCH_MAX_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push({ file, index });
    bytes += file.buffer.length;
  });
  if (current.length) batches.push(current);
  return batches;
};

const imagePart = (file) => ({
  inlineData: { mimeType: file.mimetype, data: file.buffer.toString("base64") },
});

// Each batch after the first re-includes the previous batch's last screenshot
// as "context only", so a question that straddles two batches is read whole.
const buildImageBatchParts = (batches, total) =>
  batches.map((batch, i) => {
    const parts = [];
    if (i > 0) {
      const prev = batches[i - 1][batches[i - 1].length - 1];
      parts.push({ text: `Screenshot ${prev.index + 1} of ${total} (context only — already processed in the previous batch):` });
      parts.push(imagePart(prev.file));
    }
    batch.forEach(({ file, index }) => {
      parts.push({ text: `Screenshot ${index + 1} of ${total}:` });
      parts.push(imagePart(file));
    });
    return parts;
  });

const extractQuestionsFromImages = async (req, res) => {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) {
      return res.status(400).json({ success: false, message: "No screenshots uploaded." });
    }
    if (files.length > MAX_IMAGES) {
      return res.status(400).json({ success: false, message: `Too many screenshots. Please upload at most ${MAX_IMAGES} at a time.` });
    }
    if (buildAttemptPlan().length === 0) return notConfigured(res);

    const batches = makeImageBatches(files);
    const batchParts = buildImageBatchParts(batches, files.length);

    const outcome = await runExtraction(batchParts, buildImagePromptText());
    if (outcome.error) {
      return res.status(outcome.error.status).json({ success: false, message: outcome.error.message });
    }
    if (outcome.questions.length === 0) {
      return res.status(422).json({
        success: false,
        message: "Could not read any questions from these screenshots. Make sure the text is clear and fully visible, then try again.",
      });
    }

    const draftQuestions = outcome.questions.map(buildDraftQuestion);
    const withAnswerKey = draftQuestions.filter((q) => q.answerKeyText).length;

    let message = `Extracted ${draftQuestions.length} question(s) from ${files.length} screenshot(s)${withAnswerKey ? ` (${withAnswerKey} with an answer-key explanation)` : ""}. Review and edit before adding them to the exam.`;
    const shotConflicts = draftQuestions.filter((q) => q.answerKeyWarning).length;
    if (shotConflicts > 0) {
      message += ` ${shotConflicts} question(s) have an answer key that contradicts itself — they are marked in amber; please check them.`;
    }
    if (outcome.incomplete) {
      message += " Note: extraction may have stopped early — check the last question against your screenshots and import any remaining ones separately.";
    }
    return res.status(200).json({ success: true, message, draftQuestions });
  } catch (error) {
    console.error("Error extracting questions from screenshots:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while extracting questions from the screenshots.",
    });
  }
};

module.exports = {
  extractQuestionsFromPdf,
  extractQuestionsFromImages,
  // Exposed for unit tests only.
  _internals: {
    fillMissingExplanations,
    buildDraftQuestion,
    salvageQuestions,
    classifyGeminiError,
    generateWithResilience,
    buildPromptText,
    buildAttemptPlan,
    makeImageBatches,
    buildImageBatchParts,
    buildImagePromptText,
  },
};
