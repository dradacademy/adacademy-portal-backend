// How long a class (recorded, or a live class's replay) stays watchable for
// STUDENTS. Single source of truth for this rule — used by the recorded-class
// model, the student list/playback endpoints, the progress dashboard and the
// live-class -> recording hand-off, so every place agrees on the same date.
//
// A class is in one of three modes, chosen by the admin:
//   "days"  — visible for N days counted from the CLASS DATE (recordedDate,
//             or a live class's start time). Stored as visibilityWindowDays.
//   "date"  — visible until a chosen calendar date. Stored as availableUntil.
//   "never" — never expires (visibilityWindowDays = null, no availableUntil).
// If availableUntil is set it always wins over visibilityWindowDays.
//
// All dates are Indian Standard Time: a class stays open until 11:59 PM IST
// on its last day, whichever mode was used.

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MAX_DAYS = 3650;

// 11:59:59.999 PM IST on the IST calendar day that contains `value`.
const endOfIstDay = (value) => {
  const shifted = new Date(new Date(value).getTime() + IST_OFFSET_MS);
  shifted.setUTCHours(23, 59, 59, 999);
  return new Date(shifted.getTime() - IST_OFFSET_MS);
};

// "2026-10-29" -> 29 Oct 2026, 11:59:59.999 PM IST. null if malformed.
const endOfIstDayFromYmd = (ymd) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || "").trim());
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const utc = Date.UTC(y, m - 1, d, 23, 59, 59, 999);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return new Date(utc - IST_OFFSET_MS);
};

// The moment this class stops being visible to students, or null for
// "never expires". `classDate` defaults to the doc's recordedDate; pass a
// live class's startedAt when working with a LiveClass document.
const getAvailableUntil = (doc, classDate) => {
  if (!doc) return null;
  if (doc.availableUntil) return new Date(doc.availableUntil);
  const days = doc.visibilityWindowDays;
  if (days === null || days === undefined) return null;
  const base = classDate || doc.recordedDate || doc.startedAt || doc.createdAt || Date.now();
  return endOfIstDay(new Date(base).getTime() + Number(days) * DAY_MS);
};

const getAvailabilityMode = (doc) => {
  if (doc?.availableUntil) return "date";
  if (doc?.visibilityWindowDays === null || doc?.visibilityWindowDays === undefined) {
    return "never";
  }
  return "days";
};

// Recorded-class visibility for students right now: active AND not expired.
const isAvailableToStudents = (doc, now = Date.now()) => {
  if (!doc || !doc.active) return false;
  const until = getAvailableUntil(doc);
  return until === null || now <= until.getTime();
};

// Reads the admin's availability choice from a request body. Returns:
//   null                          — nothing about availability was sent
//   { ok: false, message }        — invalid input (send a 400)
//   { ok: true, fields }          — fields to $set on the document
// Accepts the new shape { availabilityMode, availabilityDays,
// availableUntilDate } and, for older cached admin pages, the legacy
// { visibilityWindowDays } (number, or null for never).
const parseAvailabilityInput = (body = {}) => {
  const mode = body.availabilityMode;

  if (mode === undefined || mode === null || mode === "") {
    if (body.visibilityWindowDays === undefined) return null;
    if (body.visibilityWindowDays === null) {
      return { ok: true, fields: { visibilityWindowDays: null, availableUntil: null } };
    }
    const legacyDays = Math.round(Number(body.visibilityWindowDays));
    if (!Number.isFinite(legacyDays) || legacyDays < 0 || legacyDays > MAX_DAYS) {
      return { ok: false, message: `Number of days must be between 0 and ${MAX_DAYS}.` };
    }
    return { ok: true, fields: { visibilityWindowDays: legacyDays, availableUntil: null } };
  }

  if (mode === "days") {
    const raw = body.availabilityDays;
    const days = Math.round(Number(raw));
    if (raw === "" || raw === null || raw === undefined || !Number.isFinite(days) || days < 0 || days > MAX_DAYS) {
      return { ok: false, message: `Enter the number of days (0 to ${MAX_DAYS}).` };
    }
    return { ok: true, fields: { visibilityWindowDays: days, availableUntil: null } };
  }

  if (mode === "date") {
    const until = endOfIstDayFromYmd(body.availableUntilDate);
    if (!until) {
      return { ok: false, message: "Pick a valid 'available until' date." };
    }
    if (until.getTime() < Date.now()) {
      return { ok: false, message: "The 'available until' date can't be in the past." };
    }
    return { ok: true, fields: { availableUntil: until } };
  }

  if (mode === "never") {
    return { ok: true, fields: { visibilityWindowDays: null, availableUntil: null } };
  }

  return { ok: false, message: "Unknown availability option." };
};

// Plain-object view of a document with its computed availability attached,
// for API responses. Works for both RecordedClass and LiveClass docs.
const withAvailability = (doc, classDate) => {
  const obj = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  const until = getAvailableUntil(obj, classDate);
  return {
    ...obj,
    availabilityMode: getAvailabilityMode(obj),
    effectiveAvailableUntil: until,
    isExpired: until !== null && Date.now() > until.getTime(),
  };
};

module.exports = {
  DAY_MS,
  MAX_DAYS,
  endOfIstDay,
  endOfIstDayFromYmd,
  getAvailableUntil,
  getAvailabilityMode,
  isAvailableToStudents,
  parseAvailabilityInput,
  withAvailability,
};
