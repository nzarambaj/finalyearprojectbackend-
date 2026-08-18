const express = require("express");

const router = express.Router();

const authenticateToken =
    require("../middleware/authMiddleware");

const authorizeRoles =
    require("../middleware/roleMiddleware");

const upload =
    require("../middleware/uploadMiddleware");

const {
    createRequest,
    getRequests,
    getWorklist,
    getRequestById,
    uploadRequestImage,
    uploadRequestOverlay,
    getRequestComments,
    addRequestComment
} = require("../controllers/requestController");

/*
 * Doctor submits an imaging request
 */
router.post(
    "/",
    authenticateToken,
    authorizeRoles("doctor"),
    createRequest
);

/*
 * List all requests (searchable)
 */
router.get(
    "/",
    authenticateToken,
    authorizeRoles(
        "doctor",
        "technician",
        "admin"
    ),
    getRequests
);

/*
 * Doctor worklist overview (stats + list)
 * Registered before "/:id" so it isn't captured.
 */
router.get(
    "/worklist",
    authenticateToken,
    authorizeRoles("doctor", "admin"),
    getWorklist
);

/*
 * Technician uploads the image for a request
 */
router.post(
    "/:id/upload",
    authenticateToken,
    authorizeRoles("technician"),
    upload.single("file"),
    uploadRequestImage
);

/*
 * Upload an AVM segmentation overlay (NIfTI mask).
 * Radiologist (doctor), technician, or admin.
 */
router.post(
    "/:id/overlay",
    authenticateToken,
    authorizeRoles("doctor", "technician", "admin"),
    upload.single("file"),
    uploadRequestOverlay
);

/*
 * Comments: anyone authorised may read; only the
 * requesting doctor may write (enforced in controller).
 */
router.get(
    "/:id/comments",
    authenticateToken,
    authorizeRoles(
        "doctor",
        "technician",
        "admin"
    ),
    getRequestComments
);

router.post(
    "/:id/comments",
    authenticateToken,
    authorizeRoles("doctor"),
    addRequestComment
);

/*
 * Request details
 */
router.get(
    "/:id",
    authenticateToken,
    authorizeRoles(
        "doctor",
        "technician",
        "admin"
    ),
    getRequestById
);

module.exports = router;
