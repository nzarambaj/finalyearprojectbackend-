const express = require("express");
const router = express.Router();

const authenticateToken =
    require("../middleware/authMiddleware");
const authorizeRoles =
    require("../middleware/roleMiddleware");

const {
    getStats,
    getUsers,
    updateUser,
    resetPassword,
    getDoctors,
    updateRequest,
    createSpecialization,
    updateSpecialization,
    deleteSpecialization
} = require("../controllers/adminController");

// Every admin route requires an authenticated admin.
router.use(authenticateToken, authorizeRoles("admin"));

router.get("/stats", getStats);

router.get("/users", getUsers);
router.patch("/users/:id", updateUser);
router.post("/users/:id/password", resetPassword);

router.get("/doctors", getDoctors);
router.patch("/requests/:id", updateRequest);

router.post("/specializations", createSpecialization);
router.patch("/specializations/:id", updateSpecialization);
router.delete("/specializations/:id", deleteSpecialization);

module.exports = router;
