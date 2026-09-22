const request = require("supertest");
const mongoose = require("mongoose");

jest.mock("express-rate-limit", () => {
  return jest.fn(() => (req, res, next) => next());
});

const app = require("../index");
const userModel = require("../models/userModel");
const studentProfileModel = require("../models/studentProfileModel");

// Covers Feature 1 — Student Profile PDF Export. Admin-only, generated live
// from whatever's in the database right now (no separate export data path).
describe("Student profile PDF export", () => {
  jest.setTimeout(40000);

  let adminToken, studentToken, studentUserId;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_URL || "mongodb://localhost:27017/exam_portal_test");
    }
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await userModel.deleteMany({ email: { $regex: /profilepdf_test_/ } });
    await studentProfileModel.deleteMany({});

    const bcrypt = require("bcrypt");
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash("password123", salt);
    await userModel.create({
      username: "profilepdf_admin",
      email: "profilepdf_test_admin@test.com",
      password: hashedPassword,
      role: "admin",
    });
    const adminLogin = await request(app)
      .post("/api/users/login")
      .send({ email: "profilepdf_test_admin@test.com", password: "password123" });
    adminToken = adminLogin.body.token;

    const studentPayload = {
      username: "profilepdf_stud",
      email: "profilepdf_test_stud@test.com",
      password: "password123",
      role: "student",
      registerNumber: "PDF001",
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

  it("admin gets a real PDF for a student with no profile doc yet (not a 500)", async () => {
    const res = await request(app)
      .get(`/api/student-profiles/${studentUserId}/pdf`)
      .set("Authorization", `Bearer ${adminToken}`)
      .buffer(true)
      .parse((response, callback) => {
        response.setEncoding("binary");
        let data = "";
        response.on("data", (chunk) => (data += chunk));
        response.on("end", () => callback(null, Buffer.from(data, "binary")));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.body.length).toBeGreaterThan(0);
    // A real PDF always starts with this magic header.
    expect(res.body.slice(0, 5).toString()).toBe("%PDF-");
  });

  it("admin gets a real PDF for a student with a submitted profile", async () => {
    await studentProfileModel.create({
      userId: studentUserId,
      fullName: "PDF Test Student",
      rollNumber: "R-001",
      studentAgreed: true,
      studentSignatureName: "PDF Test Student",
      studentSignedAt: new Date(),
      parentAgreed: true,
      parentSignatureName: "Parent Name",
      parentSignedAt: new Date(),
      status: "submitted",
      academicRecords: [
        { level: "B.E. / B.Tech / Degree", institutionName: "Test College", year: "2026", percentageOrCgpa: "8.5" },
      ],
    });

    const res = await request(app)
      .get(`/api/student-profiles/${studentUserId}/pdf`)
      .set("Authorization", `Bearer ${adminToken}`)
      .buffer(true)
      .parse((response, callback) => {
        response.setEncoding("binary");
        let data = "";
        response.on("data", (chunk) => (data += chunk));
        response.on("end", () => callback(null, Buffer.from(data, "binary")));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.body.slice(0, 5).toString()).toBe("%PDF-");
  });

  it("a student token is forbidden", async () => {
    const res = await request(app)
      .get(`/api/student-profiles/${studentUserId}/pdf`)
      .set("Authorization", `Bearer ${studentToken}`);
    expect(res.status).toBe(403);
  });

  it("an unknown userId is a 404", async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .get(`/api/student-profiles/${fakeId}/pdf`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});
