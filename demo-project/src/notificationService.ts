/**
 * notificationService.ts
 * Sends emails and SMS notifications to users.
 *
 * DB-Scope dependency demo:
 *   - Queries users.phone for SMS dispatch (breaks if migration 003 runs)
 *   - Queries users.email for email dispatch
 */

import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/** Send an SMS to the user's phone number from the DB. */
export async function sendSmsNotification(userId: number, message: string) {
    // Reads users.phone — DB-Scope should detect this as an app dependency
    const result = await pool.query(
        `SELECT phone FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [userId]
    );
    const phoneNumber = result.rows[0]?.phone;

    if (!phoneNumber) {
        console.warn(`No phone number for user ${userId}`);
        return;
    }

    // SMS dispatch (placeholder)
    console.log(`Sending SMS to ${phoneNumber}: ${message}`);
}

/** Send an email notification to the user. */
export async function sendEmailNotification(userId: number, subject: string, body: string) {
    const result = await pool.query(
        `SELECT email, first_name FROM users WHERE id = $1`,
        [userId]
    );
    const user = result.rows[0];
    if (!user) return;

    console.log(`Sending email to ${user.email}: [${subject}]`);
}

/** Bulk notify users of an order status change. */
export async function notifyOrderStatusChange(orderId: number, newStatus: string) {
    const result = await pool.query(
        `SELECT u.email, u.phone, u.first_name
         FROM orders o
         JOIN users u ON u.id = o.user_id
         WHERE o.id = $1`,
        [orderId]
    );
    const user = result.rows[0];
    if (!user) return;

    // Uses both email and phone — doubly dependent on users.phone
    await sendEmailNotification(user.id, 'Order Update', `Your order is now ${newStatus}`);
    await sendSmsNotification(user.id, `Order #${orderId} is now ${newStatus}`);
}
