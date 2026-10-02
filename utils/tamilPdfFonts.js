const fs = require("fs");
const path = require("path");

// pdfkit's built-in fonts (Helvetica etc.) have no Tamil glyphs, so Tamil text
// prints blank. This helper registers Noto Sans Tamil (which also contains
// Latin letters, digits and basic punctuation) and transparently switches to
// it for any text call that contains Tamil, then restores the previous font.
// English-only text keeps using Helvetica exactly as before.
//
// Font files live in  <backend>/assets/fonts/ . If they are missing the
// helper does nothing, so the PDF still generates (Tamil just stays blank).

const FONT_DIR = path.join(__dirname, "..", "assets", "fonts");
const REGULAR_PATH = path.join(FONT_DIR, "NotoSansTamil-Regular.ttf");
const BOLD_PATH = path.join(FONT_DIR, "NotoSansTamil-Bold.ttf");

const TAMIL_RE = /[\u0B80-\u0BFF]/;
const hasTamil = (text) => typeof text === "string" && TAMIL_RE.test(text);

const enableTamilPdfFonts = (doc) => {
  if (!fs.existsSync(REGULAR_PATH)) {
    console.warn("Tamil PDF font not found at", REGULAR_PATH, "- Tamil text will not render in PDF exports.");
    return doc;
  }
  const hasBold = fs.existsSync(BOLD_PATH);

  doc.registerFont("TamilRegular", REGULAR_PATH);
  doc.registerFont("TamilBold", hasBold ? BOLD_PATH : REGULAR_PATH);

  const originalFont = doc.font.bind(doc);
  let currentFont = "Helvetica";

  // Remember which font the caller asked for, so we can restore it and know
  // whether they wanted bold.
  doc.font = function (name, ...rest) {
    currentFont = name;
    return originalFont(name, ...rest);
  };

  ["text", "heightOfString", "widthOfString"].forEach((method) => {
    const original = doc[method].bind(doc);
    doc[method] = function (text, ...args) {
      if (!hasTamil(text)) return original(text, ...args);
      const previous = currentFont;
      originalFont(/bold/i.test(previous) ? "TamilBold" : "TamilRegular");
      try {
        return original(text, ...args);
      } finally {
        originalFont(previous);
      }
    };
  });

  return doc;
};

module.exports = { enableTamilPdfFonts, hasTamil };
