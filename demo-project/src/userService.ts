/**
 * userService.ts
 * Core user CRUD operations.
 *
 * DB-Scope dependency demo:
 *   - Queries users.phone (migration 003 drops this column → HIGH RISK)
 *   - References users.email, users.first_name, users.last_name
 *   - References sessions table for auth
 */

import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Read ─────────────────────────────────────────────────────────────────────

export async function getUserById(id: number) {
    const result = await pool.query(
        `SELECT id, first_name, last_name, email, phone, created_at
         FROM users
         WHERE id = $1 AND deleted_at IS NULL`,
        [id]
    );
    return result.rows[0] ?? null;
}

export async function getUserByEmail(email: string) {
    const result = await pool.query(
        `SELECT id, first_name, last_name, email, phone
         FROM users
         WHERE email = $1`,
        [email]
    );
    return result.rows[0] ?? null;
}

// Queries users.phone — will break if migration 003 is applied
export async function getUserPhone(userId: number): Promise<string | null> {
    const result = await pool.query(
        `SELECT phone FROM users WHERE id = $1`,
        [userId]
    );
    return result.rows[0]?.phone ?? null;
}

// ── Write ─────────────────────────────────────────────────────────────────────

export async function createUser(data: {
    email: string;
    firstName: string;
    lastName: string;
    phone?: string;
}) {
    const result = await pool.query(
        `INSERT INTO users (email, first_name, last_name, phone)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, phone`,
        [data.email, data.firstName, data.lastName, data.phone ?? null]
    );
    return result.rows[0];
}

export async function softDeleteUser(userId: number) {
    await pool.query(
        `UPDATE users SET deleted_at = NOW() WHERE id = $1`,
        [userId]
    );
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export async function createSession(userId: number, token: string, expiresAt: Date) {
    const result = await pool.query(
        `INSERT INTO sessions (user_id, token, expires_at)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [userId, token, expiresAt]
    );
    return result.rows[0];
}

export async function invalidateAllUserSessions(userId: number) {
    await pool.query(
        `DELETE FROM sessions WHERE user_id = $1`,
        [userId]
    );
}
