const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const XLSX = require("xlsx");
const { Readable } = require("stream");
const userModel = require("../models/userModel");

const registerUser = async (req, res) => {
  try {
    const { registerNumber, username, email, password, role } = req.body;
    if (!username || !email || !password || !role) {
      return res.status(400).json({ error: "All fields are required" });
    }
    if (role !== "student" && role !== "evaluator" && role !== "admin") {
      return res.status(400).json({ error: "Invalid role" });
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

    await userModel.findByIdAndUpdate(user._id, { sessionToken: token });

    // Remove password from user object before sending
    const userResponse = { ...user.toObject() };
    delete userResponse.password;

    res.status(200).json({ user: userResponse, token });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const bulkCreateUsers = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    // Parse Excel file
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
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
        role: user.role.toLowerCase().trim()
      };

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
        role: user.role
      }))
    );

    // Step 4: Bulk insert with error handling (ATOMIC OPERATION)
    let insertedCount = 0;
    try {
      const result = await userModel.insertMany(hashedUsers, { 
        ordered: false // Continue on duplicate key errors
      });
      insertedCount = result.length;
    } catch (error) {
      // Handle duplicate key errors that slipped through
      if (error.code === 11000) {
        // Some duplicates were caught by MongoDB
        insertedCount = error.insertedDocs ? error.insertedDocs.length : 0;
        
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

    // Step 5: Return detailed response
    res.status(200).json({
      success: true,
      message: `Successfully inserted ${insertedCount} users`,
      inserted: insertedCount,
      skipped: errors.length,
      errors: errors.length > 0 ? errors : undefined
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
    res.status(200).json(userData);
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
    ["registerNumber", "username", "email", "password", "role"],
    ["7719801424", "JohnDoe", "john@example.com", "123456", "student"],
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
};
