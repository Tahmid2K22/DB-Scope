/**
 * profileController.ts
 * REST API handlers for user profile endpoints.
 *
 * DB-Scope dependency demo:
 *   - Selects users.phone in profile GET response
 *   - Updates users.phone via PATCH endpoint
 *   - Three distinct references to the phone column
 */

import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

type Request  = { params: Record<string, string>; body: Record<string, unknown> };
type Response = { json: (data: unknown) => void; status: (code: number) => Response };

// GET /users/:id/profile
export async function getProfile(req: Request, res: Response) {
    const userId = parseInt(req.params.id, 10);

    const result = await pool.query(
        `SELECT id, first_name, last_name, email, phone, created_at
         FROM users
         WHERE id = $1 AND deleted_at IS NULL`,
        [userId]
    );

    if (!result.rows[0]) {
        return res.status(404).json({ error: 'User not found' });
    }

    return res.json(result.rows[0]);  // exposes phone in API response
}

// PATCH /users/:id/profile
export async function updateProfile(req: Request, res: Response) {
    const userId = parseInt(req.params.id, 10);
    const { firstName, lastName, phone } = req.body as {
        firstName?: string;
        lastName?: string;
        phone?: string;
    };

    // Updates users.phone — will break after migration 003
    await pool.query(
        `UPDATE users
         SET first_name = COALESCE($1, first_name),
             last_name  = COALESCE($2, last_name),
             phone      = COALESCE($3, phone),
             updated_at = NOW()
         WHERE id = $4`,
        [firstName, lastName, phone, userId]
    );

    return res.json({ success: true });
}

// GET /users/:id/contact  — returns only contact info including phone
export async function getContactInfo(req: Request, res: Response) {
    const userId = parseInt(req.params.id, 10);

    const result = await pool.query(
        `SELECT email, phone FROM users WHERE id = $1`,
        [userId]
    );

    return res.json(result.rows[0] ?? {});
}
