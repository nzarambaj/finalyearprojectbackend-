const path = require("path");
const FormData = require("form-data");
const axios = require("axios");

const pool = require("../config/db");
const cloudinary = require("../config/cloudinary");

const DICOM_SERVICE_URL =
    process.env.DICOM_SERVICE_URL ||
    "http://localhost:8000";

/*
 * Doctor records the patient details and submits
 * an imaging request. Returns the request number
 * the patient takes to the technician.
 */
exports.createRequest = async (req, res) => {

    const client = await pool.connect();

    try {

        const {
            patient_name,
            date_of_birth,
            gender,
            phone,
            address,
            exam_type,
            clinical_notes,
            priority
        } = req.body;

        const requestPriority =
            priority === "urgent" ? "urgent" : "normal";

        if (!patient_name || !patient_name.trim()) {
            return res.status(400).json({
                message: "Patient name is required"
            });
        }

        if (!exam_type) {
            return res.status(400).json({
                message: "Exam type is required"
            });
        }

        await client.query("BEGIN");

        const patientResult = await client.query(
            `
            INSERT INTO patients
            (
                full_name,
                date_of_birth,
                gender,
                phone,
                address,
                created_by
            )
            VALUES ($1,$2,$3,$4,$5,$6)
            RETURNING *
            `,
            [
                patient_name.trim(),
                date_of_birth || null,
                gender || null,
                phone || null,
                address || null,
                req.user.id
            ]
        );

        const patient = patientResult.rows[0];

        const requestResult = await client.query(
            `
            INSERT INTO imaging_requests
            (
                id,
                request_number,
                patient_id,
                doctor_id,
                exam_type,
                clinical_notes,
                priority
            )
            VALUES (
                nextval('imaging_requests_id_seq'),
                'REQ-' || LPAD(
                    currval(
                        'imaging_requests_id_seq'
                    )::text,
                    5, '0'
                ),
                $1,$2,$3,$4,$5
            )
            RETURNING *
            `,
            [
                patient.id,
                req.user.id,
                exam_type,
                clinical_notes || null,
                requestPriority
            ]
        );

        await client.query("COMMIT");

        res.status(201).json({
            message: "Request submitted successfully",
            request: {
                ...requestResult.rows[0],
                patient_name: patient.full_name
            }
        });

    } catch (error) {

        await client.query("ROLLBACK");

        console.error(error);

        res.status(500).json({
            message: "Server error"
        });

    } finally {

        client.release();

    }
};

/*
 * List requests.
 * All doctors and technicians see the full list;
 * technicians can search by request number or
 * patient name (?search=).
 */
exports.getRequests = async (req, res) => {

    try {

        const { search } = req.query;

        const params = [];

        let where = "";

        if (search && search.trim()) {

            params.push(`%${search.trim()}%`);

            where = `
                WHERE r.request_number ILIKE $1
                   OR p.full_name ILIKE $1
            `;
        }

        const result = await pool.query(
            `
            SELECT
                r.id,
                r.request_number,
                r.exam_type,
                r.status,
                r.priority,
                r.created_at,
                r.doctor_id,

                p.full_name AS patient_name,

                u.full_name AS doctor_name

            FROM imaging_requests r

            JOIN patients p
                ON r.patient_id = p.id

            JOIN users u
                ON r.doctor_id = u.id

            ${where}

            ORDER BY r.created_at DESC
            `,
            params
        );

        res.json(result.rows);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            message: "Server error"
        });

    }
};

/*
 * Worklist overview for doctors: headline stats plus
 * the full request list with a derived read-status
 * (pending -> no image yet, review -> image uploaded
 * but not yet read, ready -> read & commented).
 */
exports.getWorklist = async (req, res) => {

    try {

        const statsResult = await pool.query(
            `
            SELECT
                -- studies (images) captured today
                (
                    SELECT COUNT(*)
                    FROM studies
                    WHERE created_at::date = CURRENT_DATE
                ) AS todays_studies,

                -- image uploaded but not yet read
                (
                    SELECT COUNT(*)
                    FROM imaging_requests r
                    WHERE r.status = 'completed'
                      AND NOT EXISTS (
                          SELECT 1
                          FROM request_comments c
                          WHERE c.request_id = r.id
                      )
                ) AS pending_reads,

                -- of those, how many are urgent
                (
                    SELECT COUNT(*)
                    FROM imaging_requests r
                    WHERE r.status = 'completed'
                      AND r.priority = 'urgent'
                      AND NOT EXISTS (
                          SELECT 1
                          FROM request_comments c
                          WHERE c.request_id = r.id
                      )
                ) AS urgent_reads,

                -- reports (comments) issued this month
                (
                    SELECT COUNT(DISTINCT c.request_id)
                    FROM request_comments c
                    WHERE date_trunc('month', c.created_at)
                        = date_trunc('month', CURRENT_DATE)
                ) AS reports_issued,

                -- patients registered this month
                (
                    SELECT COUNT(*)
                    FROM patients
                    WHERE date_trunc('month', created_at)
                        = date_trunc('month', CURRENT_DATE)
                ) AS active_patients,

                -- studies captured yesterday (for the delta)
                (
                    SELECT COUNT(*)
                    FROM studies
                    WHERE created_at::date
                        = CURRENT_DATE - INTERVAL '1 day'
                ) AS yesterday_studies
            `
        );

        const itemsResult = await pool.query(
            `
            SELECT
                r.id,
                r.request_number,
                r.exam_type,
                r.status,
                r.priority,
                r.created_at,
                r.doctor_id,

                p.full_name AS patient_name,

                u.full_name AS doctor_name,

                EXISTS (
                    SELECT 1
                    FROM request_comments c
                    WHERE c.request_id = r.id
                ) AS has_report

            FROM imaging_requests r

            JOIN patients p
                ON r.patient_id = p.id

            JOIN users u
                ON r.doctor_id = u.id

            ORDER BY
                CASE WHEN r.priority = 'urgent'
                     THEN 0 ELSE 1 END,
                r.created_at DESC
            `
        );

        const items = itemsResult.rows.map((r) => {

            let readStatus = "pending";

            if (r.status === "completed") {
                readStatus = r.has_report
                    ? "ready"
                    : "review";
            }

            return {
                ...r,
                read_status: readStatus
            };
        });

        const stats = statsResult.rows[0];

        const pending = items.filter(
            (i) => i.read_status !== "ready"
        ).length;

        res.json({
            stats: {
                todays_studies:
                    Number(stats.todays_studies),
                yesterday_studies:
                    Number(stats.yesterday_studies),
                pending_reads:
                    Number(stats.pending_reads),
                urgent_reads:
                    Number(stats.urgent_reads),
                reports_issued:
                    Number(stats.reports_issued),
                active_patients:
                    Number(stats.active_patients)
            },
            pending_count: pending,
            items
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            message: "Server error"
        });

    }
};

/*
 * Request details: patient record, clinical notes
 * and the uploaded image (once it exists).
 * Any authorised user may view any request; only the
 * requesting doctor can comment on it.
 */
exports.getRequestById = async (req, res) => {

    try {

        const { id } = req.params;

        const result = await pool.query(
            `
            SELECT
                r.*,

                p.full_name AS patient_name,
                p.date_of_birth,
                p.gender,
                p.phone,
                p.address,

                u.full_name AS doctor_name,

                df.file_path,

                s.overlay_url

            FROM imaging_requests r

            JOIN patients p
                ON r.patient_id = p.id

            JOIN users u
                ON r.doctor_id = u.id

            LEFT JOIN studies s
                ON s.id = r.study_id

            LEFT JOIN dicom_files df
                ON df.study_id = r.study_id

            WHERE r.id = $1
            `,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "Request not found"
            });
        }

        const request = result.rows[0];

        if (
            request.file_path &&
            request.file_path.startsWith("http")
        ) {
            request.file_url = request.file_path;
        }

        res.json(request);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            message: "Server error"
        });

    }
};

/*
 * Technician uploads the image taken for a request.
 */
exports.uploadRequestImage = async (req, res) => {

    try {

        if (!req.file) {
            return res.status(400).json({
                message: "No file uploaded"
            });
        }

        const { id } = req.params;

        const requestResult = await pool.query(
            `
            SELECT r.*, p.full_name AS patient_name
            FROM imaging_requests r
            JOIN patients p
                ON r.patient_id = p.id
            WHERE r.id = $1
            `,
            [id]
        );

        if (requestResult.rows.length === 0) {
            return res.status(404).json({
                message: "Request not found"
            });
        }

        const request = requestResult.rows[0];

        if (request.status === "completed") {
            return res.status(400).json({
                message:
                    "An image was already uploaded for this request"
            });
        }

        // Extract metadata via the DICOM service.
        const form = new FormData();

        form.append(
            "file",
            req.file.buffer,
            req.file.originalname
        );

        const dicomResponse = await axios.post(
            `${DICOM_SERVICE_URL}/extract`,
            form,
            {
                headers: form.getHeaders()
            }
        );

        const metadata = dicomResponse.data;

        // .nii.gz must keep its double extension.
        const fileExt =
            /\.nii\.gz$/i.test(req.file.originalname)
                ? ".nii.gz"
                : path.extname(req.file.originalname);

        const cloudinaryResult =
            await new Promise((resolve, reject) => {

                const stream =
                    cloudinary.uploader.upload_stream(
                        {
                            resource_type: "raw",
                            folder: "dicom",
                            public_id:
                                Date.now() + fileExt,
                            use_filename: false
                        },
                        (error, result) =>
                            error
                                ? reject(error)
                                : resolve(result)
                    );

                stream.end(req.file.buffer);

            });

        const fileUrl = cloudinaryResult.secure_url;

        const studyResult = await pool.query(
            `
            INSERT INTO studies
            (
                uploaded_by,
                patient_identifier,
                request_id,
                modality,
                status,
                metadata
            )
            VALUES ($1,$2,$3,$4,'completed',$5)
            RETURNING *
            `,
            [
                req.user.id,
                request.patient_name,
                request.id,
                metadata.modality ||
                    request.exam_type,
                JSON.stringify(metadata)
            ]
        );

        const study = studyResult.rows[0];

        await pool.query(
            `
            INSERT INTO dicom_files
            (
                study_id,
                file_path
            )
            VALUES ($1,$2)
            `,
            [study.id, fileUrl]
        );

        await pool.query(
            `
            UPDATE imaging_requests
            SET status = 'completed',
                study_id = $1
            WHERE id = $2
            `,
            [study.id, request.id]
        );

        res.status(201).json({
            message: "Image uploaded successfully",
            study
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            message: "Server error"
        });

    }
};

/*
 * Upload an AVM (or other) segmentation overlay for a
 * request's study. The mask is produced externally,
 * registered to the CT, and stored as a NIfTI; the
 * viewer paints it over the CT.
 */
exports.uploadRequestOverlay = async (req, res) => {

    try {

        if (!req.file) {
            return res.status(400).json({
                message: "No file uploaded"
            });
        }

        const { id } = req.params;

        const requestResult = await pool.query(
            "SELECT study_id FROM imaging_requests WHERE id = $1",
            [id]
        );

        if (requestResult.rows.length === 0) {
            return res.status(404).json({
                message: "Request not found"
            });
        }

        const studyId = requestResult.rows[0].study_id;

        if (!studyId) {
            return res.status(400).json({
                message:
                    "Upload the CT image before adding an overlay"
            });
        }

        // Keep the NIfTI extension (.nii / .nii.gz).
        const fileExt =
            /\.nii\.gz$/i.test(req.file.originalname)
                ? ".nii.gz"
                : path.extname(req.file.originalname);

        const cloudinaryResult =
            await new Promise((resolve, reject) => {

                const stream =
                    cloudinary.uploader.upload_stream(
                        {
                            resource_type: "raw",
                            folder: "overlays",
                            public_id:
                                Date.now() + fileExt,
                            use_filename: false
                        },
                        (error, result) =>
                            error
                                ? reject(error)
                                : resolve(result)
                    );

                stream.end(req.file.buffer);

            });

        const overlayUrl = cloudinaryResult.secure_url;

        await pool.query(
            "UPDATE studies SET overlay_url = $1 WHERE id = $2",
            [overlayUrl, studyId]
        );

        res.status(201).json({
            message: "Overlay uploaded successfully",
            overlay_url: overlayUrl
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            message: "Server error"
        });

    }
};

/*
 * Comments on a request. Anyone authorised may read
 * them; only the doctor who submitted the request
 * may write them.
 */

async function loadOwnedRequest(id, userId) {

    const result = await pool.query(
        `
        SELECT id, doctor_id
        FROM imaging_requests
        WHERE id = $1
        `,
        [id]
    );

    if (result.rows.length === 0) {
        return { error: 404 };
    }

    if (result.rows[0].doctor_id !== userId) {
        return { error: 403 };
    }

    return { request: result.rows[0] };
}

exports.getRequestComments = async (req, res) => {

    try {

        const { id } = req.params;

        const exists = await pool.query(
            "SELECT 1 FROM imaging_requests WHERE id = $1",
            [id]
        );

        if (exists.rows.length === 0) {
            return res.status(404).json({
                message: "Request not found"
            });
        }

        const result = await pool.query(
            `
            SELECT
                c.id,
                c.comment,
                c.created_at,
                u.full_name AS author_name

            FROM request_comments c

            JOIN users u
                ON c.author_id = u.id

            WHERE c.request_id = $1

            ORDER BY c.created_at DESC
            `,
            [id]
        );

        res.json(result.rows);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            message: "Server error"
        });

    }
};

exports.addRequestComment = async (req, res) => {

    try {

        const { id } = req.params;
        const { comment } = req.body;

        if (!comment || !comment.trim()) {
            return res.status(400).json({
                message: "Comment is required"
            });
        }

        const owned = await loadOwnedRequest(
            id,
            req.user.id
        );

        if (owned.error === 404) {
            return res.status(404).json({
                message: "Request not found"
            });
        }

        if (owned.error === 403) {
            return res.status(403).json({
                message:
                    "Only the requesting doctor can comment on this request"
            });
        }

        const result = await pool.query(
            `
            INSERT INTO request_comments
            (
                request_id,
                author_id,
                comment
            )
            VALUES ($1,$2,$3)
            RETURNING *
            `,
            [
                id,
                req.user.id,
                comment.trim()
            ]
        );

        res.status(201).json(result.rows[0]);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            message: "Server error"
        });

    }
};
