const PDFDocument = require("pdfkit");
const sizeOf = require("image-size");
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle,
  ImageRun,
} = require("docx");

const examModel = require("../models/examModel");
const Subject = require("../models/subjectModel");
const markModel = require("../models/markModel");
const durationModel = require("../models/durationModel");
const {
  resolveQuestionMarks,
  resolveQuestionDuration,
  calculateTotalPossibleMarks,
} = require("../utils/ExamSubmissionHelper");
const { stripLatexForPrint, htmlToPlainText } = require("../utils/latexToPlainText");

// Same brand palette as studentProfileController.js's generateProfilePdf —
// kept as its own local copy (rather than a shared import) since that's
// the existing pattern in this codebase for a one-off PDF's constants.
const ACADEMY_TITLE = "Dr. A.D. Academy of Excellence";
const BRAND_COLOR = "#0f2a4a";
const BRAND_TINT = "#e8edf3";
const TEXT_COLOR = "#1f2933";
const MUTED_COLOR = "#6b7280";
const GOLD_ACCENT = "#c9a227";
const LIGHT_BORDER = "#d9dee5";
const GREEN = "#166534";

const QUESTION_TYPE_LABELS = {
  MCQ: "MCQ",
  MSQ: "MSQ (multiple correct)",
  "Fill in the Blanks": "Fill in the Blanks",
  "Short Answer": "Short Answer",
};

const formatExportDate = (value) => {
  const d = value ? new Date(value) : new Date();
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

// A NAT range-mode question ("any value in between counts as correct")
// has no meaningful `correctAnswers` list to print — its acceptable answer
// is the [rangeMin, rangeMax] window itself. Shared by both the PDF and
// Word export paths so the two formats can never drift on how a range
// question's answer line reads.
const formatAcceptableAnswer = (q) => {
  if (q.natAnswerMode === "range" && q.rangeMin != null && q.rangeMax != null) {
    return `${q.rangeMin} to ${q.rangeMax} (any value in this range)`;
  }
  return (q.correctAnswers || []).join(", ");
};

const formatDuration = (totalSeconds) => {
  const totalMinutes = Math.max(1, Math.round(totalSeconds / 60));
  if (totalMinutes < 60) return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m === 0 ? `${h} hour${h === 1 ? "" : "s"}` : `${h}h ${m}m`;
};

const optionTextOf = (opt) => (typeof opt === "object" && opt !== null ? opt.text : opt);
const optionImageOf = (opt) => (typeof opt === "object" && opt !== null ? opt.image : null);

// Whether the option at `optIdx` is a correct answer for MCQ/MSQ question
// `q`. Prefers `q.correctOptionIndexes` (index-based identity) when present
// — matching by option TEXT alone (the legacy fallback) mismarks every
// option that shares identical/blank text, the routine case for
// image-only options, since there's then no way to tell which one the
// admin actually marked correct. Falls back to the text-based comparison
// for any question saved before correctOptionIndexes existed.
const isOptionCorrect = (q, opt, optIdx) => {
  if (Array.isArray(q.correctOptionIndexes) && q.correctOptionIndexes.length > 0) {
    return q.correctOptionIndexes.includes(optIdx);
  }
  return (q.correctAnswers || []).includes(optionTextOf(opt));
};

// Question/option/answer-key images are Cloudinary URLs uploaded straight
// from the browser (see CreateExamAdminPage.jsx's uploadToCloudinary) —
// there's no local file/GridFS copy to read the way
// studentProfileController.js reads a profile photo. This downloads the
// bytes into memory for embedding. Never throws: a missing, slow, or
// broken image URL just means that one image is skipped from the export,
// not that the whole document fails — the same defensive approach as the
// profile-photo handling this pattern is modeled on.
const fetchImageBuffer = async (url) => {
  if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.error("Exam export: failed to fetch image", url, err?.message || err);
    return null;
  }
};

const collectImageUrls = (questions) => {
  const urls = new Set();
  questions.forEach((q) => {
    if (q.image) urls.add(q.image);
    if (q.answerKeyImage) urls.add(q.answerKeyImage);
    (q.options || []).forEach((opt) => {
      const img = optionImageOf(opt);
      if (img) urls.add(img);
    });
  });
  return [...urls];
};

const fetchAllImageBuffers = async (urls) => {
  const map = new Map();
  await Promise.all(
    urls.map(async (url) => {
      const buf = await fetchImageBuffer(url);
      if (buf) map.set(url, buf);
    }),
  );
  return map;
};

// Reads an image buffer's natural pixel dimensions + format. Returns null
// (instead of throwing) for anything image-size can't parse, so a corrupt
// file is just skipped, same as a failed fetch.
const getImageInfo = (buf) => {
  try {
    const { width, height, type } = sizeOf(buf);
    if (!width || !height) return null;
    return { width, height, type: String(type || "").toLowerCase() };
  } catch {
    return null;
  }
};

// Scales natural {width,height} down to fit within maxW × maxH while
// preserving aspect ratio — never scales up, so a small image stays small.
// This is what keeps every diagram within the A4 content width regardless
// of how large the original upload was.
const fitSize = (natural, maxW, maxH) => {
  const scale = Math.min(1, maxW / natural.width, maxH / natural.height);
  return { width: Math.max(1, Math.round(natural.width * scale)), height: Math.max(1, Math.round(natural.height * scale)) };
};

// pdfkit's doc.image() only understands JPEG and PNG — a GIF/BMP/WEBP
// buffer would throw an "unknown image format" error rather than being
// skipped gracefully. This combines the format check with the fit-size
// calculation so a PDF-incompatible image is treated exactly like a
// missing/failed one (skipped) instead of crashing the whole export.
const PDF_SUPPORTED_IMAGE_TYPES = new Set(["jpg", "jpeg", "png"]);
const getPdfCompatibleFit = (buf, maxW, maxH) => {
  if (!buf) return null;
  const info = getImageInfo(buf);
  if (!info || !PDF_SUPPORTED_IMAGE_TYPES.has(info.type)) return null;
  return fitSize(info, maxW, maxH);
};

// docx's ImageRun requires an explicit `type` and only accepts these four
// formats — same idea as the pdfkit guard above, mapped to what docx wants.
const DOCX_SUPPORTED_IMAGE_TYPES = { jpg: "jpg", jpeg: "jpg", png: "png", gif: "gif", bmp: "bmp" };

// Loads everything both export formats need, so the PDF and Word versions
// of the same exam can never disagree on the computed Total Marks/Duration
// or which images made it into the document.
const loadExamExportData = async (examId) => {
  const exam = await examModel.findById(examId).populate("questions");
  if (!exam) return null;

  const subject = await Subject.findById(exam.subject);
  const subTopic = subject?.subtopics?.find(
    (sub) => sub._id.toString() === exam.subTopic.toString(),
  );

  const [markConfig, durationConfig] = await Promise.all([
    markModel.findById("mark-based-on-levels"),
    durationModel.findById("duration-in-seconds"),
  ]);

  const questions = exam.questions || [];
  const totalMarks = calculateTotalPossibleMarks(questions, markConfig);
  const totalDurationSeconds = questions.reduce(
    (sum, q) => sum + resolveQuestionDuration(q, durationConfig),
    0,
  );

  const imageBuffers = await fetchAllImageBuffers(collectImageUrls(questions));

  return {
    exam,
    subjectName: subject?.name || "Unknown Subject",
    subTopicName: subTopic?.name || "Unknown Subtopic",
    questions,
    markConfig,
    totalMarks,
    totalDurationSeconds,
    imageBuffers,
  };
};

// ---------------------------------------------------------------------
// PDF export (pdfkit) — layout follows the same brand-band + bordered-grid
// language as studentProfileController.js's generateProfilePdf.
// ---------------------------------------------------------------------

const PDF_IMG_MAX_H = 220;
const PDF_OPTION_IMG_MAX = 90;

const renderExamPdf = (res, data) => {
  const { exam, subjectName, subTopicName, questions, markConfig, totalMarks, totalDurationSeconds, imageBuffers } = data;

  const HEADER_H = 84;
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: HEADER_H + 20, bottom: 40, left: 40, right: 40 },
    bufferPages: true,
  });

  const safeName = String(exam.examCode || "exam").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}-question-paper.pdf"`);
  doc.pipe(res);

  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottomLimit = doc.page.height - doc.page.margins.bottom;
  const pageContentHeight = bottomLimit - (HEADER_H + 20);
  const testTitle = `${subjectName} — ${subTopicName}`;

  let headerDrawCount = 0;
  const drawHeaderBand = () => {
    headerDrawCount += 1;
    doc.rect(0, 0, doc.page.width, HEADER_H).fill(BRAND_COLOR);
    doc.rect(0, HEADER_H - 3, doc.page.width, 3).fill(GOLD_ACCENT);
    doc
      .fillColor("#ffffff")
      .font("Helvetica-Bold")
      .fontSize(14)
      .text(ACADEMY_TITLE, doc.page.margins.left, 13, { width: contentWidth });
    doc
      .font("Helvetica-Bold")
      .fontSize(10.5)
      .fillColor("#cfe0f2")
      .text(testTitle, doc.page.margins.left, 33, { width: contentWidth });
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#9db6d1")
      .text(`Exam Code: ${exam.examCode || "—"}`, doc.page.margins.left, 51, { width: contentWidth });
    doc.fillColor(TEXT_COLOR).font("Helvetica");
    doc.y = HEADER_H + 14;
  };
  doc.on("pageAdded", drawHeaderBand);
  drawHeaderBand();

  // Meta strip: Subject / Date / Total Marks / Duration, a bordered 2x2
  // key/value grid — mirrors drawKvGrid's look in studentProfileController.
  const metaFields = [
    ["Subject", subjectName],
    ["Date", formatExportDate(exam.scheduledDate)],
    ["Total Marks", String(totalMarks)],
    ["Duration", formatDuration(totalDurationSeconds)],
  ];
  const metaColW = (contentWidth - 12) / 2;
  const metaRowH = 22;
  const metaTop = doc.y;
  doc.rect(doc.page.margins.left, metaTop, contentWidth, metaRowH * 2).lineWidth(0.75).stroke(LIGHT_BORDER);
  metaFields.forEach(([label, value], idx) => {
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const x = doc.page.margins.left + col * (metaColW + 12);
    const y = metaTop + row * metaRowH;
    doc.rect(x, y, metaColW, metaRowH).fill(row === 0 ? BRAND_TINT : "#ffffff");
    doc
      .font("Helvetica-Bold")
      .fontSize(8.5)
      .fillColor(MUTED_COLOR)
      .text(label, x + 8, y + 6, { width: 90, continued: false });
    doc
      .font("Helvetica-Bold")
      .fontSize(9.5)
      .fillColor(BRAND_COLOR)
      .text(value, x + 100, y + 6, { width: metaColW - 108 });
  });
  doc.y = metaTop + metaRowH * 2 + 14;
  doc.fillColor(TEXT_COLOR).font("Helvetica");

  const ensureSpace = (needed) => {
    // Only force a break when the block would actually fit on a fresh
    // page — an oversized single block (a huge image, say) is left to
    // pdfkit's own overflow pagination rather than looping addPage()
    // forever chasing a height it can never satisfy.
    if (needed <= pageContentHeight && doc.y + needed + 4 > bottomLimit) {
      doc.addPage();
    }
  };

  if (questions.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(10).fillColor(MUTED_COLOR).text("This exam has no questions yet.", { width: contentWidth });
  }

  questions.forEach((q, index) => {
    const marksInfo = resolveQuestionMarks(q, markConfig);
    const typeLabel = QUESTION_TYPE_LABELS[q.questionType] || q.questionType;
    const headerLine = `Q${index + 1}.  ${typeLabel}  ·  Level ${q.level}  ·  +${marksInfo.positive}${
      marksInfo.negative ? ` / -${marksInfo.negative}` : ""
    } marks`;
    const questionText = stripLatexForPrint(q.questionText);

    const qImgBuf = q.image ? imageBuffers.get(q.image) : null;
    const qImgFit = getPdfCompatibleFit(qImgBuf, contentWidth, PDF_IMG_MAX_H);

    const isChoice = q.questionType === "MCQ" || q.questionType === "MSQ";
    const optionRows = isChoice
      ? (q.options || []).map((opt, optIdx) => {
          const letter = String.fromCharCode(65 + optIdx);
          const text = stripLatexForPrint(optionTextOf(opt) || "");
          const isCorrect = isOptionCorrect(q, opt, optIdx);
          const imgUrl = optionImageOf(opt);
          const imgBuf = imgUrl ? imageBuffers.get(imgUrl) : null;
          const imgFit = getPdfCompatibleFit(imgBuf, contentWidth - 20, PDF_OPTION_IMG_MAX);
          return { label: `${letter}. ${text}${isCorrect ? "   ✓ Correct" : ""}`, isCorrect, imgBuf, imgFit };
        })
      : [];

    const answerLine = !isChoice
      ? `${q.questionType === "Short Answer" ? "Keyword(s)" : "Acceptable Answer(s)"}: ${formatAcceptableAnswer(q)}`
      : null;

    const explanationText = htmlToPlainText(q.answerKeyText);
    const expImgUrl = q.answerKeyImage;
    const expImgBuf = expImgUrl ? imageBuffers.get(expImgUrl) : null;
    const expImgFit = getPdfCompatibleFit(expImgBuf, contentWidth, PDF_IMG_MAX_H);

    // --- Measure (same font/size/width used for the actual draw below) ---
    doc.font("Helvetica-Bold").fontSize(10);
    let height = doc.heightOfString(headerLine, { width: contentWidth }) + 6;
    doc.font("Helvetica").fontSize(10.5);
    height += doc.heightOfString(questionText, { width: contentWidth }) + 6;
    if (qImgFit) height += qImgFit.height + 10;

    optionRows.forEach((row) => {
      doc.font(row.isCorrect ? "Helvetica-Bold" : "Helvetica").fontSize(9.5);
      height += doc.heightOfString(row.label, { width: contentWidth - 18 }) + 4;
      if (row.imgFit) height += row.imgFit.height + 6;
    });

    if (answerLine) {
      doc.font("Helvetica-Bold").fontSize(9.5);
      height += doc.heightOfString(answerLine, { width: contentWidth }) + 6;
    }

    if (explanationText || expImgFit) {
      height += 14; // "Explanation" label
      if (explanationText) {
        doc.font("Helvetica").fontSize(9.5);
        height += doc.heightOfString(explanationText, { width: contentWidth }) + 4;
      }
      if (expImgFit) height += expImgFit.height + 10;
    }
    height += 16; // bottom divider + spacing

    ensureSpace(height);
    doc.x = doc.page.margins.left;

    // --- Draw ---
    doc.font("Helvetica-Bold").fontSize(10).fillColor(BRAND_COLOR).text(headerLine, { width: contentWidth });
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(10.5).fillColor(TEXT_COLOR).text(questionText, { width: contentWidth });

    if (qImgFit && qImgBuf) {
      doc.moveDown(0.3);
      doc.image(qImgBuf, doc.page.margins.left, doc.y, { width: qImgFit.width, height: qImgFit.height });
      doc.y += qImgFit.height + 6;
    }

    if (optionRows.length) {
      doc.moveDown(0.2);
      optionRows.forEach((row) => {
        doc.x = doc.page.margins.left + 12;
        doc
          .font(row.isCorrect ? "Helvetica-Bold" : "Helvetica")
          .fontSize(9.5)
          .fillColor(row.isCorrect ? GREEN : TEXT_COLOR)
          .text(row.label, { width: contentWidth - 18 });
        if (row.imgFit && row.imgBuf) {
          doc.y += 2;
          doc.image(row.imgBuf, doc.page.margins.left + 18, doc.y, { width: row.imgFit.width, height: row.imgFit.height });
          doc.y += row.imgFit.height + 4;
        }
        doc.x = doc.page.margins.left;
      });
    }

    if (answerLine) {
      doc.moveDown(0.2);
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(GREEN).text(answerLine, { width: contentWidth });
    }

    if (explanationText || expImgFit) {
      doc.moveDown(0.3);
      doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED_COLOR).text("Explanation", { width: contentWidth });
      if (explanationText) {
        doc.font("Helvetica").fontSize(9.5).fillColor(TEXT_COLOR).text(explanationText, { width: contentWidth });
      }
      if (expImgFit && expImgBuf) {
        doc.moveDown(0.2);
        doc.image(expImgBuf, doc.page.margins.left, doc.y, { width: expImgFit.width, height: expImgFit.height });
        doc.y += expImgFit.height + 6;
      }
    }

    doc.fillColor(TEXT_COLOR).font("Helvetica");
    doc.moveDown(0.4);
    doc
      .moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.margins.left + contentWidth, doc.y)
      .lineWidth(0.5)
      .strokeColor(LIGHT_BORDER)
      .stroke();
    doc.y += 12;
  });

  // Footer with page numbers on every page — same bufferedPageRange +
  // zeroed-bottom-margin trick documented in studentProfileController.js
  // (PDFKit treats a y-position inside the bottom margin as overflow and
  // silently starts a new page unless the margin is zeroed for the draw).
  const pageRange = doc.bufferedPageRange();
  for (let i = 0; i < pageRange.count; i++) {
    doc.switchToPage(pageRange.start + i);
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .fontSize(7.5)
      .fillColor(MUTED_COLOR)
      .text(
        `${ACADEMY_TITLE}  ·  ${exam.examCode || "—"}  ·  Generated ${formatExportDate()}  ·  Page ${i + 1} of ${pageRange.count}`,
        doc.page.margins.left,
        doc.page.height - 24,
        { width: contentWidth, align: "center" },
      );
    doc.page.margins.bottom = savedBottom;
  }

  doc.end();
};

// ---------------------------------------------------------------------
// Word export (docx)
// ---------------------------------------------------------------------

const DOCX_PAGE_W_TWIPS = 11906; // A4
const DOCX_PAGE_H_TWIPS = 16838;
const DOCX_MARGIN_TWIPS = 1000; // ~0.69in, matches the PDF's 40pt margin closely
const DOCX_MAX_IMG_W_PX = Math.floor(((DOCX_PAGE_W_TWIPS - DOCX_MARGIN_TWIPS * 2) / 1440) * 96);

const THIN_BORDER = { style: BorderStyle.SINGLE, size: 2, color: "D9DEE5" };

const docxMetaRow = (pairs) =>
  new TableRow({
    children: pairs.flatMap(([label, value]) => [
      new TableCell({
        width: { size: 15, type: WidthType.PERCENTAGE },
        shading: { fill: "E8EDF3" },
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 18, color: "0F2A4A" })] })],
      }),
      new TableCell({
        width: { size: 35, type: WidthType.PERCENTAGE },
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        children: [new Paragraph({ children: [new TextRun({ text: String(value), size: 18 })] })],
      }),
    ]),
  });

const docxImageParagraph = (buf, maxW, maxH, spacingAfter) => {
  const info = buf ? getImageInfo(buf) : null;
  if (!info) return null;
  // docx's ImageRun requires an explicit `type` and only accepts these
  // four formats — an unsupported one (e.g. webp) is skipped rather than
  // crashing the whole export, same as a missing/failed image fetch.
  const docxType = DOCX_SUPPORTED_IMAGE_TYPES[info.type];
  if (!docxType) return null;
  const fit = fitSize(info, maxW, maxH);
  return new Paragraph({
    spacing: { after: spacingAfter },
    children: [new ImageRun({ data: buf, type: docxType, transformation: { width: fit.width, height: fit.height } })],
  });
};

const buildExamDocx = (data) => {
  const { exam, subjectName, subTopicName, questions, markConfig, totalMarks, totalDurationSeconds, imageBuffers } = data;
  const testTitle = `${subjectName} — ${subTopicName}`;

  const children = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [new TextRun({ text: ACADEMY_TITLE, bold: true, size: 32, color: "0F2A4A" })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
      children: [new TextRun({ text: testTitle, bold: true, size: 24 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [new TextRun({ text: `Exam Code: ${exam.examCode || "—"}`, size: 16, color: "6B7280" })],
    }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: THIN_BORDER,
        bottom: THIN_BORDER,
        left: THIN_BORDER,
        right: THIN_BORDER,
        insideHorizontal: THIN_BORDER,
        insideVertical: THIN_BORDER,
      },
      rows: [
        docxMetaRow([
          ["Subject", subjectName],
          ["Date", formatExportDate(exam.scheduledDate)],
        ]),
        docxMetaRow([
          ["Total Marks", totalMarks],
          ["Duration", formatDuration(totalDurationSeconds)],
        ]),
      ],
    }),
    new Paragraph({ text: "", spacing: { after: 200 } }),
  ];

  if (questions.length === 0) {
    children.push(new Paragraph({ children: [new TextRun({ text: "This exam has no questions yet.", italics: true, color: "6B7280" })] }));
  }

  questions.forEach((q, index) => {
    const marksInfo = resolveQuestionMarks(q, markConfig);
    const typeLabel = QUESTION_TYPE_LABELS[q.questionType] || q.questionType;
    const isChoice = q.questionType === "MCQ" || q.questionType === "MSQ";

    children.push(
      new Paragraph({
        keepNext: true,
        spacing: { before: 240, after: 60 },
        border: index > 0 ? { top: { color: "D9DEE5", space: 8, style: BorderStyle.SINGLE, size: 4 } } : undefined,
        children: [
          new TextRun({ text: `Q${index + 1}. `, bold: true, size: 22, color: "0F2A4A" }),
          new TextRun({
            text: `${typeLabel} · Level ${q.level} · +${marksInfo.positive}${
              marksInfo.negative ? ` / -${marksInfo.negative}` : ""
            } marks`,
            size: 18,
            color: "6B7280",
          }),
        ],
      }),
    );

    children.push(
      new Paragraph({
        keepNext: true,
        spacing: { after: 100 },
        children: [new TextRun({ text: stripLatexForPrint(q.questionText), size: 22 })],
      }),
    );

    if (q.image) {
      const buf = imageBuffers.get(q.image);
      if (buf) {
        const imgPara = docxImageParagraph(buf, DOCX_MAX_IMG_W_PX, 320, 120);
        if (imgPara) children.push(imgPara);
      }
    }

    if (isChoice) {
      (q.options || []).forEach((opt, optIdx) => {
        const letter = String.fromCharCode(65 + optIdx);
        const text = stripLatexForPrint(optionTextOf(opt) || "");
        const isCorrect = isOptionCorrect(q, opt, optIdx);
        children.push(
          new Paragraph({
            keepNext: true,
            indent: { left: 300 },
            spacing: { after: 40 },
            children: [
              new TextRun({ text: `${letter}. ${text}`, bold: isCorrect, color: isCorrect ? "166534" : undefined, size: 20 }),
              ...(isCorrect ? [new TextRun({ text: "   ✓ Correct", bold: true, color: "166534", size: 18 })] : []),
            ],
          }),
        );
        const optImgUrl = optionImageOf(opt);
        if (optImgUrl) {
          const buf = imageBuffers.get(optImgUrl);
          if (buf) {
            const imgPara = docxImageParagraph(buf, Math.floor(DOCX_MAX_IMG_W_PX * 0.5), 180, 60);
            if (imgPara) children.push(imgPara);
          }
        }
      });
    } else {
      children.push(
        new Paragraph({
          keepNext: true,
          spacing: { after: 80 },
          children: [
            new TextRun({
              text: `${q.questionType === "Short Answer" ? "Keyword(s)" : "Acceptable Answer(s)"}: `,
              bold: true,
              color: "166534",
              size: 20,
            }),
            new TextRun({ text: formatAcceptableAnswer(q), color: "166534", size: 20 }),
          ],
        }),
      );
    }

    const explanationText = htmlToPlainText(q.answerKeyText);
    const expImgUrl = q.answerKeyImage;
    const expBuf = expImgUrl ? imageBuffers.get(expImgUrl) : null;

    if (explanationText || expBuf) {
      children.push(
        new Paragraph({
          keepNext: true,
          spacing: { before: 60, after: 40 },
          children: [new TextRun({ text: "Explanation", bold: true, size: 18, color: "6B7280" })],
        }),
      );
      if (explanationText) {
        const lines = explanationText.split("\n").filter((l) => l.trim() !== "");
        lines.forEach((line, li) => {
          children.push(
            new Paragraph({
              keepNext: !!expBuf || li < lines.length - 1,
              spacing: { after: li === lines.length - 1 ? 80 : 20 },
              children: [new TextRun({ text: line, size: 20 })],
            }),
          );
        });
      }
      if (expBuf) {
        const imgPara = docxImageParagraph(expBuf, DOCX_MAX_IMG_W_PX, 320, 120);
        if (imgPara) children.push(imgPara);
      }
    }
  });

  return new Document({
    sections: [
      {
        properties: {
          page: {
            size: { width: DOCX_PAGE_W_TWIPS, height: DOCX_PAGE_H_TWIPS },
            margin: { top: DOCX_MARGIN_TWIPS, bottom: DOCX_MARGIN_TWIPS, left: DOCX_MARGIN_TWIPS, right: DOCX_MARGIN_TWIPS },
          },
        },
        children,
      },
    ],
  });
};

// ---------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------

const exportExamPdf = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await loadExamExportData(id);
    if (!data) {
      return res.status(404).json({ success: false, message: "Exam not found with the provided ID." });
    }
    renderExamPdf(res, data);
  } catch (error) {
    console.error("Error exporting exam as PDF:", error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: "Failed to generate the exam PDF.", error: error.message });
    } else {
      res.end();
    }
  }
};

const exportExamWord = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await loadExamExportData(id);
    if (!data) {
      return res.status(404).json({ success: false, message: "Exam not found with the provided ID." });
    }
    const document = buildExamDocx(data);
    const buffer = await Packer.toBuffer(document);
    const safeName = String(data.exam.examCode || "exam").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}-question-paper.docx"`);
    res.send(buffer);
  } catch (error) {
    console.error("Error exporting exam as Word document:", error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: "Failed to generate the exam Word document.", error: error.message });
    } else {
      res.end();
    }
  }
};

module.exports = { exportExamPdf, exportExamWord };
