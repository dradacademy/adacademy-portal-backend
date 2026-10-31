// Daily Study Tracker — pure progress maths (no database), so the student
// page, the admin summary and the tests all agree. See
// constants/studyTracker.js for the study list.
//
// Rules:
//   material %  = highest accepted report for that material (up to `today`)
//   unit %      = average of the unit's material %s
//   subject %   = average of its unit %s
//   unit finished date = the day the LAST material reached 100%
//   status vs the admin's target date:
//     done_on_time | done_late | overdue | due_soon (≤ 2 days) |
//     in_progress | not_started | (no target → done / in_progress / not_started)

const { MATERIALS, SUBJECTS, SUBJECT_LEVEL_DATES, planKeyFor, unitsFor } = require("../constants/studyTracker");

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istYmd = (value = Date.now()) =>
  new Date(new Date(value).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const istHm = (value = Date.now()) =>
  new Date(new Date(value).getTime() + IST_OFFSET_MS).toISOString().slice(11, 16);
const daysBetween = (fromYmd, toYmd) =>
  Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86400000);

// entries: [{ subject, unit, material, percent, day }] for ONE student.
const indexEntries = (entries, today) => {
  const best = new Map(); // "s|u|m" -> { percent, fullDay }
  for (const e of entries) {
    if (today && e.day > today) continue;
    const k = `${e.subject}|${e.unit}|${e.material}`;
    const cur = best.get(k) || { percent: 0, fullDay: null };
    if (e.percent > cur.percent) cur.percent = e.percent;
    if (e.percent >= 1 && (!cur.fullDay || e.day < cur.fullDay)) cur.fullDay = e.day;
    best.set(k, cur);
  }
  return best;
};

const unitProgress = (idx, subject, unit) => {
  const mats = MATERIALS[subject].map((m) => {
    const b = idx.get(`${subject}|${unit}|${m}`) || { percent: 0, fullDay: null };
    return { material: m, percent: Math.min(1, b.percent), fullDay: b.fullDay };
  });
  const percent = mats.reduce((a, m) => a + m.percent, 0) / mats.length;
  const finishedDay =
    percent >= 1 ? mats.map((m) => m.fullDay).filter(Boolean).sort().pop() || null : null;
  return { unit, percent, finishedDay, materials: mats };
};

const statusFor = ({ percent, finishedDay }, target, today) => {
  if (percent >= 1) {
    if (!target) return { status: "done", days: 0 };
    const late = daysBetween(target, finishedDay || today);
    return late <= 0 ? { status: "done_on_time", days: 0 } : { status: "done_late", days: late };
  }
  if (target) {
    const left = daysBetween(today, target);
    if (left < 0) return { status: "overdue", days: -left };
    if (left <= 2) return { status: "due_soon", days: left };
  }
  return { status: percent > 0 ? "in_progress" : "not_started", days: 0 };
};

// Full picture for one student.
//   planDates: { planKey: "YYYY-MM-DD" }
const buildStudentProgress = ({ entries, planDates = {}, today = istYmd(), civilTrack = "jdo" }) => {
  const idx = indexEntries(entries, today);
  const UNITS = unitsFor(civilTrack);
  const subjects = {};
  for (const subject of SUBJECTS) {
    const units = UNITS[subject].map((unit) => {
      const p = unitProgress(idx, subject, unit);
      const target = SUBJECT_LEVEL_DATES.includes(subject) ? null : planDates[planKeyFor(subject, unit)] || null;
      return { ...p, target, ...statusFor(p, target, today) };
    });
    const percent = units.reduce((a, u) => a + u.percent, 0) / units.length;
    const finishedDay =
      percent >= 1 ? units.map((u) => u.finishedDay).filter(Boolean).sort().pop() || null : null;
    const subjectTarget = SUBJECT_LEVEL_DATES.includes(subject) ? planDates[subject] || null : null;
    subjects[subject] = {
      percent,
      target: subjectTarget,
      ...(subjectTarget ? statusFor({ percent, finishedDay }, subjectTarget, today) : {}),
      units,
    };
  }
  // Every planned item, flattened (what the admin reads first).
  const items = [];
  for (const subject of SUBJECTS) {
    const s = subjects[subject];
    if (SUBJECT_LEVEL_DATES.includes(subject)) {
      if (s.target) items.push({ subject, unit: subject === "Language" ? "Tamil (all units)" : "Aptitude (all topics)", percent: s.percent, target: s.target, status: s.status, days: s.days, missing: [] });
    } else {
      for (const u of s.units) {
        if (!u.target) continue;
        items.push({
          subject,
          unit: u.unit,
          percent: u.percent,
          target: u.target,
          status: u.status,
          days: u.days,
          missing: u.percent > 0 && u.percent < 1 ? u.materials.filter((m) => m.percent < 1).map((m) => m.material) : [],
        });
      }
    }
  }
  const count = (st) => items.filter((i) => i.status === st).length;
  return {
    today,
    civilTrack,
    subjects,
    items,
    counts: {
      overdue: count("overdue"),
      dueSoon: count("due_soon"),
      onTime: count("done_on_time"),
      late: count("done_late"),
    },
  };
};

// Test % on the questions the student was actually given (an exam may hold
// 100 questions but serve only 50 — dividing by all 100 would halve the score).
const submissionPercent = (submission, questionMarks) => {
  const total = (submission.examData || []).reduce(
    (a, q) => a + (questionMarks.get(String(q.questionId)) || 0),
    0
  );
  if (!total) return null;
  return Math.max(0, Math.min(100, (submission.obtainedMark / total) * 100));
};

module.exports = {
  istYmd,
  istHm,
  daysBetween,
  indexEntries,
  unitProgress,
  statusFor,
  buildStudentProgress,
  submissionPercent,
};
