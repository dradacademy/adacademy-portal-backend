const mongoose = require("mongoose");
const subjectModel = require("../models/subjectModel");

// Recorded classes are grouped as Subject → Subtopic (→ listed by date).
// Subjects and their subtopics are the same ones managed on the admin
// Subjects page (used for exams too), so there is one list to maintain.

const isId = (value) => mongoose.Types.ObjectId.isValid(String(value || ""));

// Validate a { subject, subtopic } choice for a recording in `category` and
// turn it into the fields to save. Empty subject = "not grouped" (clears
// both). Empty subtopic = grouped under the subject only.
//   → { ok: true, fields: { subject, subtopic, subtopicName } }
//   → { ok: false, message }
const resolveGrouping = async ({ category, subject, subtopic }) => {
  if (!subject) {
    return { ok: true, fields: { subject: null, subtopic: null, subtopicName: "" } };
  }
  if (!isId(subject)) return { ok: false, message: "Unknown subject." };

  const subjectDoc = await subjectModel.findById(subject).select("name category subtopics");
  if (!subjectDoc) return { ok: false, message: "That subject no longer exists." };
  if (category && subjectDoc.category !== category) {
    return {
      ok: false,
      message: `"${subjectDoc.name}" belongs to a different exam category than this recording.`,
    };
  }

  if (!subtopic) {
    return { ok: true, fields: { subject: subjectDoc._id, subtopic: null, subtopicName: "" } };
  }
  const subtopicDoc = isId(subtopic) ? subjectDoc.subtopics.id(subtopic) : null;
  if (!subtopicDoc) {
    return { ok: false, message: `That subtopic isn't part of "${subjectDoc.name}".` };
  }
  return {
    ok: true,
    fields: {
      subject: subjectDoc._id,
      subtopic: subtopicDoc._id,
      subtopicName: subtopicDoc.name,
    },
  };
};

// subjectId → { _id, name, subtopics: Map(subtopicId → name) } for the
// subjects referenced by these recordings, in one query.
const loadSubjectLookup = async (recordings) => {
  const ids = [
    ...new Set(
      recordings
        .map((rec) => (rec.subject && rec.subject._id ? rec.subject._id : rec.subject))
        .filter(Boolean)
        .map(String)
    ),
  ];
  if (ids.length === 0) return new Map();
  const subjects = await subjectModel.find({ _id: { $in: ids } }).select("name subtopics");
  return new Map(
    subjects.map((s) => [
      String(s._id),
      {
        _id: s._id,
        name: s.name,
        subtopics: new Map(s.subtopics.map((t) => [String(t._id), t.name])),
      },
    ])
  );
};

// The grouping labels to send to the browser for one recording, using the
// subject/subtopic's CURRENT names (renames carry over automatically).
const describeGrouping = (rec, lookup) => {
  const subjectId = rec.subject && rec.subject._id ? rec.subject._id : rec.subject;
  const subject = subjectId ? lookup.get(String(subjectId)) : null;
  const subtopicId = subject && rec.subtopic ? String(rec.subtopic) : null;
  const subtopicName = subtopicId
    ? subject.subtopics.get(subtopicId) || rec.subtopicName || null
    : null;
  return {
    subject: subject ? { _id: subject._id, name: subject.name } : null,
    subtopic: subtopicId && subtopicName ? { _id: rec.subtopic, name: subtopicName } : null,
  };
};

module.exports = { resolveGrouping, loadSubjectLookup, describeGrouping };
