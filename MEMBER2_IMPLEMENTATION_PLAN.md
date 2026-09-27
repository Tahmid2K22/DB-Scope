# Member 2 Implementation Plan — DB-Scope

> **Author:** IBM Bob Agent  
> **Date:** 2025-01-27  
> **Target:** Member 2 Responsibilities — ContextManager, SqlDiagnosticProvider, DuplicateDetector  
> **Verification Status:** All tests passing ✅

---

## Overview

This document details the full implementation of Member 2's components in the DB-Scope VS Code extension. The implementation follows a phased approach ensuring TypeScript compilation success at each step.

---

## Phase 1: Shared Core Types (`src/core/types.ts`)

### New Types Added

| Type | Purpose |
|------|---------|
| `TableConstraint` | Represents a table-level SQL constraint (PK, FK, UNIQUE, CHECK) |
| `DatabaseSchema.source` | Provenance field (`'live' \| 'codebase' \| 'merged'`) for status bar display |
| `SqlDiagnostic.code` | Rule code field enabling CodeAction provider matching |
| `DuplicateTableGroup` | Entity-level duplicate detection result (Jaccard similarity) |
| `DuplicateSeverity` | Severity enum for duplicate findings |
| `MigrationScript` | Generated migration SQL (up + down) for consolidating duplicates |
| `ParsedAlterTable` | Parsed ALTER TABLE operation for incremental schema evolution |

---

## Phase 2: Schema Parser Module (`src/contextManager/schemaParsers.ts`)

### New Pure Module — ~850 lines, zero VS Code dependencies

#### Exported Functions

| Function | Description |
|----------|-------------|
| `splitStatements(sql)` | Splits SQL script into statements, respecting strings/comments/parens |
| `splitTopLevel(input, sep)` | Split on separator at depth-0 (ignores parens) |
| `normalizeIdentifier(raw)` | Strips quotes, schema prefix; folds to lowercase |
| `snakeCase(name)` | PascalCase → snake_case for ORM table naming |
| `pluralize(word)` | Singulars → plurals (handles y→ies, ss→sses) |
| `parseColumnDefinitions(defs)` | Parses comma-separated column definitions |
| `parseTableConstraint(chunk)` | Parses a single constraint chunk (PK/FK/UNIQUE/CHECK) |
| `parseSqlScript(sql)` | Full SQL script → MutableSchema (CREATE/ALTER/DROP/INDEX) |
| `applyAlterTable(stmt, tables)` | Incrementally mutates schema from ALTER TABLE |
| `mergeInto(target, addition)` | Existing-wins merge of two schemas |
| `mergeSchemas(live, codebase)` | Live-wins merge for final schema |
| `parseDjangoModels(content)` | Django models.py → MutableSchema |
| `parseTypeOrmEntities(content)` | TypeORM entity files → MutableSchema |
| `parsePrismaSchema(content)` | Prisma schema.prisma → MutableSchema |

#### Key Algorithm Details

**splitStatements**: Single-pass O(n) state machine handling:
- `--` line comments and `/* */` block comments (dropped from buffer)
- Single-quoted strings with `''` escape and backslash escapes
- Double-quoted identifiers with `""` escape  
- Backtick identifiers with double-backtick escape
- Dollar-quoted strings (`$$..$$` and `$tag$...$tag$`)
- Paren depth tracking (semicolon inside parens not a statement boundary)

**applyAlterTable dispatch ladder** (ordered to prevent mismatches):
1. RENAME TO (table rename)
2. DROP CONSTRAINT / DROP FOREIGN KEY / DROP PRIMARY KEY
3. ADD CONSTRAINT / ADD PRIMARY KEY / ADD FOREIGN KEY / ADD UNIQUE
4. RENAME COLUMN (PG + MySQL syntax)
5. CHANGE COLUMN (MySQL rename+redefine)
6. ALTER COLUMN ... (PG sub-forms: TYPE, SET/DROP NOT NULL, SET/DROP DEFAULT)
7. MODIFY COLUMN (MySQL/Oracle)
8. ADD COLUMN (with IF NOT EXISTS, parenthesized multi-add)
9. DROP COLUMN (with IF EXISTS)

**parsePrismaSchema two-pass**:
- Pass 1: collect model→table name maps and field→column @map overrides
- Pass 2: parse fields with FK resolution using collected maps

**parseDjangoModels two-pass**:
- Pass 1: collect class→table name maps
- Pass 2: parse fields resolving FK targets via class map

---

## Phase 2f: ContextManager Enhancements

### New Features

1. **Live DB integration**: `fetchLiveSchema()` connects via `dbAdapters.createAdapter()`, with configurable timeouts (`CONNECT_TIMEOUT_MS = 5000`, `EXTRACT_TIMEOUT_MS = 30000`). Redacts passwords in logs.

2. **`withTimeout<T>(promise, ms, label)`**: Generic timeout wrapper using `Promise.race()`.

3. **Parallel fetch**: `Promise.all([scanCodebase(), fetchLiveSchema()])` — codebase and live fetch run concurrently.

4. **Status bar state machine** with 5 states:
   - `idle` → `$(database) DB-Scope` with openDashboard command
   - `scanning` → `$(sync~spin) DB-Scope: Scanning…` (no command)
   - `ready` → `$(database) DB-Scope: N tables` with source annotation
   - `degraded` → `$(warning)` with warningBackground + retry command
   - `error` → `$(error)` with errorBackground + retry command

5. **Config change listener**: Re-fetches when `dbscope.connectionString` or `dbscope.dbType` changes.

6. **Two-pass ORM scanning**: Collects entity→table maps first, then full parse with FK resolution.

---

## Phase 3: SQL Diagnostics Enhancements

### `src/diagnostics/sqlTokenizer.ts` (NEW — pure module)

Produces two mask views in a single O(n) pass:
- **clauseMask**: All comments, string literals, double-quoted identifiers blanked → used for clause detection
- **parseMask**: Comments and single-quoted literals blanked; double-quoted/backtick identifiers preserved → used for table/column extraction

Exported: `maskSql()`, `splitSqlStatements()`, `hasClause()`, `extractCteNames()`, `extractTablesFromStatement()`, `extractWhereColumns()`, `extractSelectColumns()`, `extractSetColumns()`, `extractInsertColumns()`

### `src/diagnostics/schemaDiagnostics.ts` (NEW — pure module)

Schema-aware rules:
- **DBS-SCHEMA-001**: Non-existent table (with CTE name exclusion, IF EXISTS suppression)
- **DBS-SCHEMA-002**: Non-existent column (in WHERE/SET/SELECT/INSERT)
- **DBS-SCHEMA-003**: DROP COLUMN referenced by FK in another table
- **DBS-SCHEMA-004**: Duplicate column on ADD COLUMN (excluding IF NOT EXISTS)
- **DBS-SCHEMA-005**: NOT NULL without DEFAULT (severity escalates based on `rowCount`)

Pattern rules with proper codes: `DBS-DESTRUCT-001/002/003/004`, `DBS-PERF-001/002`, `DBS-BREAK-001`

### `SqlDiagnosticProvider` Rewrite

Key improvements:
- Uses `splitSqlStatements()` for multi-statement documents
- Runs pattern rules on clauseMask (no false positives from strings)
- Schema rules run per-statement with shared schema fetch
- Modal alerts: `{ modal: true }` only for DROP TABLE, TRUNCATE, DELETE without WHERE
- Session-level fingerprinted dedup (no repeat popups per statement)
- Triggered on open, save, edit (modals only on save/open/execute)

### `src/diagnostics/sqlCodeActionProvider.ts` (NEW)

Quick fixes:
1. `DBS-DESTRUCT-003/004` → Add `WHERE 1 = 0 /* TODO */`
2. `DBS-DESTRUCT-001` → Convert DROP TABLE to soft-delete (ADD deleted_at)
3. `DBS-SCHEMA-005` → Remove NOT NULL (make nullable)
4. `DBS-PERF-002` → Expand SELECT * with schema column list

---

## Phase 4: Duplicate Detector Enhancements

### Intra-Table Detection

Removed the `if (a.table === b.table) { continue; }` guard from `detectByEditDistance()`. Both synonym-group and edit-distance detection now find duplicates within the same table.

### Entity/Table-Level Detection — `detectTableDuplicates()`

Uses a combined similarity score:
```
combined = jaccard(columnSets) * 0.7 + nameLevenshtein * 0.3
```
Tables with `combined >= 0.6` are flagged as structural duplicates.

### Migration SQL Generator — `generateMigration()`

Three-phase migration per table:
1. **Rename winner** to canonical name (if needed)
2. **Backfill** via `UPDATE t SET canonical = COALESCE(canonical, duplicate)`
3. **Drop** the duplicate column

Down migration: reverses steps in order (re-add dropped columns, rename back).

### Type Compatibility Matrix

Exported functions: `getTypeFamily()`, `assessTypeCompatibility()` (returns `compatible | castable | incompatible`)

---

## Phase 5: ESLint Configuration (`.eslintrc.json`)

- Parser: `@typescript-eslint/parser`
- Extends: `eslint:recommended` + `plugin:@typescript-eslint/recommended`
- Key rules: `no-explicit-any: warn`, `no-unused-vars: warn` (allowing `_` prefix)
- Ignores: `out/**`, `node_modules/**`, compiled `.js` files
- **Result: 0 errors, 73 warnings** (warnings are in pre-existing test files)

---

## Phase 6: Test Suite (`test/member2.run.test.js`)

**142 tests across 21 sections:**

| Section | Tests | Coverage |
|---------|-------|----------|
| 1 | 8 | `splitStatements` |
| 2 | 6 | `normalizeIdentifier` |
| 3 | 6 | `snakeCase` / `pluralize` |
| 4 | 8 | `parseColumnDefinitions` |
| 5 | 7 | `parseSqlScript` CREATE TABLE |
| 6 | 14 | `applyAlterTable` |
| 7 | 4 | `mergeInto` / `mergeSchemas` |
| 8 | 7 | Prisma schema basics |
| 9 | 4 | Django model parsing |
| 10 | 8 | `maskSql` tokenizer |
| 11 | 4 | `splitSqlStatements` with offsets |
| 12 | 4 | `hasClause` / CTE extraction |
| 13 | 10 | Pattern diagnostic rules |
| 14 | 4 | `normalizeColumnName` |
| 15 | 4 | `jaccardSimilarity` |
| 16 | 5 | `stringSimilarity` (Levenshtein) |
| 17 | 5 | Type compatibility |
| 18 | 5 | Migration SQL generation |
| 19 | 5 | `extractTablesFromStatement` |
| 20 | 6 | `parseTableConstraint` |
| 21 | 18 | Source-of-truth drift guard |

---

## Verification Results

| Check | Result |
|-------|--------|
| `npm run compile` | ✅ 0 errors |
| `npm run lint` | ✅ 0 errors, 73 warnings |
| `node test/member1.run.test.js` | ✅ 138/138 |
| `node src/mergeAnalyzer/mergeAnalyzer.test.js` | ✅ 31/31 |
| `node test/member2.run.test.js` | ✅ 142/142 |

---

## Files Created / Modified

### New Files
- `src/contextManager/schemaParsers.ts` — Pure schema parser module (~850 lines)
- `src/diagnostics/sqlTokenizer.ts` — SQL tokenizer with dual-mask output (~290 lines)
- `src/diagnostics/schemaDiagnostics.ts` — Schema-aware diagnostic rule engine (~340 lines)
- `src/diagnostics/sqlCodeActionProvider.ts` — VS Code CodeActionProvider (~155 lines)
- `test/member2.run.test.js` — 142-test standalone test runner
- `.eslintrc.json` — ESLint configuration
- `logs/bob_execution_log.md` — IBM Bob execution log
- `MEMBER2_IMPLEMENTATION_PLAN.md` — This document

### Modified Files
- `src/core/types.ts` — Added 7 new types/interfaces
- `src/contextManager/contextManager.ts` — Full rewrite with live DB, status bar, better ORM parsing
- `src/diagnostics/sqlDiagnosticProvider.ts` — Rewritten to use tokenizer + schema rules
- `src/duplicateDetector/duplicateDetector.ts` — Added intra-table detection, Jaccard similarity, migration generator
- `src/extension.ts` — StatusBar injection, CodeActionProvider registration
- `package.json` — Updated test scripts, added `test:member2`, `lint:fix`
