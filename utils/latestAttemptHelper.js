/**
 * Single source of truth for the "last attempt only" rule.
 *
 * A student can attempt an exam multiple times (attemptNumber 1, 2, 3, ...).
 * Per the admin's explicit requirement, only a student's most recent
 * COMPLETED attempt on a given exam should ever count — for their displayed
 * marks/pass-fail status, average score, pass rate, completed/qualified/
 * not-qualified counts, and rankings (by marks and by completion time) — in
 * both the student and admin views. Every place in the app that aggregates
 * across ExamSubmission documents for stats/rankings/counts must first
 * reduce the submission pool down to one row per (userId, examId) pair,
 * keeping only the highest attemptNumber. This file is that reduction,
 * both as a plain-JS array helper (for code that already has an array of
 * submission docs/plain objects) and as a reusable Mongoose aggregation
 * pipeline stage array (for code building its own .aggregate() pipeline).
 *
 * Deliberately NOT used for attempt-HISTORY views (Test Index / Test
 * Tracking's expandable attempt rows, the attempt-trend/speed-vs-accuracy
 * charts) — those intentionally show every attempt; this helper is only for
 * places that compute a single number/rank/count per student per exam.
 */

/**
 * Reduce an array of ExamSubmission documents (or plain objects with the
 * same shape) down to one entry per (userId, examId) pair — the one with
 * the highest attemptNumber. Ties (which shouldn't happen given the
 * schema's unique {userId, examId, attemptNumber} index, but handled
 * defensively) are broken by the later completedAt/createdAt.
 *
 * Works whether userId/examId are ObjectIds, populated documents (with an
 * _id), or already-stringified values.
 *
 * @param {Array} submissions
 * @returns {Array} one submission per (userId, examId), latest attempt only
 */
function getLatestAttemptsOnly(submissions) {
  if (!Array.isArray(submissions) || submissions.length === 0) return [];

  const keyOf = (val) => {
    if (val === null || val === undefined) return "null";
    if (typeof val === "object") {
      if (val._id) return String(val._id);
      if (val.toString) return val.toString();
    }
    return String(val);
  };

  const latestMap = new Map();

  for (const sub of submissions) {
    const key = `${keyOf(sub.userId)}_${keyOf(sub.examId)}`;
    const existing = latestMap.get(key);

    if (!existing) {
      latestMap.set(key, sub);
      continue;
    }

    const subAttempt = sub.attemptNumber ?? -Infinity;
    const existingAttempt = existing.attemptNumber ?? -Infinity;

    if (subAttempt > existingAttempt) {
      latestMap.set(key, sub);
    } else if (subAttempt === existingAttempt) {
      const subTime = new Date(sub.completedAt || sub.createdAt || 0).getTime();
      const existingTime = new Date(existing.completedAt || existing.createdAt || 0).getTime();
      if (subTime > existingTime) {
        latestMap.set(key, sub);
      }
    }
  }

  return Array.from(latestMap.values());
}

/**
 * Aggregation pipeline stages that reduce whatever documents reach this
 * point in the pipeline down to one per (userId, examId) — the highest
 * attemptNumber, keeping the full original document shape (via $first on
 * $$ROOT + $replaceRoot, not a re-projection, so every existing field in
 * the pipeline downstream keeps working unchanged).
 *
 * Insert these stages immediately after whatever $match already narrows
 * the pipeline to `status: "completed"` (and any category/exam/date
 * filters), and before any $group/$sort/$facet that computes stats,
 * counts, or ranks from the result.
 *
 * @returns {Array} Mongoose aggregation pipeline stages
 */
function latestAttemptOnlyStages() {
  return [
    { $sort: { userId: 1, examId: 1, attemptNumber: -1 } },
    {
      $group: {
        _id: { userId: "$userId", examId: "$examId" },
        doc: { $first: "$$ROOT" },
      },
    },
    { $replaceRoot: { newRoot: "$doc" } },
  ];
}

module.exports = { getLatestAttemptsOnly, latestAttemptOnlyStages };
