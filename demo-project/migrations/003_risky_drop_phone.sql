-- ============================================================
--  Migration 003 — ⚠️  RISKY: Drop phone column from users
--
--  DB-Scope should flag this as HIGH RISK because:
--    - userService.ts queries users.phone (line 42)
--    - notificationService.ts queries users.phone (line 88)
--    - profileController.ts references phone in SELECT (line 17)
--    - Python analytics script uses users.phone for SMS campaigns
--
--  Hover over the ALTER TABLE below to see the impact report.
--  Right-click → "DB-Scope: Analyze Migration Impact" for full report.
-- ============================================================

ALTER TABLE users DROP COLUMN phone;

-- Also dangerous — no WHERE clause will wipe all session data
DELETE FROM sessions;

-- Also dangerous — truncates entire audit trail
TRUNCATE audit_log;
