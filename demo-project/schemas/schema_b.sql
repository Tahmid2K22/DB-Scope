-- ============================================================
--  DB-Scope Demo: Schema B  (staging snapshot, different team)
--  Use this file as "Schema B" in the Merge Conflict Analyzer
--  Intentional conflicts vs schema_a.sql for demo purposes
-- ============================================================

CREATE TABLE users (
    id          SERIAL PRIMARY KEY,
    first_name  VARCHAR(100) NOT NULL,          -- wider than Schema A (50)
    last_name   VARCHAR(100),                   -- missing in Schema A
    email       VARCHAR(255) UNIQUE NOT NULL,
    phone       VARCHAR(30),                    -- wider than Schema A (20)
    is_verified BOOLEAN DEFAULT FALSE,          -- missing in Schema A
    created_at  TIMESTAMP DEFAULT NOW()
    -- note: no updated_at, no deleted_at, no fname, no email_address, no mobile
);

CREATE TABLE orders (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    status      VARCHAR(30) DEFAULT 'pending',  -- wider than Schema A (20)
    total_amount DECIMAL(14, 2) NOT NULL,       -- different precision than Schema A
    currency    VARCHAR(3) DEFAULT 'USD',
    discount    DECIMAL(10, 2) DEFAULT 0,       -- missing in Schema A
    created_at  TIMESTAMP DEFAULT NOW(),
    fulfilled_at TIMESTAMP                      -- missing in Schema A
);

CREATE TABLE order_items (
    id          SERIAL PRIMARY KEY,
    order_id    INTEGER NOT NULL REFERENCES orders(id),  -- no ON DELETE CASCADE
    product_id  INTEGER NOT NULL,
    qty         INTEGER NOT NULL DEFAULT 1,     -- renamed from quantity
    unit_price  DECIMAL(10, 2) NOT NULL,
    discount_pct DECIMAL(5, 2) DEFAULT 0        -- missing in Schema A
);

CREATE TABLE products (
    id          SERIAL PRIMARY KEY,
    sku         VARCHAR(100) UNIQUE NOT NULL,
    name        VARCHAR(255) NOT NULL,
    description TEXT,
    price       DECIMAL(10, 2) NOT NULL,
    sale_price  DECIMAL(10, 2),                 -- missing in Schema A
    stock       INTEGER NOT NULL DEFAULT 0,
    category_id INTEGER,
    is_active   BOOLEAN DEFAULT TRUE            -- missing in Schema A
);

CREATE TABLE inventory (                        -- entirely missing in Schema A
    id          SERIAL PRIMARY KEY,
    product_id  INTEGER NOT NULL REFERENCES products(id),
    warehouse   VARCHAR(100),
    quantity    INTEGER NOT NULL DEFAULT 0,
    updated_at  TIMESTAMP DEFAULT NOW()
);

-- note: sessions and audit_log tables are missing in Schema B
