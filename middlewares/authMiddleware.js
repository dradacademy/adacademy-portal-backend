const jwt = require("jsonwebtoken");
const userModel = require("../models/userModel");

const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Access token required" });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await userModel.findById(decoded.userId);

    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    if (user.sessionToken !== token) {
      return res.status(401).json({ error: "Session expired or invalid" });
    }

    // A disabled account is rejected immediately, even with a still-valid
    // session token — the admin's "disable student" control (Controllers /
    // Control Panel) needs to take effect right away, not just block future
    // logins.
    if (user.isDisabled) {
      return res.status(403).json({
        error: "This account has been disabled. Please contact the academy.",
      });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired" });
    }
    return res.status(401).json({ error: "Invalid token" });
  }
};

const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res
        .status(403)
        .json({ error: "Forbidden: You do not have the required permissions" });
    }
    next();
  };
};

// Same token check as verifyToken, but never rejects the request — used on
// routes the public homepage calls before any login (subjects/duration/mark
// "get" endpoints). A missing, expired, or otherwise invalid token just
// leaves req.user unset instead of returning 401; the controller then
// treats that the same as an anonymous visitor.
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return next();
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await userModel.findById(decoded.userId);

    if (user && user.sessionToken === token && !user.isDisabled) {
      req.user = user;
    }

    next();
  } catch (error) {
    next();
  }
};

module.exports = {
  verifyToken,
  authorizeRoles,
  optionalAuth,
};
