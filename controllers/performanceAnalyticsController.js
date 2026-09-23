const PDFDocument = require("pdfkit");
const userModel = require("../models/userModel");
const {
  computeCategoryPerformance,
  computeCategoryLeaderboards,
  computeStudentAttemptHistory,
  computeCategoryRollup,
} = require("../utils/performanceAnalyticsHelper");

// Same brand palette as the Student Profile PDF export
// (studentProfileController.js) — deliberately duplicated rather than
// shared, matching how that file also keeps its own copy, so this PDF
// reads as the same document family without coupling the two controllers.
const BRAND_COLOR = "#0f2a4a";
const BRAND_TINT = "#e8edf3";
const TEXT_COLOR = "#1f2933";
const MUTED_COLOR = "#6b7280";
const GOLD_ACCENT = "#c9a227";
const LIGHT_BORDER = "#d9dee5";
const GOOD_COLOR = "#166534";
const WEAK_COLOR = "#b45309";

const orDash = (value) => (value === undefined || value === null ? "—" : String(value));
const formatPdfDate = (value) => {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

// GET /api/performance-analytics/me — a student's own comparison against
// every other student enrolled in the SAME exam category. `hasCategory:
// false` means this account has no category set yet (shouldn't normally
// happen for a student, but handled rather than 500ing); `hasData: false`
// (nested inside the payload) means the category itself has no completed
// submissions from anyone yet.
const getMyPerformanceAnalytics = async (req, res) => {
  try {
    const data = await computeCategoryPerformance(req.user._id);
    if (!data) {
      return res.status(200).json({ success: true, data: { hasCategory: false } });
    }
    res.status(200).json({ success: true, data: { hasCategory: true, ...data } });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to compute performance analytics.",
      error: error.message,
    });
  }
};

// GET /api/performance-analytics/:studentId (admin only) — the exact same
// category-peer comparison, for any student the admin picks. Reuses the
// same helper as the student's own view, so the numbers a student sees for
// themselves and what the admin sees when looking them up can never drift
// apart.
const getStudentPerformanceAnalytics = async (req, res) => {
  try {
    const { studentId } = req.params;
    const student = await userModel.findById(studentId).select("role");
    if (!student || student.role !== "student") {
      return res.status(404).json({ success: false, message: "Student not found." });
    }
    const data = await computeCategoryPerformance(studentId);
    if (!data) {
      return res.status(200).json({ success: true, data: { hasCategory: false } });
    }
    res.status(200).json({ success: true, data: { hasCategory: true, ...data } });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to compute performance analytics.",
      error: error.message,
    });
  }
};

// GET /api/performance-analytics/leaderboards/me — top-10-per-test
// leaderboard for the requesting student's own category. Unlike /me above
// (which is "how do I compare"), this is "who's actually on top" — visible
// to every student in the category, not just their own numbers.
const getMyCategoryLeaderboards = async (req, res) => {
  try {
    const data = await computeCategoryLeaderboards(req.user._id);
    if (!data) {
      return res.status(200).json({ success: true, data: { hasCategory: false } });
    }
    res.status(200).json({ success: true, data: { hasCategory: true, ...data } });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to compute leaderboards.",
      error: error.message,
    });
  }
};

// GET /api/performance-analytics/trend/me — this student's own attempt
// history in chronological order, the shared source data behind both the
// Trend-Over-Time chart and the Speed vs. Accuracy quadrant scatter on the
// Performance page (two views of the same per-attempt data, one fetch).
const getMyAttemptHistory = async (req, res) => {
  try {
    const data = await computeStudentAttemptHistory(req.user._id);
    if (!data) {
      return res.status(200).json({ success: true, data: { hasCategory: false } });
    }
    res.status(200).json({ success: true, data: { hasCategory: true, ...data } });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to compute attempt history.",
      error: error.message,
    });
  }
};

// GET /api/performance-analytics/rollup/:category (admin only) — a
// period-based, category-wide rollup: pass rate, average marks/speed/
// accuracy, and the most-missed topics across every exam in that category,
// not one exam at a time. Optional ?fromDate=&toDate= (ISO dates) narrow
// the window; omitted, it's all-time.
const getCategoryRollup = async (req, res) => {
  try {
    const { category } = req.params;
    const { fromDate, toDate } = req.query;
    const data = await computeCategoryRollup(category, { fromDate, toDate });
    if (!data) {
      return res.status(400).json({ success: false, message: "Unknown exam category." });
    }
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to compute category rollup.",
      error: error.message,
    });
  }
};

// GET /api/performance-analytics/:studentId/pdf (admin only) — a print-
// ready "Performance Report" mirroring the Student Profile PDF export's
// brand styling, covering the same ground as the on-screen Performance
// page: overall rank/percentile, readiness tier, speed/accuracy vs.
// category average, a hand-drawn trend line (no external chart-to-image
// step needed — pdfkit draws the polyline directly), the per-topic
// comparison, and the per-exam comparison table. Generated live from
// current data on every request, same discipline as the profile PDF —
// never a cached copy that could drift out of sync.
const generatePerformanceReportPdf = async (req, res) => {
  try {
    const { studentId } = req.params;
    const student = await userModel
      .findById(studentId)
      .select("username email registerNumber category role");
    if (!student || student.role !== "student") {
      return res.status(404).json({ success: false, message: "Student not found." });
    }

    const [comparison, history] = await Promise.all([
      computeCategoryPerformance(studentId),
      computeStudentAttemptHistory(studentId),
    ]);

    const HEADER_H = 108;
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: HEADER_H + 18, bottom: 46, left: 40, right: 40 },
      bufferPages: true,
    });

    const safeName = (student.username || "student").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}-performance-report.pdf"`);
    doc.pipe(res);

    const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bottomLimit = doc.page.height - doc.page.margins.bottom;
    const categoryLabel = comparison?.categoryLabel || "—";

    const drawHeaderBand = () => {
      doc.rect(0, 0, doc.page.width, HEADER_H).fill(BRAND_COLOR);
      doc.rect(0, HEADER_H - 3, doc.page.width, 3).fill(GOLD_ACCENT);
      doc
        .fillColor("#ffffff")
        .font("Helvetica-Bold")
        .fontSize(17)
        .text("Dr. A.D. Academy of Excellence", doc.page.margins.left, 20, { width: contentWidth });
      doc
        .font("Helvetica")
        .fontSize(10.5)
        .fillColor("#cfe0f2")
        .text("Performance Report", doc.page.margins.left, 44, { width: contentWidth });
      doc
        .font("Helvetica")
        .fontSize(8.5)
        .fillColor("#9db6d1")
        .text(
          `${orDash(student.username)}   ·   Register No: ${orDash(student.registerNumber)}   ·   ${categoryLabel}   ·   Generated ${formatPdfDate(new Date())}`,
          doc.page.margins.left,
          62,
          { width: contentWidth }
        );
      doc.fillColor(TEXT_COLOR).font("Helvetica");
      doc.y = HEADER_H + 16;
    };
    doc.on("pageAdded", drawHeaderBand);
    drawHeaderBand();

    const ensureSpace = (needed) => {
      if (doc.y + needed > bottomLimit) doc.addPage();
    };

    const drawSectionHeader = (title) => {
      ensureSpace(30);
      const y = doc.y;
      const h = 20;
      doc.rect(doc.page.margins.left, y, contentWidth, h).fill(BRAND_TINT);
      doc.rect(doc.page.margins.left, y, 4, h).fill(BRAND_COLOR);
      doc
        .fillColor(BRAND_COLOR)
        .font("Helvetica-Bold")
        .fontSize(10)
        .text(title, doc.page.margins.left + 12, y + 5, { width: contentWidth - 20 });
      doc.y = y + h + 8;
      doc.fillColor(TEXT_COLOR).font("Helvetica");
    };

    // ---- No data at all: a short, honest one-page note instead of an
    // empty-looking report. ----
    if (!comparison || !comparison.hasData) {
      drawSectionHeader("Summary");
      doc
        .font("Helvetica")
        .fontSize(10)
        .fillColor(MUTED_COLOR)
        .text(
          comparison
            ? "This student has not completed any tests yet in their exam category, so there is nothing to report on yet."
            : "This student has no exam category assigned yet.",
          doc.page.margins.left,
          doc.y,
          { width: contentWidth }
        );
      doc.end();
      return;
    }

    // ---- Summary stat row ----
    drawSectionHeader("Summary");
    const statBoxes = [
      ["Overall Rank", comparison.overall ? `#${comparison.overall.rank} of ${comparison.overall.totalStudents}` : "—"],
      ["Percentile", comparison.overall?.percentile !== null && comparison.overall?.percentile !== undefined ? `${comparison.overall.percentile}%` : "—"],
      ["Average Score", comparison.overall ? `${comparison.overall.avgPercentage}%` : "—"],
      ["Category Average", comparison.overall ? `${comparison.overall.categoryAvgPercentage}%` : "—"],
    ];
    const boxGap = 8;
    const boxWidth = (contentWidth - boxGap * (statBoxes.length - 1)) / statBoxes.length;
    ensureSpace(52);
    const statY = doc.y;
    statBoxes.forEach(([label, value], i) => {
      const x = doc.page.margins.left + i * (boxWidth + boxGap);
      doc.rect(x, statY, boxWidth, 44).lineWidth(0.75).stroke(LIGHT_BORDER);
      doc.font("Helvetica-Bold").fontSize(13).fillColor(BRAND_COLOR).text(value, x + 6, statY + 8, { width: boxWidth - 12 });
      doc.font("Helvetica").fontSize(7.5).fillColor(MUTED_COLOR).text(label, x + 6, statY + 28, { width: boxWidth - 12 });
    });
    doc.y = statY + 44 + 10;
    doc.fillColor(TEXT_COLOR).font("Helvetica");

    // Readiness tier + speed/accuracy line
    if (history?.readiness) {
      const r = history.readiness;
      ensureSpace(16);
      doc
        .font("Helvetica-Bold")
        .fontSize(9.5)
        .fillColor(r.tier === "Exam Ready" ? GOOD_COLOR : r.tier === "Building" ? WEAK_COLOR : BRAND_COLOR)
        .text(`Readiness: ${r.tier}`, doc.page.margins.left, doc.y, { continued: true })
        .font("Helvetica")
        .fillColor(MUTED_COLOR)
        .text(
          `   (${r.topicsAttempted}/${r.totalTopics} topics covered)`,
          { continued: false }
        );
      doc.moveDown(0.3);
    }
    if (comparison.speedAccuracy) {
      const sa = comparison.speedAccuracy;
      ensureSpace(14);
      doc
        .font("Helvetica")
        .fontSize(9.5)
        .fillColor(TEXT_COLOR)
        .text(
          `Speed: ${orDash(sa.myAvgSpeed)}% (category avg ${orDash(sa.categoryAvgSpeed)}%)   ·   Accuracy: ${orDash(sa.myAvgAccuracy)}% (category avg ${orDash(sa.categoryAvgAccuracy)}%)`,
          doc.page.margins.left,
          doc.y,
          { width: contentWidth }
        );
      doc.moveDown(0.6);
    }

    // ---- Trend line — hand-drawn directly with pdfkit's vector path
    // methods, no chart library or image-conversion step needed. ----
    const attempts = history?.attempts || [];
    if (attempts.length >= 2) {
      drawSectionHeader("Score Trend");
      const chartH = 90;
      ensureSpace(chartH + 20);
      const chartTop = doc.y;
      const chartLeft = doc.page.margins.left + 4;
      const chartWidth = contentWidth - 8;

      doc.rect(chartLeft, chartTop, chartWidth, chartH).lineWidth(0.75).stroke(LIGHT_BORDER);
      // Gridlines at 0/25/50/75/100%
      [0, 25, 50, 75, 100].forEach((pct) => {
        const gy = chartTop + chartH - (pct / 100) * chartH;
        doc.moveTo(chartLeft, gy).lineTo(chartLeft + chartWidth, gy).lineWidth(0.4).stroke("#eef1f4");
        doc.font("Helvetica").fontSize(6).fillColor(MUTED_COLOR).text(`${pct}`, chartLeft - 16, gy - 3, { width: 14, align: "right" });
      });

      const points = attempts.map((a, i) => {
        const x = chartLeft + (attempts.length === 1 ? chartWidth / 2 : (i / (attempts.length - 1)) * chartWidth);
        const y = chartTop + chartH - (Math.max(0, Math.min(100, a.percentage || 0)) / 100) * chartH;
        return { x, y };
      });
      doc.moveTo(points[0].x, points[0].y);
      points.slice(1).forEach((p) => doc.lineTo(p.x, p.y));
      doc.lineWidth(1.5).stroke(BRAND_COLOR);
      points.forEach((p) => {
        doc.circle(p.x, p.y, 2).fill(GOLD_ACCENT);
      });
      doc.fillColor(TEXT_COLOR);
      doc.y = chartTop + chartH + 8;
      doc
        .font("Helvetica")
        .fontSize(7.5)
        .fillColor(MUTED_COLOR)
        .text(
          `${attempts.length} completed attempts, ${formatPdfDate(attempts[0].completedAt)} → ${formatPdfDate(attempts[attempts.length - 1].completedAt)}`,
          doc.page.margins.left,
          doc.y,
          { width: contentWidth }
        );
      doc.moveDown(0.6);
      doc.fillColor(TEXT_COLOR).font("Helvetica");
    }

    // ---- Per-topic comparison table ----
    if ((comparison.perTopic || []).length > 0) {
      drawSectionHeader("Subject / Topic — vs. Category Average");
      const cols = [
        { label: "Subject / Topic", width: contentWidth * 0.4 },
        { label: "My Avg %", width: contentWidth * 0.2 },
        { label: "Category Avg %", width: contentWidth * 0.2 },
        { label: "Rank", width: contentWidth * 0.2 },
      ];
      const rowH = 18;
      ensureSpace(rowH * 2);
      let y = doc.y;
      doc.rect(doc.page.margins.left, y, contentWidth, rowH).fill(BRAND_COLOR);
      let x = doc.page.margins.left;
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8);
      cols.forEach((c) => {
        doc.text(c.label, x + 4, y + 5, { width: c.width - 8 });
        x += c.width;
      });
      y += rowH;
      doc.font("Helvetica").fontSize(8);
      comparison.perTopic.forEach((t, i) => {
        ensureSpace(rowH);
        if (doc.y !== y) y = doc.y; // a page break happened; resync
        if (i % 2 === 1) doc.rect(doc.page.margins.left, y, contentWidth, rowH).fill("#f5f6f8");
        doc.fillColor(TEXT_COLOR);
        x = doc.page.margins.left;
        const values = [`${t.subjectName} — ${t.subTopicName}`, `${t.myAvgPercentage}%`, `${t.categoryAvgPercentage}%`, `#${t.rank}/${t.totalStudents}`];
        cols.forEach((c, ci) => {
          doc.text(values[ci], x + 4, y + 5, { width: c.width - 8 });
          x += c.width;
        });
        y += rowH;
        doc.y = y;
      });
      doc.moveDown(0.8);
    }

    // ---- Per-exam comparison table ----
    if ((comparison.perExam || []).length > 0) {
      drawSectionHeader("Per-Test Comparison");
      const cols = [
        { label: "Test", width: contentWidth * 0.4 },
        { label: "My Score", width: contentWidth * 0.2 },
        { label: "Category Avg", width: contentWidth * 0.2 },
        { label: "Rank", width: contentWidth * 0.2 },
      ];
      const rowH = 18;
      ensureSpace(rowH * 2);
      let y = doc.y;
      doc.rect(doc.page.margins.left, y, contentWidth, rowH).fill(BRAND_COLOR);
      let x = doc.page.margins.left;
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8);
      cols.forEach((c) => {
        doc.text(c.label, x + 4, y + 5, { width: c.width - 8 });
        x += c.width;
      });
      y += rowH;
      doc.font("Helvetica").fontSize(8);
      comparison.perExam.forEach((e, i) => {
        ensureSpace(rowH);
        if (doc.y !== y) y = doc.y;
        if (i % 2 === 1) doc.rect(doc.page.margins.left, y, contentWidth, rowH).fill("#f5f6f8");
        doc.fillColor(TEXT_COLOR);
        x = doc.page.margins.left;
        const values = [`${e.subjectName} — ${e.subTopicName}`, `${e.myPercentage}%`, `${e.categoryAvgPercentage}%`, `#${e.rank}/${e.totalParticipants}`];
        cols.forEach((c, ci) => {
          doc.text(values[ci], x + 4, y + 5, { width: c.width - 8 });
          x += c.width;
        });
        y += rowH;
        doc.y = y;
      });
    }

    doc.end();
  } catch (error) {
    // The response may already have started streaming a PDF by the time an
    // error hits (e.g. a failure partway through the table rows) — only
    // send a JSON error if nothing has been written yet, same discipline
    // as the profile PDF export.
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: "Failed to generate performance report PDF.",
        error: error.message,
      });
    } else {
      res.end();
    }
  }
};

module.exports = {
  getMyPerformanceAnalytics,
  getStudentPerformanceAnalytics,
  getMyCategoryLeaderboards,
  getMyAttemptHistory,
  getCategoryRollup,
  generatePerformanceReportPdf,
};
