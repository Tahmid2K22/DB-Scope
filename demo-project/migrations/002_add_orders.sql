-- ============================================================
--  Migration 002 — Add orders + order_items tables
--  Run: psql -d myapp -f 002_add_orders.sql
-- ============================================================

ALTER TABLE users
    ADD COLUMN first_name  VARCHAR(50),
    ADD COLUMN last_name   VARCHAR(50),
    ADD COLUMN phone       VARCHAR(20),
    ADD COLUMN updated_at  TIMESTAMP DEFAULT NOW();

CREATE TABLE orders (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    status       VARCHAR(20) DEFAULT 'pending',
    total_amount DECIMAL(12, 2) NOT NULL,
    currency     VARCHAR(3) DEFAULT 'USD',
    created_at   TIMESTAMP DEFAULT NOW()
);

CREATE TABLE order_items (
    id         SERIAL PRIMARY KEY,
    order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity   INTEGER NOT NULL DEFAULT 1,
    unit_price DECIMAL(10, 2) NOT NULL
);

CREATE INDEX idx_orders_user_id  ON orders(user_id);
CREATE INDEX idx_orders_status   ON orders(status);
