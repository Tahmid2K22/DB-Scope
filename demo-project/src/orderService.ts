/**
 * orderService.ts
 * Order lifecycle management.
 *
 * DB-Scope dependency demo:
 *   - References orders, order_items, products, users tables
 *   - Uses audit_log for change tracking
 */

import { Pool, PoolClient } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export interface OrderLine {
    productId: number;
    quantity: number;
    unitPrice: number;
}

// ── Create ────────────────────────────────────────────────────────────────────

export async function createOrder(userId: number, lines: OrderLine[]) {
    const client: PoolClient = await pool.connect();
    try {
        await client.query('BEGIN');

        const total = lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);

        const orderRes = await client.query(
            `INSERT INTO orders (user_id, total_amount, status)
             VALUES ($1, $2, 'pending')
             RETURNING id`,
            [userId, total]
        );
        const orderId: number = orderRes.rows[0].id;

        for (const line of lines) {
            await client.query(
                `INSERT INTO order_items (order_id, product_id, quantity, unit_price)
                 VALUES ($1, $2, $3, $4)`,
                [orderId, line.productId, line.quantity, line.unitPrice]
            );
            // Decrement stock
            await client.query(
                `UPDATE products SET stock = stock - $1 WHERE id = $2`,
                [line.quantity, line.productId]
            );
        }

        // Write audit trail
        await client.query(
            `INSERT INTO audit_log (table_name, record_id, action, changed_by, payload)
             VALUES ('orders', $1, 'INSERT', $2, $3)`,
            [orderId, userId, JSON.stringify({ total, lines })]
        );

        await client.query('COMMIT');
        return orderId;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// ── Read ─────────────────────────────────────────────────────────────────────

export async function getOrderWithItems(orderId: number) {
    const orderRes = await pool.query(
        `SELECT o.*, u.email, u.first_name, u.last_name
         FROM orders o
         JOIN users u ON u.id = o.user_id
         WHERE o.id = $1`,
        [orderId]
    );
    if (!orderRes.rows[0]) return null;

    const itemsRes = await pool.query(
        `SELECT oi.*, p.name AS product_name, p.sku
         FROM order_items oi
         JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = $1`,
        [orderId]
    );

    return { ...orderRes.rows[0], items: itemsRes.rows };
}

export async function getOrdersByUser(userId: number) {
    const result = await pool.query(
        `SELECT id, status, total_amount, currency, created_at
         FROM orders
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [userId]
    );
    return result.rows;
}

// ── Dangerous queries for diagnostics demo ───────────────────────────────────

/** ⚠️  DB-Scope will flag: DELETE without WHERE clause */
export async function clearAllTestOrders() {
    // This runs in test environments — but DB-Scope will still warn
    await pool.query(`DELETE FROM order_items`);
    await pool.query(`DELETE FROM orders`);
}
