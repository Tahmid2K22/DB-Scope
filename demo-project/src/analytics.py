"""
analytics.py
Data analytics and reporting module.

DB-Scope dependency demo:
  - References users.phone for SMS campaign segmentation
  - References orders table for revenue reports
  - Uses products table for inventory analysis
"""

import os
import psycopg2

DB_URL = os.environ.get("DATABASE_URL", "postgresql://localhost/myapp")


def get_connection():
    return psycopg2.connect(DB_URL)


# ── User Analytics ────────────────────────────────────────────────────────────

def get_users_with_phone():
    """
    Returns all users that have a phone number.
    DB-Scope: references users.phone — breaks after migration 003.
    """
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("""
        SELECT id, email, phone
        FROM users
        WHERE phone IS NOT NULL
          AND deleted_at IS NULL
        ORDER BY created_at DESC
    """)
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return rows


def sms_campaign_segment(min_orders: int = 1):
    """
    Build SMS campaign list: users with phone + at least N orders.
    DB-Scope: joins users.phone with orders — doubly dependent.
    """
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("""
        SELECT u.id, u.first_name, u.phone, COUNT(o.id) AS order_count
        FROM users u
        JOIN orders o ON o.user_id = u.id
        WHERE u.phone IS NOT NULL
        GROUP BY u.id, u.first_name, u.phone
        HAVING COUNT(o.id) >= %s
        ORDER BY order_count DESC
    """, (min_orders,))
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return rows


# ── Revenue Reports ───────────────────────────────────────────────────────────

def monthly_revenue():
    """Revenue aggregation by month across orders table."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("""
        SELECT DATE_TRUNC('month', created_at) AS month,
               SUM(total_amount) AS revenue,
               COUNT(*) AS order_count
        FROM orders
        WHERE status = 'completed'
        GROUP BY 1
        ORDER BY 1 DESC
    """)
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return rows


def top_products_by_revenue(limit: int = 10):
    """Top products by total revenue."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("""
        SELECT p.name, p.sku,
               SUM(oi.quantity * oi.unit_price) AS total_revenue
        FROM order_items oi
        JOIN products p ON p.id = oi.product_id
        GROUP BY p.id, p.name, p.sku
        ORDER BY total_revenue DESC
        LIMIT %s
    """, (limit,))
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return rows


# ── Dangerous Queries (Diagnostics Demo) ─────────────────────────────────────

def reset_test_data():
    """
    ⚠️  DB-Scope should flag both of these:
      1. DELETE without WHERE
      2. TRUNCATE on audit_log
    """
    conn = get_connection()
    cur = conn.cursor()
    # Dangerous: no WHERE clause
    cur.execute("DELETE FROM order_items")
    cur.execute("DELETE FROM orders")
    # Dangerous: wipes audit trail
    cur.execute("TRUNCATE audit_log")
    conn.commit()
    cur.close()
    conn.close()
