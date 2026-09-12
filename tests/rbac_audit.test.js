const request = require("supertest");
const mongoose = require("mongoose");

// Mock rate limiting BEFORE requiring app
jest.mock("express-rate-limit", () => {
    return jest.fn(() => (req, res, next) => next());
});

const app = require("../index");
const userModel = require("../models/userModel");
const examModel = require("../models/examModel");
const examSubmissionSchema = require("../models/examSubmissionSchema");

describe("RBAC Security Audit", () => {
    // Increase timeout
    jest.setTimeout(40000);

    let adminToken, evaluatorToken, studentToken1, studentToken2;
    let adminUser, evaluatorUser, studentUser1, studentUser2;

    beforeAll(async () => {
        if (mongoose.connection.readyState === 0) {
           await mongoose.connect(process.env.MONGO_URL || "mongodb://localhost:27017/exam_portal_test");
        }
    });

    afterAll(async () => {
        await mongoose.connection.close();
    });

    beforeEach(async () => {
        // Cleanup
        await userModel.deleteMany({ email: { $regex: /rbac_test_/ } });
        await examSubmissionSchema.deleteMany({});
        
        // 1. Create Users
        const createAndLogin = async (user) => {
            const regRes = await request(app).post("/api/users/register").send(user);
            if (regRes.status !== 201) {
                console.error("Registration Failed for:", user.username, regRes.body);
            }
            const res = await request(app).post("/api/users/login").send({
                email: user.email,
                password: user.password,
                registerNumber: user.registerNumber
            });
            if (res.status !== 200) {
                 console.error("Login Failed for:", user.username, res.body);
            }
            return { token: res.body.token, id: res.body.user ? res.body.user._id : null };
        };

        const adminPayload = { username: "rbac_admin", email: "rbac_test_admin@test.com", password: "password123", role: "admin" };
        
        // Manual Admin Creation to bypass restriction
        const salt = await require("bcrypt").genSalt(10);
        const hashedPassword = await require("bcrypt").hash("password123", salt);
        
        await userModel.create({ ...adminPayload, password: hashedPassword });
        const adminLogin = await request(app).post("/api/users/login").send({ email: adminPayload.email, password: "password123" });
        adminToken = adminLogin.body.token;

        const evalPayload = { username: "rbac_eval", email: "rbac_test_eval@test.com", password: "password123", role: "evaluator" };
        const evalData = await createAndLogin(evalPayload);
        evaluatorToken = evalData.token;
        evaluatorUser = evalData.id;

        const stud1Payload = { username: "rbac_stud1", email: "rbac_test_stud1@test.com", password: "password123", role: "student", registerNumber: "RBAC001" };
        const stud1Data = await createAndLogin(stud1Payload);
        studentToken1 = stud1Data.token;
        studentUser1 = stud1Data.id;

        const stud2Payload = { username: "rbac_stud2", email: "rbac_test_stud2@test.com", password: "password123", role: "student", registerNumber: "RBAC002" };
        const stud2Data = await createAndLogin(stud2Payload);
        studentToken2 = stud2Data.token;
        studentUser2 = stud2Data.id;
    });

    describe("1. Admin Endpoint Protection", () => {
        it("Student cannot access 'Get All Users' (Admin Only)", async () => {
            const res = await request(app).get("/api/users/getall").set("Authorization", `Bearer ${studentToken1}`);
            expect(res.status).toBe(403);
        });

        it("Evaluator cannot access 'Get All Users' (Admin Only)", async () => {
            // Evaluator shouldn't access getall users? Route said 'admin'.
            const res = await request(app).get("/api/users/getall").set("Authorization", `Bearer ${evaluatorToken}`);
            expect(res.status).toBe(403);
        });

        it("Student cannot create Exam", async () => {
             const res = await request(app).post("/api/exams/create").set("Authorization", `Bearer ${studentToken1}`).send({});
             expect(res.status).toBe(403);
        });
    });

    describe("2. Evaluator Endpoint Protection", () => {
        it("Student cannot access 'Get All Completed Submissions' (Evaluator+)", async () => {
            const res = await request(app).get("/api/exam-submission/completed/get").set("Authorization", `Bearer ${studentToken1}`);
            expect(res.status).toBe(403);
        });
    });

    describe("3. Data Leakage (IDOR Checks)", () => {
        it("Student 1 CANNOT see Student 2's submission history", async () => {
            // Student 1 tries to call /completed/:userId using Student 2's ID
            const res = await request(app).get(`/api/exam-submission/completed/${studentUser2}`)
                .set("Authorization", `Bearer ${studentToken1}`);
            
            // Should be 403 Forbidden
            expect(res.status).toBe(403); 
        });

        it("Student 1 CAN see their OWN submission history", async () => {
            const res = await request(app).get(`/api/exam-submission/completed/${studentUser1}`)
                .set("Authorization", `Bearer ${studentToken1}`);
            
            expect(res.status).toBe(200);
        });
    });

    describe("4. Potential Functionality Gaps (Subject Access)", () => {
        it("Student cannot fetch Subject List (Route is Admin/Eval only)", async () => {
             const res = await request(app).get("/api/subjects/get").set("Authorization", `Bearer ${studentToken1}`);
             // If this returns 403, it's secure but maybe a UI bug if they need it.
             expect(res.status).toBe(403);
        });
    });
});
