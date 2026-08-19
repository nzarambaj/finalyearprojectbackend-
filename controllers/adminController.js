const bcrypt = require("bcrypt");
const pool = require("../config/db");

/*
 * Admin dashboard: overview stats.
 */
exports.getStats = async (req, res) => {
    try {
        const result = await pool.query(
            `
            SELECT
                (SELECT COUNT(*) FROM users
                    WHERE role <> 'admin') AS total_users,
                (SELECT COUNT(*) FROM users
                    WHERE role = 'doctor') AS doctors,
                (SELECT COUNT(*) FROM users
                    WHERE role = 'technician') AS technicians,
                (SELECT COUNT(*) FROM users
                    WHERE active = false) AS deactivated,

                (SELECT COUNT(*) FROM imaging_requests)
                    AS total_requests,
                (SELECT COUNT(*) FROM imaging_requests
                    WHERE status <> 'completed') AS pending_requests,

                (SELECT COUNT(DISTINCT c.request_id)
                    FROM request_comments c
                    WHERE date_trunc('month', c.created_at)
                        = date_trunc('month', CURRENT_DATE))
                    AS reports_this_month,

                (SELECT COUNT(*) FROM patients
                    WHERE date_trunc('month', created_at)
                        = date_trunc('month', CURRENT_DATE))
                    AS patients_this_month
            `
        );

        const s = result.rows[0];
        res.json({
            total_users: Number(s.total_users),
            doctors: Number(s.doctors),
            technicians: Number(s.technicians),
            deactivated: Number(s.deactivated),
            total_requests: Number(s.total_requests),
            pending_requests: Number(s.pending_requests),
            reports_this_month: Number(s.reports_this_month),
            patients_this_month: Number(s.patients_this_month)
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
};

/*
 * List users (optionally filtered by role), with their
 * specialization and active state.
 */
exports.getUsers = async (req, res) => {
    try {
        const { role } = req.query;

        const params = [];
        let where = "WHERE u.role <> 'admin'";

        if (role && role !== "all") {
            params.push(role);
            where = `WHERE u.role = $1`;
        }

        const result = await pool.query(
            `
            SELECT
                u.id,
                u.full_name,
                u.email,
                u.role,
                u.active,
                u.created_at,
                s.name AS specialization,
                dp.specialization_id
            FROM users u
            LEFT JOIN doctor_profiles dp
                ON dp.user_id = u.id
            LEFT JOIN specializations s
                ON s.id = dp.specialization_id
            ${where}
            ORDER BY u.full_name
            `,
            params
        );

        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
};

/*
 * Update a user: active state, role, and/or the doctor's
 * specialization.
 */
exports.updateUser = async (req, res) => {
    try {
        const { id } = req.params;
        const { active, role, specialization_id } = req.body;

        if (Number(id) === req.user.id && active === false) {
            return res.status(400).json({
                message: "You cannot deactivate your own account"
            });
        }

        const existing = await pool.query(
            "SELECT id, role FROM users WHERE id = $1",
            [id]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({
                message: "User not found"
            });
        }

        if (typeof active === "boolean") {
            await pool.query(
                "UPDATE users SET active = $1 WHERE id = $2",
                [active, id]
            );
        }

        const nextRole = role || existing.rows[0].role;
        if (role) {
            await pool.query(
                "UPDATE users SET role = $1 WHERE id = $2",
                [role, id]
            );
        }

        // Keep the doctor's specialization profile in sync.
        if (
            nextRole === "doctor" &&
            specialization_id
        ) {
            const prof = await pool.query(
                "SELECT id FROM doctor_profiles WHERE user_id = $1",
                [id]
            );
            if (prof.rows.length === 0) {
                await pool.query(
                    "INSERT INTO doctor_profiles (user_id, specialization_id) VALUES ($1,$2)",
                    [id, specialization_id]
                );
            } else {
                await pool.query(
                    "UPDATE doctor_profiles SET specialization_id = $1 WHERE user_id = $2",
                    [specialization_id, id]
                );
            }
        }

        res.json({ message: "User updated" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
};

/*
 * Reset a user's password to an admin-provided value.
 */
exports.resetPassword = async (req, res) => {
    try {
        const { id } = req.params;
        const { password } = req.body;

        if (!password || password.length < 6) {
            return res.status(400).json({
                message: "Password must be at least 6 characters"
            });
        }

        const hash = await bcrypt.hash(password, 10);
        const result = await pool.query(
            "UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id",
            [hash, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "User not found"
            });
        }

        res.json({ message: "Password reset" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
};

/*
 * Doctors list (id + name) for the reassign dropdown.
 */
exports.getDoctors = async (req, res) => {
    try {
        const result = await pool.query(
            `
            SELECT u.id, u.full_name, s.name AS specialization
            FROM users u
            LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
            LEFT JOIN specializations s ON s.id = dp.specialization_id
            WHERE u.role = 'doctor' AND u.active = true
            ORDER BY u.full_name
            `
        );
        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
};

/*
 * Reassign a request to another doctor and/or change its
 * priority (worklist management).
 */
exports.updateRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { doctor_id, priority } = req.body;

        const existing = await pool.query(
            "SELECT id FROM imaging_requests WHERE id = $1",
            [id]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({
                message: "Request not found"
            });
        }

        if (doctor_id) {
            await pool.query(
                "UPDATE imaging_requests SET doctor_id = $1 WHERE id = $2",
                [doctor_id, id]
            );
        }

        if (priority === "urgent" || priority === "normal") {
            await pool.query(
                "UPDATE imaging_requests SET priority = $1 WHERE id = $2",
                [priority, id]
            );
        }

        res.json({ message: "Request updated" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
};

/*
 * Specialization management.
 */
exports.createSpecialization = async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({
                message: "Name is required"
            });
        }

        const result = await pool.query(
            "INSERT INTO specializations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *",
            [name.trim()]
        );

        if (result.rows.length === 0) {
            return res.status(409).json({
                message: "That specialization already exists"
            });
        }

        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
};

exports.updateSpecialization = async (req, res) => {
    try {
        const { id } = req.params;
        const { name } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({
                message: "Name is required"
            });
        }
        const result = await pool.query(
            "UPDATE specializations SET name = $1 WHERE id = $2 RETURNING *",
            [name.trim(), id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "Specialization not found"
            });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
};

exports.deleteSpecialization = async (req, res) => {
    try {
        const { id } = req.params;

        // Don't delete one that's in use (doctors or
        // study categories reference it).
        const inUse = await pool.query(
            `
            SELECT
                (SELECT COUNT(*) FROM doctor_profiles
                    WHERE specialization_id = $1) AS docs,
                (SELECT COUNT(*) FROM study_categories
                    WHERE specialization_id = $1) AS cats
            `,
            [id]
        );
        const { docs, cats } = inUse.rows[0];
        if (Number(docs) > 0 || Number(cats) > 0) {
            return res.status(409).json({
                message:
                    "This specialization is in use and cannot be removed"
            });
        }

        await pool.query(
            "DELETE FROM specializations WHERE id = $1",
            [id]
        );
        res.json({ message: "Specialization removed" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
};
