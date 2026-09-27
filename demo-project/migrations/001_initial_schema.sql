-- ============================================================
--  Migration 001 — Initial schema setup
--  Run: psql -d myapp -f 001_initial_schema.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
    id         SERIAL PRIMARY KEY,
    email      VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
    id    SERIAL PRIMARY KEY,
    name  VARCHAR(255) NOT NULL,
    price DECIMAL(10, 2) NOT NULL
);
