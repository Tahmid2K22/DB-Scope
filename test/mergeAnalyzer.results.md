# DB-Scope — Test Results Report

**Suite:** `mergeAnalyzer` Bob Bridge + BlastRadius + HoverProvider  
**Run command:** `node src/mergeAnalyzer/mergeAnalyzer.test.js && node test/member1.run.test.js`  
**Total tests:** 169 | **Passed:** 169 ✅ | **Failed:** 0 ❌

---

## Suite A — `src/mergeAnalyzer/mergeAnalyzer.test.js`

Tests the pure logic of [`bobBridge.ts`](../src/mergeAnalyzer/bobBridge.ts): conflict ID
generation, semantic filtering, JSON extraction from Bob stdout, prompt building,
and resolution merging. No VS Code host or compile step required.

**31 / 31 passed**

---

### Section 1 — `conflictId()`

| # | Test | Input | Expected Output | Result |
|---|------|-------|-----------------|--------|
| 1-01 | Column conflict includes column | `{ conflictType: 'missing_column', table: 'users', column: 'email' }` | `"missing_column::users::email"` | ✅ |
| 1-02 | Table conflict omits column | `{ conflictType: 'missing_table', table: 'orders' }` | `"missing_table::orders"` | ✅ |
| 1-03 | type_mismatch includes column | `{ conflictType: 'type_mismatch', table: 'products', column: 'price' }` | `"type_mismatch::products::price"` | ✅ |

---

### Section 2 — `filterSemanticallyRelevant()`

| # | Test | Input | Expected Output | Result |
|---|------|-------|-----------------|--------|
| 2-01 | All five semantic types are kept | Array of 5 conflicts: `missing_column`, `missing_table`, `type_mismatch`, `nullable_difference`, `name_conflict` | Array length = 5 | ✅ |
| 2-02 | Empty array returns empty | `[]` | `[]` | ✅ |
| 2-03 | Unknown type is excluded | `[{ conflictType: 'totally_made_up' }, { conflictType: 'missing_column' }]` | Array length = 1, `table = 'bar'` | ✅ |

---

### Section 3 — `extractJson()` — Raw JSON

| # | Test | Input (Bob stdout) | Expected Output | Result |
|---|------|-------------------|-----------------|--------|
| 3-01 | Valid raw JSON array parsed correctly | `[{ conflictId: "missing_column::users::name", resolution: "rename", confidence: 0.92, ... }]` | Array length = 1, `conflictId = "missing_column::users::name"`, `resolution = "rename"`, `confidence = 0.92` | ✅ |
| 3-02 | Empty string returns null | `""` | `null` | ✅ |
| 3-03 | Whitespace-only returns null | `"   \n  "` | `null` | ✅ |
| 3-04 | No JSON array brackets returns null | `"Bob says: no conflicts found."` | `null` | ✅ |
| 3-05 | Malformed JSON returns null | `'[{"key": value_no_quotes}]'` | `null` | ✅ |
| 3-06 | JSON object (not array) returns null | `'{"key": "value"}'` | `null` | ✅ |

---

### Section 4 — `extractJson()` — Markdown-Wrapped Output

| # | Test | Input (Bob stdout) | Expected Output | Result |
|---|------|-------------------|-----------------|--------|
| 4-01 | ` ```json ` fence stripped and parsed | ` ```json\n[...]\n``` ` | Array length = 1, `conflictId` present | ✅ |
| 4-02 | Plain ` ``` ` fence stripped and parsed | ` ```\n[...]\n``` ` | Array length = 1 | ✅ |
| 4-03 | CLI preamble before array ignored | `"Analyzing repository...\nDone.\n[...]"` | Array length = 1, `resolution = "rename"` | ✅ |
| 4-04 | CLI preamble AND markdown fence both handled | `"bob: running analysis\n```json\n[...]\n```\nbob: done"` | Array length = 1 | ✅ |
| 4-05 | First `[` to last `]` captures outer array | `[{ conflictId: ..., affectedFiles: [...] }]` | Array length = 1 | ✅ |

---

### Section 5 — `buildBobPrompt()`

**Schemas used:**
```
Schema A: db_a — tables: users, orders
Schema B: db_b — tables: users, customers
Conflict: missing_column on users.name
```

| # | Test | What is checked in prompt | Expected | Result |
|---|------|--------------------------|----------|--------|
| 5-01 | Prompt contains workspace root | `/workspace/myproject` present in output | ✅ found | ✅ |
| 5-02 | Prompt contains conflictId | `"missing_column::users::name"` present | ✅ found | ✅ |
| 5-03 | Prompt contains schema table lists | `db_a`, `db_b`, `orders`, `customers` all present | ✅ all found | ✅ |
| 5-04 | Prompt contains source descriptions | `Column "name" exists in A` and `Column "name" does not exist in B` present | ✅ both found | ✅ |

**Sample generated prompt (truncated):**
```
You are analyzing database schema merge conflicts inside the DB-Scope VS Code extension.

Repository root: /ws
Schema A (database: db_a) tables: users, orders
Schema B (database: db_b) tables: users, customers

Conflicts to analyze:
  conflictId: "missing_column::users::name"
  type: missing_column
  location: users.name
  sourceA: Column "name" exists in A
  sourceB: Column "name" does not exist in B
  deterministicSuggestion: ALTER TABLE users ADD COLUMN name VARCHAR
```

---

### Section 6 — `applyBobResolutions()`

**Base conflicts:**
```
1. missing_column — users.name  (suggestion: "Original deterministic suggestion")
2. missing_table  — orders      (suggestion: "Create table orders")
```

**Bob resolutions provided:**
```json
[{
  "conflictId": "missing_column::users::name",
  "resolution": "rename",
  "confidence": 0.92,
  "reason": "Likely rename to full_name",
  "affectedFiles": [
    { "path": "src/models/User.ts",   "reason": "references users.name" },
    { "path": "src/routes/users.ts",  "reason": "API response shape" }
  ],
  "migrationPlan": ["Rename users.name to users.full_name", "Update ORM model"]
}]
```

| # | Test | Input variation | Expected Output | Actual Output | Result |
|---|------|----------------|-----------------|---------------|--------|
| 6-01 | Enriched conflict replaces suggestion | Full resolution above | Suggestion starts with `[Bob 92% confidence — rename]` | `[Bob 92% confidence — rename] Likely rename to full_name Affects 2 file(s): ...` | ✅ |
| 6-02 | Suggestion includes affected files count | 2 affected files | `"Affects 2 file(s)"` in suggestion | ✅ present | ✅ |
| 6-03 | SQL annotated with migration plan | migrationPlan has 2 steps | SQL starts with `-- Migration: Rename users.name to users.full_name → Update ORM model` then original ALTER | ✅ present | ✅ |
| 6-04 | Un-matched conflict unchanged | `orders` has no resolution | suggestion = `"Create table orders"`, SQL = original CREATE TABLE | ✅ unchanged | ✅ |
| 6-05 | Empty resolutions — all unchanged | `resolutions = []` | Both conflicts keep original suggestions | ✅ both unchanged | ✅ |
| 6-06 | No affected files — no "Affects" text | `affectedFiles: []` | `"Affects"` NOT in suggestion | ✅ absent | ✅ |
| 6-07 | No migration plan — no `-- Migration:` | `migrationPlan: []` | `"-- Migration:"` NOT in SQL | ✅ absent | ✅ |
| 6-08 | More than 3 files — ellipsis appended | 4 affected files (a.ts, b.ts, c.ts, d.ts) | `"..."` in suggestion after 3rd file | `Affects 4 file(s): a.ts, b.ts, c.ts...` | ✅ |
| 6-09 | Confidence 1.0 renders as 100% | `confidence: 1.0` | `"100%"` in suggestion | `[Bob 100% confidence — rename]` | ✅ |
| 6-10 | Confidence 0.0 renders as 0% | `confidence: 0.0` | `"0%"` in suggestion | `[Bob 0% confidence — rename]` | ✅ |

---

## Suite B — `test/member1.run.test.js`

Tests the pure logic of [`sqlParser.ts`](../src/utils/sqlParser.ts),
[`blastRadiusAnalyzer.ts`](../src/blastRadius/blastRadiusAnalyzer.ts), and
[`sqlHoverProvider.ts`](../src/hoverProvider/sqlHoverProvider.ts).
No VS Code host required.

**138 / 138 passed**

---

### Section 1 — `parseSql()`

| # | Test | Input SQL | Expected Output | Result |
|---|------|-----------|-----------------|--------|
| 1-01 | SELECT: operation=SELECT, isDestructive=false | `SELECT * FROM users` | `{ operation: 'SELECT', isDestructive: false }` | ✅ |
| 1-02 | INSERT: extracts table from INTO | `INSERT INTO orders (id) VALUES (1)` | `tables: ['orders']` | ✅ |
| 1-03 | UPDATE: isDestructive=false | `UPDATE users SET name='x'` | `{ operation: 'UPDATE', isDestructive: false }` | ✅ |
| 1-04 | DELETE: isDestructive=true | `DELETE FROM orders` | `{ operation: 'DELETE', isDestructive: true }` | ✅ |
| 1-05 | ALTER: isDestructive=true | `ALTER TABLE users ADD COLUMN x INT` | `{ operation: 'ALTER', isDestructive: true }` | ✅ |
| 1-06 | DROP TABLE: tables=[users] | `DROP TABLE users` | `{ operation: 'DROP', tables: ['users'] }` | ✅ |
| 1-07 | CREATE TABLE: operation=CREATE | `CREATE TABLE products (id INT)` | `{ operation: 'CREATE' }` | ✅ |
| 1-08 | TRUNCATE: isDestructive=true | `TRUNCATE TABLE logs` | `{ isDestructive: true }` | ✅ |
| 1-09 | EXPLAIN → UNKNOWN | `EXPLAIN SELECT * FROM users` | `{ operation: 'UNKNOWN' }` | ✅ |
| 1-10 | Schema-qualified strips prefix | `SELECT * FROM public.orders WHERE id = 1` | `tables: ['orders']`, no `'public'` | ✅ |
| 1-11 | JOIN extracts both tables | `SELECT * FROM users JOIN orders ON users.id = orders.user_id` | `tables` includes `users` and `orders` | ✅ |
| 1-12 | Duplicate table deduplicated | SQL referencing same table twice | `tables` length = 1 | ✅ |
| 1-13 | Mixed-case keywords parsed | `select * FROM Users` | `operation: 'SELECT'` | ✅ |
| 1-14 | extractColumns: ADD/DROP captured | `ALTER TABLE users ADD COLUMN phone VARCHAR DROP COLUMN fax` | `columns: ['phone', 'fax']` | ✅ |
| 1-15 | rawSql preserved verbatim | Input with extra whitespace | `rawSql` unchanged | ✅ |
| 1-16 | SQL keywords not as table names | `SELECT ... GROUP BY status` | `GROUP`, `BY`, `WHERE` NOT in tables | ✅ |
| 1-17 | DROP INDEX: operation=DROP | `DROP INDEX idx_email` | `{ operation: 'DROP' }` | ✅ |
| 1-18 | CREATE UNIQUE INDEX: table via ON | `CREATE UNIQUE INDEX idx ON users(email)` | `tables: ['users']` | ✅ |

---

### Section 2 — `analyzeSchemaImpact()`

| # | Test | Input SQL | Expected Output | Result |
|---|------|-----------|-----------------|--------|
| 2-01 | DROP TABLE → breaking change | `DROP TABLE users` | `breakingChanges.length >= 1` | ✅ |
| 2-02 | ALTER DROP COLUMN → breaking | `ALTER TABLE users DROP COLUMN phone` | `breakingChanges` contains DROP COLUMN | ✅ |
| 2-03 | ADD COLUMN nullable → non-breaking | `ALTER TABLE users ADD COLUMN nickname VARCHAR(100)` | `breakingChanges = []`, `nonBreakingChanges.length >= 1` | ✅ |
| 2-04 | ADD COLUMN NOT NULL no DEFAULT → breaking | `ALTER TABLE users ADD COLUMN score INT NOT NULL` | `breakingChanges.length >= 1` | ✅ |
| 2-05 | ADD COLUMN NOT NULL WITH DEFAULT → non-breaking | `ALTER TABLE users ADD COLUMN score INT NOT NULL DEFAULT 0` | `breakingChanges = []`, `nonBreakingChanges.length >= 1` | ✅ |
| 2-06 | ALTER RENAME COLUMN → breaking | `ALTER TABLE users RENAME COLUMN name TO full_name` | `breakingChanges.length >= 1` | ✅ |
| 2-07 | ALTER MODIFY → breaking | `ALTER TABLE users MODIFY COLUMN email TEXT` | `breakingChanges.length >= 1` | ✅ |
| 2-08 | DELETE → breaking | `DELETE FROM orders` | `breakingChanges.length >= 1` | ✅ |
| 2-09 | TRUNCATE → breaking | `TRUNCATE TABLE logs` | `breakingChanges.length >= 1` | ✅ |
| 2-10 | CASCADE FK appears in cascadeEffects | `DROP TABLE users` (orders.user_id FK → users.id) | `cascadeEffects` contains orders reference | ✅ |
| 2-11 | Unknown table → no cascade | `DROP TABLE ghost_table` | `cascadeEffects = []` | ✅ |
| 2-12 | SELECT → empty arrays | `SELECT * FROM users` | `breakingChanges = []`, `nonBreakingChanges = []` | ✅ |

---

### Section 3 — `assessDataIntegrityRisks()`

| # | Test | Input SQL | Expected Risk | Result |
|---|------|-----------|---------------|--------|
| 3-01 | DELETE without WHERE → critical | `DELETE FROM orders` | `severity: 'critical'` | ✅ |
| 3-02 | DELETE with WHERE → no critical | `DELETE FROM orders WHERE status = 'cancelled'` | No critical risks | ✅ |
| 3-03 | UPDATE without WHERE → critical | `UPDATE users SET active = false` | `severity: 'critical'` | ✅ |
| 3-04 | UPDATE with WHERE → no critical | `UPDATE users SET active = false WHERE id = 1` | No critical risks | ✅ |
| 3-05 | ALTER DROP COLUMN → high | `ALTER TABLE users DROP COLUMN phone` | `severity: 'high'` | ✅ |
| 3-06 | NOT NULL without DEFAULT → high | `ALTER TABLE users ALTER COLUMN score SET NOT NULL` | `severity: 'high'` | ✅ |
| 3-07 | CASCADE keyword → medium | `DELETE FROM users CASCADE` | `severity: 'medium'` | ✅ |
| 3-08 | DROP FOREIGN KEY → high | `ALTER TABLE orders DROP FOREIGN KEY fk_user` | `severity: 'high'` | ✅ |
| 3-09 | DROP PRIMARY KEY → high | `ALTER TABLE users DROP PRIMARY KEY` | `severity: 'high'` | ✅ |
| 3-10 | CREATE UNIQUE INDEX → high | `CREATE UNIQUE INDEX idx_email ON users(email)` | `severity: 'high'` | ✅ |
| 3-11 | ENGINE= change → medium | `ALTER TABLE users ENGINE=InnoDB` | `severity: 'medium'` | ✅ |
| 3-12 | Safe SELECT → zero risks | `SELECT * FROM users` | `risks = []` | ✅ |
| 3-13 | Lowercase keywords trigger rules | `delete from orders` | `severity: 'critical'` | ✅ |

---

### Section 4 — `buildRollbackSuggestions()`

| # | Test | Input SQL | Expected Rollback | `safetyLevel` | Result |
|---|------|-----------|-------------------|---------------|--------|
| 4-01 | DROP TABLE (in schema) | `DROP TABLE users` | `CREATE TABLE users (id INTEGER NOT NULL PRIMARY KEY, ...)` | `manual_review` | ✅ |
| 4-02 | DROP TABLE (not in schema) | `DROP TABLE ghost` | Generic destructive warning | `destructive` | ✅ |
| 4-03 | DROP COLUMN (col in schema) | `ALTER TABLE users DROP COLUMN phone` | `ALTER TABLE users ADD COLUMN phone VARCHAR` | `safe` | ✅ |
| 4-04 | DROP COLUMN (col not in schema) | `ALTER TABLE users DROP COLUMN fax` | ADD COLUMN with `UNKNOWN` type | `manual_review` | ✅ |
| 4-05 | ADD COLUMN rollback | `ALTER TABLE users ADD COLUMN nickname VARCHAR` | `ALTER TABLE users DROP COLUMN nickname` | `safe` | ✅ |
| 4-06 | RENAME COLUMN rollback | `ALTER TABLE users RENAME COLUMN full_name TO name` | Reverse rename | `safe` | ✅ |
| 4-07 | RENAME TABLE rollback | `ALTER TABLE old_name RENAME TO new_name` | Reverse rename | `safe` | ✅ |
| 4-08 | CREATE INDEX rollback | `CREATE INDEX idx_email ON users(email)` | `DROP INDEX idx_email` | `safe` | ✅ |
| 4-09 | CREATE UNIQUE INDEX rollback | `CREATE UNIQUE INDEX idx ON users(email)` | `DROP INDEX idx` | `safe` | ✅ |
| 4-10 | DELETE rollback | `DELETE FROM orders WHERE id = 1` | Destructive — no auto rollback | `destructive` | ✅ |
| 4-11 | TRUNCATE rollback | `TRUNCATE TABLE logs` | Destructive — no auto rollback | `destructive` | ✅ |
| 4-12 | SELECT → empty rollbacks | `SELECT * FROM users` | `rollbacks = []` | — | ✅ |
| 4-13 | DROP TABLE CREATE has correct cols | `DROP TABLE users` (users has id INTEGER PK) | Generated SQL contains `id INTEGER NOT NULL PRIMARY KEY` | — | ✅ |

---

### Section 5 — `deriveModelName()`

| # | Input | Expected | Result |
|---|-------|----------|--------|
| 5-01 | `users` | `User` | ✅ |
| 5-02 | `orders` | `Order` | ✅ |
| 5-03 | `categories` | `Category` | ✅ |
| 5-04 | `order_items` | `OrderItem` | ✅ |
| 5-05 | `statuses` | `Status` | ✅ |
| 5-06 | `class` | `Class` (no strip — not a plural) | ✅ |
| 5-07 | `staff` | `Staff` (ends in double-s pattern — no strip) | ✅ |

---

### Section 6 — `classifyDepSeverity()`

| # | Input line | Expected Severity | Result |
|---|-----------|-------------------|--------|
| 6-01 | `await repo.delete(id)` | `critical` | ✅ |
| 6-02 | `dropTable("users")` | `critical` | ✅ |
| 6-03 | `truncate(tableName)` | `critical` | ✅ |
| 6-04 | `await userRepo.remove(user)` | `critical` | ✅ |
| 6-05 | `db.update("users", data)` | `high` | ✅ |
| 6-06 | `await insert(user)` | `high` | ✅ |
| 6-07 | `const r = db.select(users)` | `medium` | ✅ |
| 6-08 | `User.findOne({id})` | `medium` | ✅ |
| 6-09 | `const tableName = "users"` | `low` | ✅ |
| 6-10 | `""` (empty string) | `low` | ✅ |

---

### Section 7 — `getTableSizeFactor()`

| # | Table rows | Expected Multiplier | Result |
|---|-----------|---------------------|--------|
| 7-01 | > 1,000,000 | `1.5` | ✅ |
| 7-02 | > 100,000 | `1.25` | ✅ |
| 7-03 | > 10,000 | `1.1` | ✅ |
| 7-04 | < 10,000 | `1.0` | ✅ |
| 7-05 | Unknown table | `1.0` | ✅ |
| 7-06 | Empty table array | `1.0` | ✅ |
| 7-07 | Multiple tables — max chosen | `max(factors)` | ✅ |

---

### Section 8 — `scoreToLevel()`

| # | Score | Expected Level | Result |
|---|-------|----------------|--------|
| 8-01 | 10 | `critical` | ✅ |
| 8-02 | 8 | `critical` | ✅ |
| 8-03 | 7 | `high` | ✅ |
| 8-04 | 6 | `high` | ✅ |
| 8-05 | 5 | `medium` | ✅ |
| 8-06 | 4 | `medium` | ✅ |
| 8-07 | 3 | `low` | ✅ |
| 8-08 | 1 | `low` | ✅ |

---

### Section 9 — `calculateRiskScore()`

| # | Test | Input | Expected | Result |
|---|------|-------|----------|--------|
| 9-01 | All empty → minimum 1 | No breaking changes, no risks, no deps, no docs | Score = 1 | ✅ |
| 9-02 | 2 breaking changes → score >= 4 | 2 breaking changes | Score >= 4 | ✅ |
| 9-03 | Breaking changes capped at 4 pts | 3 breaking changes (same as 2) | Score same as 2 breaking | ✅ |
| 9-04 | 2 critical data risks → +2 pts | 2 critical risks | Contributes 2 pts | ✅ |
| 9-05 | Large table applies 1.5× multiplier | orders table (>1M rows) vs tiny table | Large table score > tiny table score | ✅ |
| 9-06 | Score never exceeds 10 | All dimensions maxed out | Score = 10 | ✅ |
| 9-07 | Score never below 1 | All dimensions zero | Score = 1 | ✅ |
| 9-08 | Docs drift capped at 1 pt | 4 docs vs 8 docs | Same score | ✅ |

---

### Section 10 — `buildSuggestions()`

| # | Test | Condition | Expected Suggestion | Result |
|---|------|-----------|---------------------|--------|
| 10-01 | NOT NULL breaking change | `breakingChanges` contains NOT NULL | "nullable first" suggestion | ✅ |
| 10-02 | DROP breaking change | `breakingChanges` contains DROP | "rename first" suggestion | ✅ |
| 10-03 | DELETE without WHERE risk | Data risk contains WHERE | "add WHERE clause" suggestion | ✅ |
| 10-04 | > 5 app dependencies | 6 deps | "update N files" suggestion | ✅ |
| 10-05 | Score >= 7 | riskScore = 8 | "DBA approval required" suggestion | ✅ |
| 10-06 | Score < 7, no hazards | riskScore = 3, no breaking/risks | `suggestions = []` | ✅ |

---

### Section 11 — `exportResult()`

| # | Test | Input | Expected Output | Result |
|---|------|-------|-----------------|--------|
| 11-01 | Creates file in target dir | `BlastRadiusResult` + temp dir | File exists at target path | ✅ |
| 11-02 | Exported file is valid JSON | Written file | `JSON.parse()` succeeds, values match | ✅ |
| 11-03 | Filename contains table name | `affectedTables: ['users']` | Filename contains `users` and `.json` | ✅ |
| 11-04 | No tables → filename uses "unknown" | `affectedTables: []` | Filename contains `unknown` | ✅ |

---

### Section 12 — `HoverProvider.extractSqlFromString()`

| # | Test | Input | Expected Output | Result |
|---|------|-------|-----------------|--------|
| 12-01 | Double-quoted SQL | `const q = "SELECT * FROM users"` | `SELECT * FROM users` | ✅ |
| 12-02 | Single-quoted SQL | `db.query('DELETE FROM logs')` | `DELETE FROM logs` | ✅ |
| 12-03 | Backtick single-line SQL | `` `DROP TABLE tmp` `` | `DROP TABLE tmp` | ✅ |
| 12-04 | Multi-line template literal | `` `SELECT *\n  FROM orders\n  WHERE id = 1` `` | Full multi-line SQL | ✅ |
| 12-05 | Template literal with `${}` | `` `SELECT * FROM ${table}` `` | `SELECT * FROM ?` (interpolations replaced) | ✅ |
| 12-06 | No SQL keyword | `"hello world"` | `null` | ✅ |
| 12-07 | Empty string | `""` | `null` | ✅ |
| 12-08 | UPDATE in double quotes | `"UPDATE users SET name='x'"` | `UPDATE users SET name='x'` | ✅ |

---

### Section 13 — `HoverProvider.extractStatementAt()`

| # | Test | Input text | Cursor offset | Expected | Result |
|---|------|-----------|---------------|----------|--------|
| 13-01 | Single statement | `SELECT * FROM users` | middle | Full statement | ✅ |
| 13-02 | Two statements — offset in 2nd | `SELECT 1; DROP TABLE x` | offset 12 | `DROP TABLE x` | ✅ |
| 13-03 | Cursor at offset 0 | `SELECT 1; DROP TABLE x` | 0 | `SELECT 1` | ✅ |
| 13-04 | Only semicolons (empty stmt) | `;;;` | any | `null` | ✅ |
| 13-05 | No semicolons | `SELECT * FROM users` | any | Whole trimmed text | ✅ |

---

### Section 14 — `riskEmoji()`

| # | Input | Expected | Result |
|---|-------|----------|--------|
| 14-01 | `'low'` | `🟢` | ✅ |
| 14-02 | `'medium'` | `🟡` | ✅ |
| 14-03 | `'high'` | `🟠` | ✅ |
| 14-04 | `'critical'` | `🔴` | ✅ |

---

### Section 15 — `HoverProvider.buildHoverText()`

**High-risk result used (score 8/10, critical, table: orders):**

| # | Test | Condition | Expected in hover text | Result |
|---|------|-----------|------------------------|--------|
| 15-01 | Contains risk score | riskScore = 8 | `"8/10"` | ✅ |
| 15-02 | Contains risk level | riskLevel = critical | `"CRITICAL"` | ✅ |
| 15-03 | Contains affected table | tables = ['orders'] | `"orders"` | ✅ |
| 15-04 | Breaking Changes section rendered | 1 breaking change | `"Breaking Changes"` section present | ✅ |
| 15-05 | Data Risks section rendered | 1 data risk | `"Data Risks"` section present | ✅ |
| 15-06 | Cascade Effects section rendered | 1 cascade effect | `"Cascade"` section present | ✅ |
| 15-07 | Suggestions section rendered | 1 suggestion | `"Suggestions"` section present | ✅ |
| 15-08 | Rollback section rendered | 1 rollback | `"Rollback"` section present | ✅ |
| 15-09 | Safe rollback shows ✅ icon | `safetyLevel: 'safe'` | `✅` in rollback line | ✅ |
| 15-10 | Low-risk: no Breaking Changes | score 2, no breaking | `"Breaking Changes"` NOT in hover | ✅ |
| 15-11 | Low-risk: no Rollback section | score 2, no rollbacks | `"Rollback"` NOT in hover | ✅ |
| 15-12 | "Open Full Analysis" link always present | any result | Link present | ✅ |
| 15-13 | Rollback SQL truncated to 80 chars | SQL > 80 chars | Truncated at 80 | ✅ |
| 15-14 | manual_review rollback shows ⚠️ | `safetyLevel: 'manual_review'` | `⚠️` in rollback line | ✅ |
| 15-15 | Destructive rollback shows 🔴 | `safetyLevel: 'destructive'` | `🔴` in rollback line | ✅ |

---

## Final Summary

```
Suite A — mergeAnalyzer (Bob Bridge)     31 /  31  ✅
Suite B — member1 (BlastRadius + Hover) 138 / 138  ✅
─────────────────────────────────────────────────────
TOTAL                                   169 / 169  ✅  0 ❌
```

Run date: generated by `node src/mergeAnalyzer/mergeAnalyzer.test.js && node test/member1.run.test.js`
