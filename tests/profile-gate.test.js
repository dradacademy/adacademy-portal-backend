const request = require("supertest");
const mongoose = require("mongoose");

// Mock rate limiting BEFORE requiring app — same pattern as rbac_audit.test.js.
jest.mock("express-rate-limit", () => {
  return jest.fn(() => (req, res, next) => next());
});

const app = require("../index");
const userModel = require("../models/userModel");
const studentProfileModel = require("../models/studentProfileModel");

// Covers Feature 2 — Mandatory Profile Completion. A student who hasn't
// submitted their StudentProfile (both declaration signatures) must be
// blocked, with a distinguishable 403 { code: "PROFILE_INCOMPLETE" }, from
// every content-access endpoint requireCompletedProfile.js was wired into
// (videos, live classes, attachments, exam listing/attend) — see
// middlewares/requireCompletedProfile.js and the routes that use it.
describe("Mandatory Profile Completion gate", () => {
  jest.setTimeout(40000);

  let studentToken, adminToken, studentUserId;

  const GUARDED_ROUTES = [
    { method: "get", path: "/api/videos/available" },
    { method: "get", path: "/api/live-classes/current" },
    { method: "get", path: "/api/attachments/available" },
  ];

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_URL || "mongodb://localhost:27017/exam_portal_test");
    }
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await userModel.deleteMany({ email: { $regex: /profilegate_test_/ } });
    await studentProfileModel.deleteMany({});

    const bcrypt = require("bcrypt");
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash("password123", salt);
    await userModel.create({
      username: "profilegate_admin",
      email: "profilegate_test_admin@test.com",
      password: hashedPassword,
      role: "admin",
    });
    const adminLogin = await request(app)
      .post("/api/users/login")
      .send({ email: "profilegate_test_admin@test.com", password: "password123" });
    adminToken = adminLogin.body.token;

    const studentPayload = {
      username: "profilegate_stud",
      email: "profilegate_test_stud@test.com",
      password: "password123",
      role: "student",
      registerNumber: "PG001",
      category: "gate",
    };
    const regRes = await request(app).post("/api/users/register").send(studentPayload);
    studentUserId = regRes.body.user._id;
    const loginRes = await request(app).post("/api/users/login").send({
      email: studentPayload.email,
      password: studentPayload.password,
      registerNumber: studentPayload.registerNumber,
    });
    studentToken = loginRes.body.token;
  });

  it("a fresh student (no profile doc at all) is blocked with PROFILE_INCOMPLETE on every guarded route", async () => {
    for (const route of GUARDED_ROUTES) {
      const res = await request(app)[route.method](route.path).set(
        "Authorization",
        `Bearer ${studentToken}`
      );
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("PROFILE_INCOMPLETE");
    }
  });

  it("eligible-exam listing is also blocked for an incomplete profile", async () => {
    const res = await request(app)
      .get(`/api/exam-function/eligible-exam/${studentUserId}`)
      .set("Authorization", `Bearer ${studentToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PROFILE_INCOMPLETE");
  });

  it("a student with a draft (unsubmitted) profile is still blocked", async () => {
    await studentProfileModel.create({
      userId: studentUserId,
      fullName: "Draft Student",
      status: "draft",
    });

    const res = await request(app)
      .get("/api/videos/available")
      .set("Authorization", `Bearer ${studentToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PROFILE_INCOMPLETE");
  });

  it("a student with a submitted profile passes through to every guarded route", async () => {
    await studentProfileModel.create({
      userId: studentUserId,
      fullName: "Submitted Student",
      studentAgreed: true,
      studentSignatureName: "Submitted Student",
      studentSignedAt: new Date(),
      parentAgreed: true,
      parentSignatureName: "Parent Name",
      parentSignedAt: new Date(),
      status: "submitted",
    });

    for (const route of GUARDED_ROUTES) {
      const res = await request(app)[route.method](route.path).set(
        "Authorization",
        `Bearer ${studentToken}`
      );
      expect(res.status).not.toBe(403);
    }

    const examRes = await request(app)
      .get(`/api/exam-function/eligible-exam/${studentUserId}`)
      .set("Authorization", `Bearer ${studentToken}`);
    expect(examRes.status).not.toBe(403);
  });

  it("an admin token is never blocked, even with no StudentProfile doc", async () => {
    const res = await request(app)
      .get("/api/videos/available")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).not.toBe(403);
  });

  it("POST /users/login and GET /users/me both report profileCompleted correctly", async () => {
    const meBefore = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${studentToken}`);
    expect(meBefore.body.profileCompleted).toBe(false);

    await studentProfileModel.create({
      userId: studentUserId,
      fullName: "Submitted Student",
      studentAgreed: true,
      studentSignatureName: "Submitted Student",
      studentSignedAt: new Date(),
      parentAgreed: true,
      parentSignatureName: "Parent Name",
      parentSignedAt: new Date(),
      status: "submitted",
    });

    const meAfter = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${studentToken}`);
    expect(meAfter.body.profileCompleted).toBe(true);

    const loginRes = await request(app).post("/api/users/login").send({
      email: "profilegate_test_stud@test.com",
      password: "password123",
      registerNumber: "PG001",
    });
    expect(loginRes.body.user.profileCompleted).toBe(true);
  });
});
