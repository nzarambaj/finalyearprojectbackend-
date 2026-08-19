require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");

const authRoutes = require("./routes/authRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");
const doctorRoutes = require("./routes/doctorRoutes");
const studyRoutes = require("./routes/studyRoutes");
const requestRoutes = require("./routes/requestRoutes");
const adminRoutes = require("./routes/adminRoutes");

const app = express();

app.use(cors());
app.use(express.json());

// app.use(
//     "/dicom",
//     express.static(
//         path.join(__dirname, "uploads/dicom")
//     )
// );

// Must match UPLOAD_DIR in middleware/uploadMiddleware.js
const UPLOAD_DIR = path.resolve(
    process.env.UPLOAD_DIR || "uploads/dicom"
);

app.get("/dicom/:filename", (req, res) => {

    const filePath = path.join(
        UPLOAD_DIR,
        path.basename(req.params.filename)
    );

    res.set({
        "Cache-Control": "no-store",
        "Pragma": "no-cache",
        "Expires": "0"
    });

    res.sendFile(filePath);
});

app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/doctors", doctorRoutes);
app.use("/api/studies", studyRoutes);
app.use("/api/requests", requestRoutes);
app.use("/api/admin", adminRoutes);

app.get("/", (req, res) => {
    res.json({
        message: "Medical Imaging API Running"
    });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});