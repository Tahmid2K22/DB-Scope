-- ============================================================
--  DB-Scope Demo: Schema A  (production snapshot v1.4)
--  Use this file as "Schema A" in the Merge Conflict Analyzer
-- ============================================================

CREATE TABLE users (
    id          SERIAL PRIMARY KEY,
    fname       VARCHAR(50) NOT NULL,           -- duplicate candidate: fname vs first_name
    first_name  VARCHAR(50),                    -- duplicate candidate
    email       VARCHAR(255) UNIQUE NOT NULL,
    email_address VARCHAR(255),                 -- duplicate candidate: email vs email_address
    phone       VARCHAR(20),                    -- at-risk: several services query this
    mobile      VARCHAR(20),                    -- duplicate candidate: phone vs mobile
    created_at  TIMESTAMP DEFAULT NOW(),
    updated_at  TIMESTAMP DEFAULT NOW(),
    deleted_at  TIMESTAMP                       -- soft-delete column
);

CREATE TABLE orders (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    status      VARCHAR(20) DEFAULT 'pending',
    total_amount DECIMAL(12, 2) NOT NULL,
    currency    VARCHAR(3) DEFAULT 'USD',
    created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE order_items (
    id          SERIAL PRIMARY KEY,
    order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id  INTEGER NOT NULL,
    quantity    INTEGER NOT NULL DEFAULT 1,
    unit_price  DECIMAL(10, 2) NOT NULL
);

CREATE TABLE products (
    id          SERIAL PRIMARY KEY,
    sku         VARCHAR(100) UNIQUE NOT NULL,
    name        VARCHAR(255) NOT NULL,
    description TEXT,
    price       DECIMAL(10, 2) NOT NULL,
    stock       INTEGER NOT NULL DEFAULT 0,
    category_id INTEGER
);

CREATE TABLE sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       VARCHAR(512) NOT NULL,
    expires_at  TIMESTAMP NOT NULL,
    created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE audit_log (
    id          BIGSERIAL PRIMARY KEY,
    table_name  VARCHAR(100) NOT NULL,
    record_id   INTEGER,
    action      VARCHAR(10) NOT NULL,   -- INSERT / UPDATE / DELETE
    changed_by  INTEGER REFERENCES users(id),
    changed_at  TIMESTAMP DEFAULT NOW(),
    payload     JSONB
);
