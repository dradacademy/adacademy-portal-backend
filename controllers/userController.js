const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const XLSX = require("xlsx");
const { Readable } = require("stream");
const userModel = require("../models/userModel");
const enrollmentModel = require("../models/enrollmentModel");
const studentProfileModel = require("../models/studentProfileModel");
const { EXAM_CATEGORIES } = require("../constants/examCategories");

// Parses the optional "enrollmentValidTill" column from the bulk user-upload
// sheet into a JS Date, mirroring enrollmentController.js's setEnrollment
// (same {userId, category} enrollment record, just set up in bulk here
// instead of one at a time via the "Manage Enrollment" modal). Returns null
// for a blank/absent cell (meaning "skip — set up enrollment later as
// usual"); throws a plain, human-readable Error for anything present but
// unparseable, so the caller can report it per-row without failing the
// whole upload over one bad date.
const parseEnrollmentValidTill = (value) => {
  if (value === undefined || value === null || value === "") return null;

  // Read with cellDates:true below, so a real Excel date cell already
  // arrives as a JS Date.
  if (value instanceof Date) {
    if (isNaN(value.getTime())) throw new Error("Invalid date");
    return value;
  }

  // A bare number here means the cell wasn't formatted as a date in Excel
  // (e.g. left as General) — treat it as an Excel serial date.
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) throw new Error("Invalid date");
    return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;

    // Builds the date and confirms it round-trips exactly (guards against
    // e.g. "31-02-2027" or "32-13-2027" silently overflowing into some
    // other, wrong date instead of being rejected — Date.UTC doesn't
    // throw on out-of-range components, it normalizes them).
    const buildAndVerify = (y, m, d) => {
      if (m < 1 || m > 12 || d < 1 || d > 31) throw new Error("Invalid date");
      const date = new Date(Date.UTC(y, m - 1, d));
      if (
        isNaN(date.getTime()) ||
        date.getUTCFullYear() !== y ||
        date.getUTCMonth() !== m - 1 ||
        date.getUTCDate() !== d
      ) {
        throw new Error("Invalid date");
      }
      return date;
    };

    // DD-MM-YYYY or DD/MM/YYYY — matches the format the admin already sees
    // in the "Manage Enrollment" modal (e.g. "19-02-2027").
    let match = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (match) {
      const [, d, m, y] = match;
      return buildAndVerify(Number(y), Number(m), Number(d));
    }

    // YYYY-MM-DD (ISO) — same format the admin's date-picker sends.
    match = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
      const [, y, m, d] = match;
      return buildAndVerify(Number(y), Number(m), Number(d));
    }

    throw new Error(
      `Unrecognized date "${trimmed}" — use DD-MM-YYYY (e.g. 19-02-2027) or YYYY-MM-DD`
    );
  }

  throw new Error("Invalid date");
};

const registerUser = async (req, res) => {
  try {
    const { registerNumber, username, email, password, role, category, batch } = req.body;
    if (!username || !email || !password || !role) {
      return res.status(400).json({ error: "All fields are required" });
    }
    if (role !== "student" && role !== "evaluator" && role !== "admin") {
      return res.status(400).json({ error: "Invalid role" });
    }

    // Every student belongs to exactly one exam category (GATE, TNPSC AE,
    // TNPSC JDO, or SSC JE/RRB JE) — this is what keeps students in one
    // category from ever seeing another category's subjects/exams. Admins
    // and evaluators stay unscoped (category is ignored for them, even if
    // sent).
    if (role === "student" && !EXAM_CATEGORIES.includes(category)) {
      return res.status(400).json({
        error: `Please select a valid exam category for the student (one of: ${EXAM_CATEGORIES.join(", ")}).`,
      });
    }

    // Task 5: Secure Admin Creation
    if (role === "admin") {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res
          .status(403)
          .json({ error: "Unauthorized: Admin creation requires admin privileges" });
      }
      const token = authHeader.substring(7);
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.role !== "admin") {
          return res.status(403).json({
            error: "Forbidden: Only existing admins can create new admins",
          });
        }
      } catch (err) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }
    }

    if (role === "student" && !registerNumber) {
      return res
        .status(400)
        .json({ error: "Please enter the register number for student." });
    }

    const existingUser = await userModel.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res
        .status(400)
        .json({ error: "User with this email already exists" });
    }
    if (role === "student") {
      const existingRegisterNumber = await userModel.findOne({
        registerNumber,
      });
      if (existingRegisterNumber) {
        return res
          .status(400)
          .json({ error: "User with this register number already exists" });
      }
    }
    if (password.length < 3) {
      return res
        .status(400)
        .json({ error: "Password must be at least 3 characters long" });
    }
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const user = await userModel.create({
      registerNumber: role === "student" ? registerNumber : undefined,
      username,
      email: email.toLowerCase(),
      password: hashedPassword,
      role,
      category: role === "student" ? category : null,
      batch: role === "student" ? batch || "" : "",
    });
    res.status(201).json({ user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// const loginUser = async (req, res) => {
//   try {
//     const { email, password } = req.body;
//     if (!email || !password) {
//       return res.status(400).json({ error: "All fields are required" });
//     }
//     const user = await userModel.findOne({ email });
//     if (!user) {
//       return res.status(400).json({ error: "Invalid credentials" });
//     }
//     const isPasswordCorrect = await bcrypt.compare(password, user.password);
//     if (!isPasswordCorrect) {
//       return res.status(400).json({ error: "Invalid credentials" });
//     }
//     const token = jwt.sign(
//       { userId: user._id, role: user.role },
//       process.env.JWT_SECRET,
//       { expiresIn: "2d" }
//     );
//     await userModel.findByIdAndUpdate(user._id, { sessionToken: token });
//     res.cookie("token", token, {
//       httpOnly: true,
//       secure: process.env.NODE_ENV === "production",
//       sameSite: "Strict",
//       // maxAge: 1000 * 60 * 60 * 24,
//     });

//     res.status(200).json({ user, token });
//   } catch (error) {
//     res.status(500).json({ error: error.message });
//   }
// };

const loginUser = async (req, res) => {
  try {
    const { registerNumber, email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const user = await userModel.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    if (user.isDisabled) {
      return res.status(403).json({
        error: "This account has been disabled. Please contact the academy.",
      });
    }

    if (user.role === "student") {
      if (user.registerNumber !== registerNumber) {
        return res.status(400).json({ error: "Invalid Register Number" });
      }
    }

    const isPasswordCorrect = await bcrypt.compare(password, user.password);
    if (!isPasswordCorrect) {
      return res.status(400).json({ error: "Invalid credentials" });
    }
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "2d" }
    );

    const now = new Date();
    await userModel.findByIdAndUpdate(user._id, {
      sessionToken: token,
      lastLoginAt: now,
    });

    // Remove password from user object before sending
    const userResponse = { ...user.toObject() };
    delete userResponse.password;
    userResponse.lastLoginAt = now;

    // Students only — tells the frontend whether to force them straight to
    // /profile (see AuthContext.jsx's handleSubmitLoginUser). Computed here
    // (not just on GET /users/me) because the frontend never re-fetches
    // /me right after login — it sets userData directly from this response.
    if (userResponse.role === "student") {
      const profile = await studentProfileModel
        .findOne({ userId: user._id })
        .select("status");
      userResponse.profileCompleted = profile?.status === "submitted";
    }

    res.status(200).json({ user: userResponse, token });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const bulkCreateUsers = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    // Parse Excel file. cellDates:true so a real Excel date cell in the
    // optional enrollmentValidTill column arrives as a JS Date rather than
    // a bare serial number.
    const workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const users = XLSX.utils.sheet_to_json(sheet);

    if (users.length === 0) {
      return res.status(400).json({ error: "Excel file is empty" });
    }

    // Validation results
    const validUsers = [];
    const errors = [];

    // Email validation regex
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    // Step 1: Validate all rows first
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const rowNumber = i + 2; // Excel row (header is row 1)

      // Required field validation
      if (!user.username || !user.email || !user.password || !user.role) {
        errors.push({
          row: rowNumber,
          email: user.email || 'N/A',
          reason: 'Missing required fields (username, email, password, role)'
        });
        continue;
      }

      // Type validation
      if (
        typeof user.username !== "string" ||
        typeof user.email !== "string" ||
        typeof user.password !== "string" ||
        typeof user.role !== "string"
      ) {
        errors.push({
          row: rowNumber,
          email: user.email,
          reason: 'Invalid data types'
        });
        continue;
      }

      // Trim and sanitize
      const sanitizedUser = {
        registerNumber: user.registerNumber ? String(user.registerNumber).trim() : null,
        username: user.username.trim(),
        email: user.email.toLowerCase().trim(),
        password: user.password.trim(),
        role: user.role.toLowerCase().trim(),
        category: user.category ? String(user.category).toLowerCase().trim() : null,
      };

      // Optional: set up (or renew) this student's course enrollment
      // directly from this same row — same {userId, category} record the
      // "Manage Enrollment" modal sets, just batched here so the admin
      // doesn't need a separate pass afterward. Enrolls them in the same
      // category the row just created them under. Deliberately never
      // blocks the row: a blank cell just means "no enrollment set from
      // this upload", and an unparseable one is reported separately after
      // the account is created rather than failing the whole row over it.
      sanitizedUser.enrollmentValidTill = null;
      sanitizedUser.enrollmentDateError = null;
      if (sanitizedUser.role === "student" && user.enrollmentValidTill !== undefined) {
        try {
          sanitizedUser.enrollmentValidTill = parseEnrollmentValidTill(
            user.enrollmentValidTill
          );
        } catch (dateError) {
          sanitizedUser.enrollmentDateError = dateError.message;
        }
      }

      // Optional: "Full Course Access" (default) vs "Test Series Only" for
      // the enrollment this row sets up above. Same non-fatal treatment as
      // the date column — a blank cell defaults to "full", and any other
      // unrecognized value is reported per-row without failing the account
      // creation itself.
      sanitizedUser.accessLevel = "full";
      sanitizedUser.accessLevelError = null;
      if (user.accessLevel !== undefined && user.accessLevel !== null && String(user.accessLevel).trim() !== "") {
        const normalizedAccessLevel = String(user.accessLevel).toLowerCase().trim();
        if (normalizedAccessLevel === "full" || normalizedAccessLevel === "test_series_only") {
          sanitizedUser.accessLevel = normalizedAccessLevel;
        } else {
          sanitizedUser.accessLevelError = `Unrecognized accessLevel "${user.accessLevel}" — use "full" or "test_series_only"`;
        }
      }

      // Email format validation
      if (!emailRegex.test(sanitizedUser.email)) {
        errors.push({
          row: rowNumber,
          email: sanitizedUser.email,
          reason: 'Invalid email format'
        });
        continue;
      }

      // Role validation
      if (!['student', 'evaluator', 'admin'].includes(sanitizedUser.role)) {
        errors.push({
          row: rowNumber,
          email: sanitizedUser.email,
          reason: `Invalid role: ${sanitizedUser.role}. Must be student, evaluator, or admin`
        });
        continue;
      }

      // Student-specific validation
      if (sanitizedUser.role === 'student' && !sanitizedUser.registerNumber) {
        errors.push({
          row: rowNumber,
          email: sanitizedUser.email,
          reason: 'Register number is required for students'
        });
        continue;
      }

      if (sanitizedUser.role === 'student' && !EXAM_CATEGORIES.includes(sanitizedUser.category)) {
        errors.push({
          row: rowNumber,
          email: sanitizedUser.email,
          reason: `Category is required for students and must be one of: ${EXAM_CATEGORIES.join(", ")}`
        });
        continue;
      }

      // Password strength validation
      if (sanitizedUser.password.length < 3) {
        errors.push({
          row: rowNumber,
          email: sanitizedUser.email,
          reason: 'Password must be at least 3 characters long'
        });
        continue;
      }

      validUsers.push({ ...sanitizedUser, rowNumber });
    }

    // If no valid users, return errors
    if (validUsers.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid users to insert',
        inserted: 0,
        errors
      });
    }

    // Step 2: Check for duplicates in batch (PERFORMANCE OPTIMIZATION)
    const emails = validUsers.map(u => u.email);
    const registerNumbers = validUsers
      .filter(u => u.registerNumber)
      .map(u => u.registerNumber);

    const existingUsers = await userModel.find({
      $or: [
        { email: { $in: emails } },
        { registerNumber: { $in: registerNumbers } }
      ]
    }).select('email registerNumber');

    // Create sets for O(1) lookup
    const existingEmails = new Set(existingUsers.map(u => u.email));
    const existingRegNums = new Set(
      existingUsers.filter(u => u.registerNumber).map(u => u.registerNumber)
    );

    // Filter out duplicates
    const usersToInsert = [];
    for (const user of validUsers) {
      if (existingEmails.has(user.email)) {
        errors.push({
          row: user.rowNumber,
          email: user.email,
          reason: 'Email already exists in database'
        });
        continue;
      }

      if (user.registerNumber && existingRegNums.has(user.registerNumber)) {
        errors.push({
          row: user.rowNumber,
          email: user.email,
          reason: `Register number ${user.registerNumber} already exists`
        });
        continue;
      }

      usersToInsert.push(user);
    }

    if (usersToInsert.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'All users are duplicates or invalid',
        inserted: 0,
        errors
      });
    }

    // Step 3: Hash passwords in parallel (PERFORMANCE OPTIMIZATION)
    const hashedUsers = await Promise.all(
      usersToInsert.map(async (user) => ({
        registerNumber: user.role === 'student' ? user.registerNumber : undefined,
        username: user.username,
        email: user.email,
        password: await bcrypt.hash(user.password, 10),
        role: user.role,
        category: user.role === 'student' ? user.category : null,
      }))
    );

    // Step 4: Bulk insert with error handling (ATOMIC OPERATION)
    let insertedCount = 0;
    let insertedDocs = [];
    try {
      const result = await userModel.insertMany(hashedUsers, {
        ordered: false // Continue on duplicate key errors
      });
      insertedCount = result.length;
      insertedDocs = result;
    } catch (error) {
      // Handle duplicate key errors that slipped through
      if (error.code === 11000) {
        // Some duplicates were caught by MongoDB
        insertedCount = error.insertedDocs ? error.insertedDocs.length : 0;
        insertedDocs = error.insertedDocs || [];

        // Add duplicate errors
        if (error.writeErrors) {
          error.writeErrors.forEach((err) => {
            const failedUser = hashedUsers[err.index];
            errors.push({
              row: usersToInsert[err.index].rowNumber,
              email: failedUser.email,
              reason: 'Duplicate key error (race condition)'
            });
          });
        }
      } else {
        throw error; // Re-throw non-duplicate errors
      }
    }

    // Step 5: Optional per-row enrollment setup, for whichever rows
    // supplied a usable enrollmentValidTill and were actually inserted.
    // Batched via bulkWrite (upsert on {userId, category}, same key as
    // enrollmentController.js's setEnrollment) rather than one write per
    // row. Never fails the upload over enrollment — the user accounts are
    // already safely created by this point regardless of what happens here.
    const enrollmentErrors = [];
    let enrollmentsCreated = 0;

    if (insertedDocs.length > 0) {
      const emailToUserId = new Map(
        insertedDocs.map((doc) => [doc.email, doc._id])
      );

      const enrollmentOps = [];
      for (const user of usersToInsert) {
        if (user.role !== "student") continue;
        const userId = emailToUserId.get(user.email);
        if (!userId) continue; // wasn't actually inserted (race-condition duplicate)

        if (user.enrollmentDateError) {
          enrollmentErrors.push({
            row: user.rowNumber,
            email: user.email,
            reason: `Account created, but enrollment was not set: ${user.enrollmentDateError}`,
          });
          continue;
        }

        // An accessLevel column error is reported too, but — unlike a bad
        // date — doesn't block the enrollment from being created at all;
        // it just falls back to "full" (already the default sanitizedUser
        // set above), since a plan-level typo shouldn't leave the student
        // with no enrollment/date set up whatsoever.
        if (user.accessLevelError) {
          enrollmentErrors.push({
            row: user.rowNumber,
            email: user.email,
            reason: `${user.accessLevelError} — defaulted to "full" for this row.`,
          });
        }

        if (!user.enrollmentValidTill) continue; // column left blank — nothing to do here

        enrollmentOps.push({
          updateOne: {
            filter: { userId, category: user.category },
            update: {
              $set: {
                userId,
                category: user.category,
                validTill: user.enrollmentValidTill,
                revoked: false,
                accessLevel: user.accessLevel,
                grantedBy: req.user._id,
              },
              $setOnInsert: { validFrom: new Date() },
            },
            upsert: true,
          },
        });
      }

      if (enrollmentOps.length > 0) {
        try {
          const bulkResult = await enrollmentModel.bulkWrite(enrollmentOps, {
            ordered: false,
          });
          enrollmentsCreated =
            (bulkResult.upsertedCount || 0) + (bulkResult.modifiedCount || 0);
        } catch (enrollmentError) {
          enrollmentErrors.push({
            row: null,
            email: null,
            reason: `Some enrollments could not be saved: ${enrollmentError.message}`,
          });
        }
      }
    }

    // Step 6: Return detailed response
    res.status(200).json({
      success: true,
      message: `Successfully inserted ${insertedCount} users`,
      inserted: insertedCount,
      skipped: errors.length,
      errors: errors.length > 0 ? errors : undefined,
      enrollmentsCreated,
      enrollmentErrors: enrollmentErrors.length > 0 ? enrollmentErrors : undefined,
    });

  } catch (error) {
    // Handle file parsing errors
    if (error.message.includes('Invalid file')) {
      return res.status(400).json({ error: error.message });
    }
    
    res.status(500).json({ 
      error: "Failed to process bulk upload",
      details: error.message 
    });
  }
};

const getAllUsersData = async (req, res) => {
  try {
    const usersData = await userModel.find().select("-password");
    res.status(200).json(usersData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getUserBasedOnId = async (req, res) => {
  try {
    const { userId } = req.params;
    const usersData = await userModel.findById(userId).select("-password");
    if (!usersData) {
      return res.status(404).json({ error: "User not found" });
    }
    res.status(200).json(usersData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const updatePassword = async (req, res) => {
  try {
    const { password } = req.body;
    const { userId } = req.params;

    if (req.user.role !== "admin" && req.user._id.toString() !== userId) {
      return res.status(403).json({ error: "Unauthorized to change password" });
    }

    if (!userId || !password) {
      return res.status(400).json({ error: "All fields are required" });
    }

    if (password.length < 3) {
      return res
        .status(400)
        .json({ error: "Password must be at least 3 characters long" });
    }
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const userData = await userModel
      .findByIdAndUpdate(userId, {
        password: hashedPassword,
      })
      .select("-password");
    res.status(200).json(userData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getUserData = async (req, res) => {
  try {
    const userData = await userModel.findById(req.user._id).select("-password");
    if (!userData) {
      return res.status(404).json({ error: "User not found" });
    }

    const responseData = userData.toObject();
    // Students only — see the matching computation in loginUser above for
    // why this has to be set in both places.
    if (responseData.role === "student") {
      const profile = await studentProfileModel
        .findOne({ userId: userData._id })
        .select("status");
      responseData.profileCompleted = profile?.status === "submitted";
    }

    res.status(200).json(responseData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const logoutUser = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }
    await userModel.findByIdAndUpdate(req.user._id, { sessionToken: null });
    res.clearCookie("token", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Strict",
      path: "/",
    });
    res.status(200).json({
      success: true,
      message: "Logged out",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const downloadUserTemplate = (req, res) => {
  const worksheetData = [
    [
      "registerNumber",
      "username",
      "email",
      "password",
      "role",
      "category",
      "enrollmentValidTill",
      "accessLevel",
    ],
    [
      "7719801424",
      "JohnDoe",
      "john@example.com",
      "123456",
      "student",
      "gate", // one of: gate, tnpsc-ae, tnpsc-jdo, ssc-rrb-je — required for students, leave blank for evaluator/admin rows
      "19-02-2027", // optional — sets this student's course enrollment (category above) valid till this date, same as the "Manage Enrollment" screen. Format: DD-MM-YYYY. Leave blank to skip and set it up later.
      "full", // optional — "full" (Full Course Access) or "test_series_only" (tests only, no live classes/recordings/materials). Leave blank to default to "full".
    ],
  ];

  const ws = XLSX.utils.aoa_to_sheet(worksheetData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Users");

  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  res.setHeader(
    "Content-Disposition",
    "attachment; filename=UserTemplate.xlsx"
  );
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  stream.pipe(res);
};

// Controllers / Control Panel — "enable/disable student access". Admin-only.
// Flips isDisabled; a disabled account is rejected immediately (see
// authMiddleware.js's verifyToken) even on an already-issued session token,
// and rejected again at their next login attempt with a clear message.
const toggleUserActive = async (req, res) => {
  try {
    const { userId } = req.params;
    const { isDisabled } = req.body;

    if (typeof isDisabled !== "boolean") {
      return res
        .status(400)
        .json({ success: false, message: "isDisabled (boolean) is required." });
    }

    if (req.user._id.toString() === userId && isDisabled) {
      return res.status(400).json({
        success: false,
        message: "You cannot disable your own admin account.",
      });
    }

    const user = await userModel
      .findByIdAndUpdate(userId, { isDisabled }, { new: true })
      .select("-password");

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.status(200).json({
      success: true,
      message: isDisabled ? "Account disabled." : "Account re-enabled.",
      user,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// PATCH /api/users/:userId/batch (admin only) — sets the free-text "batch"
// grouping label (e.g. "2026 Morning Batch") used only for filtering on the
// Student Progress dashboard; unlike `category` this never gates access to
// anything.
const updateStudentBatch = async (req, res) => {
  try {
    const { userId } = req.params;
    const { batch } = req.body;

    const user = await userModel
      .findByIdAndUpdate(userId, { batch: batch || "" }, { new: true })
      .select("-password");

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.status(200).json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  registerUser,
  loginUser,
  bulkCreateUsers,
  getAllUsersData,
  getUserBasedOnId,
  updatePassword,
  logoutUser,
  getUserData,
  downloadUserTemplate,
  toggleUserActive,
  updateStudentBatch,
};
