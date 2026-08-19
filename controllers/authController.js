const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");

exports.register = async (req, res) => {

    try {

        const {
            full_name,
            email,
            password,
            role,
            specialization_id
        } = req.body;

        // Friendly message instead of a unique-constraint
        // 500 when the email is already taken.
        const existing = await pool.query(
            "SELECT 1 FROM users WHERE email = $1",
            [email]
        );

        if (existing.rows.length > 0) {
            return res.status(409).json({
                message:
                    "An account with this email already exists"
            });
        }

        const hashedPassword =
            await bcrypt.hash(password, 10);

        const userResult =
            await pool.query(
                `
                INSERT INTO users
                (
                    full_name,
                    email,
                    password_hash,
                    role
                )
                VALUES ($1,$2,$3,$4)
                RETURNING *
                `,
                [
                    full_name,
                    email,
                    hashedPassword,
                    role
                ]
            );

        const user =
            userResult.rows[0];

        if (
            role === "doctor" &&
            specialization_id
        ) {

            await pool.query(
                `
                INSERT INTO doctor_profiles
                (
                    user_id,
                    specialization_id
                )
                VALUES ($1,$2)
                `,
                [
                    user.id,
                    specialization_id
                ]
            );
        }

        res.status(201).json({
            message:
                "User registered successfully"
        });

    } catch (error) {

        console.error(error);

        // Postgres unique_violation (race on email)
        if (error.code === "23505") {
            return res.status(409).json({
                message:
                    "An account with this email already exists"
            });
        }

        res.status(500).json({
            message:
                "Server error"
        });
    }
};
exports.login = async (req, res) => {
    try {

        const {
            email,
            password
        } = req.body;

        const userResult = await pool.query(
            `
            SELECT
                u.*,
                s.name AS specialization

            FROM users u

            LEFT JOIN doctor_profiles dp
                ON dp.user_id = u.id

            LEFT JOIN specializations s
                ON s.id = dp.specialization_id

            WHERE u.email=$1
            `,
            [email]
        );

        if (userResult.rows.length === 0) {
            return res.status(401).json({
                message: "Invalid credentials"
            });
        }

        const user = userResult.rows[0];

        const validPassword = await bcrypt.compare(
            password,
            user.password_hash
        );

        if (!validPassword) {
            return res.status(401).json({
                message: "Invalid credentials"
            });
        }

        if (user.active === false) {
            return res.status(403).json({
                message:
                    "Your account has been deactivated. Contact an administrator."
            });
        }

        const token = jwt.sign(
            {
                id: user.id,
                role: user.role
            },
            process.env.JWT_SECRET,
            {
                expiresIn: "24h"
            }
        );

        res.json({
            token,
            user: {
                id: user.id,
                full_name: user.full_name,
                email: user.email,
                role: user.role,
                specialization:
                    user.specialization || null
            }
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Server error"
        });
    }
};

exports.getCurrentUser = async (req, res) => {
    try {

        const result = await pool.query(
            `SELECT
                u.id,
                u.full_name,
                u.email,
                u.role,
                s.name AS specialization

             FROM users u

             LEFT JOIN doctor_profiles dp
                ON dp.user_id = u.id

             LEFT JOIN specializations s
                ON s.id = dp.specialization_id

             WHERE u.id = $1`,
            [req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "User not found"
            });
        }

        res.json(result.rows[0]);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: "Server error"
        });
    }
};