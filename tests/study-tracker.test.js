const { buildStudentProgress, submissionPercent, statusFor } = require("../utils/studyTracker");

describe("study tracker progress maths", () => {
  const e = (unit, material, percent, day, subject = "GS") => ({ subject, unit, material, percent, day });

  test("unit counts as finished only when every material is 100%", () => {
    const entries = [
      e("Polity", "Old notes", 1, "2026-10-24"),
      e("Polity", "New notes MCQ", 1, "2026-10-24"),
      e("Polity", "Presentation MCQ", 1, "2026-10-25"),
    ];
    const p = buildStudentProgress({ entries, planDates: { Polity: "2026-10-24" }, today: "2026-10-28" });
    const polity = p.subjects.GS.units.find((u) => u.unit === "Polity");
    expect(polity.percent).toBe(0.75);
    expect(polity.status).toBe("overdue");
    expect(polity.days).toBe(4);
    expect(p.items.find((i) => i.unit === "Polity").missing).toEqual(["New notes"]);
  });

  test("finished after the target is late; on/before is on time", () => {
    const mats = ["Old notes", "New notes", "New notes MCQ", "Presentation MCQ"];
    const late = buildStudentProgress({ entries: mats.map((m) => e("INM", m, 1, "2026-10-27")), planDates: { INM: "2026-10-26" }, today: "2026-10-28" });
    expect(late.subjects.GS.units.find((u) => u.unit === "INM")).toMatchObject({ status: "done_late", days: 1 });
    const onTime = buildStudentProgress({ entries: mats.map((m) => e("INM", m, 1, "2026-10-26")), planDates: { INM: "2026-10-26" }, today: "2026-10-28" });
    expect(onTime.subjects.GS.units.find((u) => u.unit === "INM").status).toBe("done_on_time");
  });

  test("highest report wins and future-dated rows are ignored", () => {
    const entries = [e("Geography", "Old notes", 0.75, "2026-10-26"), e("Geography", "Old notes", 0.5, "2026-10-27"), e("Geography", "New notes", 1, "2026-10-30")];
    const p = buildStudentProgress({ entries, today: "2026-10-28" });
    expect(p.subjects.GS.units.find((u) => u.unit === "Geography").percent).toBeCloseTo(0.1875);
  });

  test("due soon within 2 days", () => {
    expect(statusFor({ percent: 0.5 }, "2026-10-30", "2026-10-28")).toEqual({ status: "due_soon", days: 2 });
    expect(statusFor({ percent: 0.5 }, "2026-10-31", "2026-10-28")).toEqual({ status: "in_progress", days: 0 });
  });

  test("test % uses only the questions served", () => {
    const marks = new Map([["a", 1], ["b", 1], ["c", 2]]);
    expect(submissionPercent({ obtainedMark: 3, examData: [{ questionId: "a" }, { questionId: "c" }] }, marks)).toBe(100);
    expect(submissionPercent({ obtainedMark: 0, examData: [] }, marks)).toBeNull();
  });

  test("controller and route load", () => {
    expect(() => require("../routes/studyTrackerRoute")).not.toThrow();
  });
});
