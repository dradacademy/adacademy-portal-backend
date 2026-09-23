// Best-effort conversion of the KaTeX-flavored LaTeX this app stores in
// questionText/options/answerKeyText (see pdfImportController.js's
// EXTRACTION_PROMPT and the live KaTeX renderer in
// live-frontend/src/utils/mathText.js) into plain, readable text for the
// PDF/Word exam export (examExportController.js).
//
// This is deliberately NOT a real LaTeX renderer — properly typesetting
// formulas in the export would mean rasterizing each one (e.g. KaTeX in a
// headless browser), which is a much bigger undertaking than this export
// feature warrants. Instead it recognizes the handful of constructs this
// app's own content actually produces (see EXTRACTION_PROMPT's math rules:
// \frac, \sqrt, \times, common Greek letters, sub/superscripts, the \( \)
// delimiters) and degrades everything else to readable plain text rather
// than dumping raw backslash-commands into a printed question paper.

const SUPERSCRIPT_MAP = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "n": "ⁿ", "i": "ⁱ",
};

const SUBSCRIPT_MAP = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
  "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋",
};

// Converts a token to sub/superscript unicode chars only when every
// character in it has a mapping — otherwise returns null so the caller
// falls back to a plain "^(...)"/"_(...)" form instead of silently
// dropping unmappable characters.
const toScript = (token, map) => {
  const chars = String(token).split("");
  if (chars.length === 0 || !chars.every((c) => map[c])) return null;
  return chars.map((c) => map[c]).join("");
};

// Longest-command-first order matters for substring replacement below
// (e.g. "\\leq" must be tried before "\\le").
const SYMBOL_MAP = [
  ["\\times", "×"], ["\\cdot", "·"], ["\\div", "÷"],
  ["\\pm", "±"], ["\\mp", "∓"],
  ["\\leq", "≤"], ["\\le", "≤"], ["\\geq", "≥"], ["\\ge", "≥"],
  ["\\neq", "≠"], ["\\ne", "≠"], ["\\approx", "≈"],
  ["\\infty", "∞"], ["\\partial", "∂"], ["\\nabla", "∇"],
  ["\\rightarrow", "→"], ["\\leftarrow", "←"], ["\\to", "→"],
  ["\\Delta", "Δ"], ["\\Sigma", "Σ"], ["\\Omega", "Ω"],
  ["\\pi", "π"], ["\\alpha", "α"], ["\\beta", "β"], ["\\gamma", "γ"],
  ["\\delta", "δ"], ["\\theta", "θ"], ["\\lambda", "λ"], ["\\mu", "μ"],
  ["\\sigma", "σ"], ["\\omega", "ω"], ["\\phi", "φ"], ["\\rho", "ρ"],
  ["\\tau", "τ"], ["\\epsilon", "ε"], ["\\degree", "°"],
  ["\\ldots", "…"], ["\\cdots", "…"],
  ["\\quad", "  "], ["\\,", " "], ["\\;", " "], ["\\ ", " "],
];

// Finds the "}" balancing the "{" at str[openIdx] (which must itself be
// "{"), counting nested braces so a command argument that itself contains
// braces — e.g. the "d^{2}H" inside \frac{d^{2}H}{dz^{2}} — is captured
// whole instead of being cut off at the first inner "}". Returns null on
// an unbalanced string (caller falls back gracefully rather than looping).
const extractBraceArg = (str, openIdx) => {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === "{") depth++;
    else if (str[i] === "}") {
      depth -= 1;
      if (depth === 0) return { content: str.slice(openIdx + 1, i), end: i };
    }
  }
  return null;
};

// Repeatedly finds `\command{...}` (or, for a 2-argument command like
// \frac, `\command{...}{...}`), extracting each argument with the
// balanced-brace matching above, and replaces the whole construct with
// `replacer(...args)`. Any occurrence that doesn't parse cleanly just has
// its leading backslash dropped (degrades to plain text) so a malformed
// document can never make this loop forever.
const replaceBracedCommand = (input, command, argCount, replacer) => {
  let result = input;
  const needle = `\\${command}{`;
  for (let guard = 0; guard < 200; guard++) {
    const idx = result.indexOf(needle);
    if (idx === -1) break;

    const args = [];
    let cursor = idx + 1 + command.length; // position of arg 1's "{"
    let ok = true;
    for (let a = 0; a < argCount; a++) {
      while (result[cursor] === " ") cursor += 1;
      if (result[cursor] !== "{") {
        ok = false;
        break;
      }
      const arg = extractBraceArg(result, cursor);
      if (!arg) {
        ok = false;
        break;
      }
      args.push(arg.content);
      cursor = arg.end + 1;
    }

    if (!ok) {
      result = result.slice(0, idx) + result.slice(idx + 1); // drop just "\"
      continue;
    }

    result = result.slice(0, idx) + replacer(...args) + result.slice(cursor);
  }
  return result;
};

// Converts a stored questionText/option/explanation string containing
// KaTeX-flavored LaTeX (wrapped in \( \) per this app's own convention)
// into plain text suitable for a printed PDF/Word document. Never throws —
// falls back to stripping unrecognized commands rather than leaving raw
// backslashes in a document meant to be printed and read.
const stripLatexForPrint = (input) => {
  if (!input) return "";
  let text = String(input);

  // Drop the \( \) / \[ \] math delimiters — the content stays, the
  // wrapper goes (nothing downstream needs to know where math "started").
  text = text.replace(/\\[()[\]]/g, "");

  // \frac{a}{b} -> (a/b), balanced-brace-safe so an exponent or another
  // command inside an argument (very common — e.g. \frac{d^{2}H}{dz^{2}})
  // doesn't truncate the match.
  text = replaceBracedCommand(text, "frac", 2, (a, b) => `(${a}/${b})`);

  // \sqrt[n]{x} -> ⁿ√(x) (the bracketed-index form is rare enough here to
  // leave as a simple regex); \sqrt{x} -> √(x), balanced-brace-safe like
  // \frac above (e.g. \sqrt{a^{2}+b^{2}}).
  text = text.replace(
    /\\sqrt\[(\d+)\]\{([^{}]*)\}/g,
    (_, n, x) => `${toScript(n, SUPERSCRIPT_MAP) || n}√(${x})`,
  );
  text = replaceBracedCommand(text, "sqrt", 1, (x) => `√(${x})`);

  // Superscripts/subscripts: x^{2} / x^2 -> x²; H_{2} / H_2 -> H₂. Falls
  // back to a plain "^(...)"/"_(...)" form when the token has characters
  // this table doesn't cover (e.g. x^{ab}).
  text = text.replace(/\^\{([^{}]+)\}/g, (_, g) => toScript(g, SUPERSCRIPT_MAP) || `^(${g})`);
  text = text.replace(/\^(\w)/g, (_, g) => toScript(g, SUPERSCRIPT_MAP) || `^${g}`);
  text = text.replace(/_\{([^{}]+)\}/g, (_, g) => toScript(g, SUBSCRIPT_MAP) || `_(${g})`);
  text = text.replace(/_(\w)/g, (_, g) => toScript(g, SUBSCRIPT_MAP) || `_${g}`);

  // Known symbol/spacing commands -> their unicode/plain equivalents.
  // Plain substring replacement (not regex) so backslashes and other
  // regex-special characters in the command names are never an issue.
  SYMBOL_MAP.forEach(([cmd, sym]) => {
    text = text.split(cmd).join(sym);
  });

  // Any other \command{content} not covered above -> just the content,
  // command dropped (a few passes for nesting, same as \frac above).
  for (let pass = 0; pass < 3; pass++) {
    text = text.replace(/\\[a-zA-Z]+\{([^{}]*)\}/g, "$1");
  }
  // Any remaining bare \command with no braces -> drop the backslash,
  // keep the word (e.g. a stray "\text" -> "text" rather than vanishing).
  text = text.replace(/\\([a-zA-Z]+)/g, "$1");

  // Leftover braces from anything not otherwise unwrapped above.
  text = text.replace(/[{}]/g, "");

  return text.replace(/[ \t]{2,}/g, " ").trim();
};

// Strips the rich-text HTML that ReactQuill produces for answerKeyText
// (see CreateExamAdminForm.jsx's "Answer Key Explanation" editor) down to
// plain text with basic paragraph/line-break spacing preserved, then runs
// the result through stripLatexForPrint — an explanation can itself
// contain the same \( \) math a question does.
const htmlToPlainText = (html) => {
  if (!html) return "";
  let text = String(html);
  text = text.replace(/<\/(p|div|li|h[1-6])>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return stripLatexForPrint(text);
};

module.exports = { stripLatexForPrint, htmlToPlainText };
