const express = require("express");
const router = express.Router();
const authenticateToken = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");

const {
    register,
    login,
    getCurrentUser
} = require("../controllers/authController");

// Registration is admin-only: an administrator signs in
// at /admin and creates each user. No public self-signup.
router.post(
    "/register",
    authenticateToken,
    authorizeRoles("admin"),
    register
);
router.post("/login", login);
router.get("/me", authenticateToken, getCurrentUser);
module.exports = router;