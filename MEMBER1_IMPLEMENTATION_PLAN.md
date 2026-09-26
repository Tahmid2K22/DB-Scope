# Member 1 — Full Implementation Plan
## Files: `blastRadiusAnalyzer.ts` + `sqlHoverProvider.ts`

> This document describes **every step** the agent will execute to take Member 1's two files
> from their current working state to a fully complete, production-quality implementation.
> Each step states exactly **what** will be done, **why**, and **which lines/methods** are affected.

---

## Current State (Baseline)

| File | Status |
|------|--------|
| `src/blastRadius/blastRadiusAnalyzer.ts` | Working scaffold — 4 dimensions implemented, bugs fixed |
| `src/hoverProvider/sqlHoverProvider.ts` | Working scaffold — hover tooltip implemented, type fixed |
| `src/utils/sqlParser.ts` | Working — schema-prefix bug fixed |

**What the code does today:**
- `analyze(sql)` runs 4 async dimensions in parallel via `Promise.all`
- Dimension 1 detects breaking/non-breaking schema changes from the SQL text
- Dimension 2 scans workspace files for table name references
- Dimension 3 flags dangerous patterns (DELETE without WHERE, etc.)
- Dimension 4 checks README/API docs for missing table documentation
- Risk score 1–10 computed from weighted dimension results
- Hover tooltip appears on SQL queries showing risk score + breaking changes

**What is missing / incomplete:**
1. Dimension 2 only matches exact table names — misses ORM method chains (`.findById`, `repository.save`)
2. Dimension 3 has no rules for `CREATE INDEX` removal or `FOREIGN KEY` drops
3. Risk scoring does not account for table row count (dropping a 10-row table vs 10M-row table)
4. Hover provider only extracts SQL from single-quoted/backtick strings — misses template literals
5. No hover range — the tooltip attaches to the whole line rather than just the SQL token
6. No `RollbackSuggestion` generated — the analyzer finds problems but doesn't auto-write fixes
7. No export of analysis result to JSON file
8. No unit tests

---

## Implementation Steps

---

### Step 1 — Add `RollbackSuggestion` type and field to `BlastRadiusResult`

**File:** `src/core/types.ts`

**What:** Add a new interface `RollbackSuggestion` and add a `rollbackSuggestions` array to `BlastRadiusResult`.

**Why:** The analyzer currently finds problems but never tells the developer *how to undo* them. A rollback suggestion is the most actionable output for a DBA.

**Exact change:**
```typescript
// Add after DocumentationDrift interface
export interface RollbackSuggestion {
  description: string;        // Human-readable "what this rollback does"
  sql: string;                // Ready-to-run rollback SQL
  safetyLevel: 'safe' | 'manual_review' | 'destructive';
}
```

And in `BlastRadiusResult`:
```typescript
rollbackSuggestions: RollbackSuggestion[];   // new field added after suggestions[]
```

**Agent action:** `apply_diff` on `src/core/types.ts` — add the interface after `DocumentationDrift`, add the field to `BlastRadiusResult`.

---

### Step 2 — Implement `buildRollbackSuggestions()` in `BlastRadiusAnalyzer`

**File:** `src/blastRadius/blastRadiusAnalyzer.ts`

**What:** Add a private method `buildRollbackSuggestions(parsed, schemaImpact)` that generates ready-to-run rollback SQL for the current migration.

**Why:** Judges and users want the tool to *fix* problems, not just flag them. This is the key differentiator from a simple linter.

**Logic per SQL operation:**

| Input SQL | Generated Rollback SQL |
|-----------|----------------------|
| `ALTER TABLE t DROP COLUMN c` | `ALTER TABLE t ADD COLUMN c <original_type>` (type fetched from schemaState) |
| `ALTER TABLE t ADD COLUMN c` | `ALTER TABLE t DROP COLUMN c` |
| `ALTER TABLE t RENAME COLUMN a TO b` | `ALTER TABLE t RENAME COLUMN b TO a` |
| `DROP TABLE t` | Full `CREATE TABLE t (...)` reconstructed from schemaState snapshot |
| `CREATE INDEX idx ON t(c)` | `DROP INDEX idx` |
| `DELETE FROM t WHERE ...` | `-- No rollback available: take a point-in-time backup before running` |

**Agent action:** `apply_diff` on `blastRadiusAnalyzer.ts` to:
1. Add import of `RollbackSuggestion` from types
2. Add `buildRollbackSuggestions()` private method (~50 lines)
3. Call it inside `analyze()` and include result in the returned object

---

### Step 3 — Extend Dimension 2 to detect ORM patterns

**File:** `src/blastRadius/blastRadiusAnalyzer.ts` — `findAppDependencies()`

**What:** Extend the source-file scanner to also match ORM method chains that reference a table by model class name (TypeORM, Sequelize, Prisma, Django).

**Why:** Currently `findAppDependencies` only matches the literal table name string (e.g. `"users"`). In TypeORM code it's `userRepository.findOne(...)` — the word `users` never appears. This means real app dependencies are missed.

**Patterns to add:**

| ORM / Pattern | Example code matched |
|--------------|---------------------|
| TypeORM Repository | `getRepository(User)`, `userRepository.find` |
| Prisma Client | `prisma.user.findMany`, `prisma.user.create` |
| Sequelize | `User.findAll()`, `User.destroy()` |
| Django QuerySet | `User.objects.filter(`, `User.objects.delete(` |
| Knex | `.table('users')`, `.from('users')` |

**Approach:**  
For each table name `users`, also derive the model class name `User` (singular, PascalCase) and search for that in `.ts/.js/.py` files.

**Agent action:** `apply_diff` on `findAppDependencies()` to add a `deriveModelName(tableName)` helper and expand the pattern to include model-class hits.

---

### Step 4 — Extend Dimension 3 with 4 new risk rules

**File:** `src/blastRadius/blastRadiusAnalyzer.ts` — `assessDataIntegrityRisks()`

**What:** Add 4 missing risk rules that are common real-world migration hazards.

**New rules:**

| Rule | Severity | Trigger |
|------|----------|---------|
| `DROP FOREIGN KEY` | `high` | `ALTER TABLE ... DROP FOREIGN KEY` — removes referential integrity |
| `DROP INDEX` on PRIMARY KEY | `high` | `ALTER TABLE ... DROP PRIMARY KEY` — makes table unaddressable |
| `CREATE UNIQUE INDEX` on existing data | `high` | Unique index on a column that may have duplicates will fail on existing rows |
| `ALTER TABLE ... ENGINE=` | `medium` | Changing storage engine (e.g. InnoDB → MyISAM) is irreversible in MySQL |

**Agent action:** `apply_diff` on `assessDataIntegrityRisks()` to add 4 new `if` blocks after the existing CASCADE check.

---

### Step 5 — Add row-count weighting to risk score

**File:** `src/blastRadius/blastRadiusAnalyzer.ts` — `calculateRiskScore()`

**What:** If the schema state has a `rowCount` for the affected table, multiply the base score by a size factor.

**Why:** `DROP TABLE sessions` (10 rows, dev table) is risk 3. `DROP TABLE orders` (5M rows, production) is risk 10. The current scorer treats them identically.

**Logic:**
```
sizeFactor =
  rowCount > 1_000_000 ? 1.5
  rowCount > 100_000   ? 1.25
  rowCount > 10_000    ? 1.1
  else                 → 1.0

finalScore = Math.min(Math.round(baseScore * sizeFactor), 10)
```

**Agent action:** `apply_diff` on `calculateRiskScore()` to:
1. Accept `tables: string[]` as a new parameter (pass `parsed.tables` from `analyze()`)
2. Look up `rowCount` from `schemaState` for each affected table
3. Apply size multiplier before final clamp

---

### Step 6 — Fix hover SQL extraction for template literals

**File:** `src/hoverProvider/sqlHoverProvider.ts` — `extractSqlFromString()`

**What:** Add a 4th pattern to match multi-line template literal SQL:
```typescript
const query = `
  SELECT *
  FROM users
  WHERE id = ${userId}
`;
```

**Why:** Template literals (backtick strings with `${...}` interpolations) are the most common way to write SQL in TypeScript/Node.js code. The current extractor only matches backtick strings *without* `${}`, so it misses the most common pattern.

**New pattern:**
```typescript
/`((?:SELECT|INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)[\s\S]+?)`/i
```
The `[\s\S]+?` (non-greedy, matches newlines) replaces `[^\`]+` to handle multi-line.

**Agent action:** `apply_diff` on `extractSqlFromString()` — replace the backtick pattern with the multi-line version.

---

### Step 7 — Add hover range (highlight only the SQL token)

**File:** `src/hoverProvider/sqlHoverProvider.ts` — `provideHover()`

**What:** Return `new vscode.Hover(md, range)` where `range` is the exact span of the SQL string token in the document, so VS Code highlights only the SQL string instead of the whole line.

**Why:** Currently the tooltip has no range, so VS Code shows it for the entire line. A precise range makes the UX much cleaner — you hover exactly over the SQL string and only that token lights up.

**Logic:**
1. When `extractSqlAtPosition` finds a match, also return the `vscode.Range` of the match
2. Refactor `extractSqlAtPosition` to return `{ sql: string; range: vscode.Range } | null`
3. Pass range to `new vscode.Hover(md, range)`

**Agent action:** `apply_diff` on `sqlHoverProvider.ts` to:
1. Change return type of `extractSqlAtPosition` to `{ sql: string; range: vscode.Range } | null`
2. Compute range from match offsets in `extractStatementAt` and `extractSqlFromString`
3. Pass range into `vscode.Hover` constructor

---

### Step 8 — Add `exportResultToFile()` command

**File:** `src/blastRadius/blastRadiusAnalyzer.ts`

**What:** Add a public method `exportResult(result: BlastRadiusResult, targetDir: string): Promise<string>` that writes the full analysis result as a timestamped JSON file.

**Why:** Developers and DBAs need to share blast radius reports in Jira tickets and pull request comments. A JSON export enables this.

**Output filename:** `blast-radius-<tablename>-<timestamp>.json`

**Agent action:** `apply_diff` to add the `exportResult()` method at the bottom of the class.

Also `apply_diff` on `src/extension.ts` to wire a new command `dbscope.exportAnalysis` that calls `exportResult()` and shows a `vscode.window.showSaveDialog`.

---

### Step 9 — Write unit tests

**File:** `src/test/blastRadiusAnalyzer.test.ts` *(new file)*

**What:** Create a unit test file using Node's built-in `assert` module (no extra test framework needed — `@vscode/test-electron` is already in devDeps pattern).

**Tests to write:**

| Test | Input | Expected |
|------|-------|---------|
| `parseSql` — DROP TABLE | `DROP TABLE users` | `operation='DROP'`, `tables=['users']` |
| `parseSql` — schema-qualified | `SELECT * FROM public.orders` | `tables=['orders']` (no `public`) |
| `analyzeSchemaImpact` — DROP COLUMN | `ALTER TABLE t DROP COLUMN c` | `breakingChanges.length >= 1` |
| `analyzeSchemaImpact` — ADD COLUMN nullable | `ALTER TABLE t ADD COLUMN x INT` | `nonBreakingChanges.length >= 1`, `breakingChanges.length === 0` |
| `assessDataIntegrityRisks` — DELETE no WHERE | `DELETE FROM orders` | severity `critical` |
| `assessDataIntegrityRisks` — UPDATE with WHERE | `UPDATE orders SET status='x' WHERE id=1` | `risks.length === 0` |
| `calculateRiskScore` — critical SQL | breaking=2, criticalData=1 | score >= 7 |
| `buildRollbackSuggestions` — DROP COLUMN | `ALTER TABLE users DROP COLUMN phone` | rollback SQL contains `ADD COLUMN phone` |

**Agent action:** `write_file` to create `src/test/blastRadiusAnalyzer.test.ts` with all 8 tests.

---

### Step 10 — Push all changes to GitHub

**What:** Stage all modified and new files, commit with a descriptive message, push to `origin/main`.

**Commit message:**
```
feat(member1): complete blast radius analyzer + hover provider

- Step 1-2: Add RollbackSuggestion type + buildRollbackSuggestions()
- Step 3: Extend app dependency scan to catch ORM patterns (TypeORM/Prisma/Sequelize)
- Step 4: Add 4 new data integrity rules (DROP FK, DROP PK, UNIQUE on existing, ENGINE=)
- Step 5: Add row-count weighting to risk score (1M rows → 1.5x multiplier)
- Step 6: Fix template literal SQL extraction in hover provider
- Step 7: Add hover range to highlight exact SQL token
- Step 8: Add exportResult() + dbscope.exportAnalysis command
- Step 9: Add 8 unit tests for parseSql, analyzeSchemaImpact, assessDataIntegrityRisks
```

**Agent action:** `execute_command` — `git add`, `git commit`, `git push origin main`

---

## Execution Order & Dependencies

```
Step 1 (types.ts)
    └─► Step 2 (blastRadiusAnalyzer — uses new type)
            └─► Step 5 (score — uses rowCount from schemaState)
Step 3 (blastRadiusAnalyzer — ORM patterns, independent)
Step 4 (blastRadiusAnalyzer — new rules, independent)
Step 6 (sqlHoverProvider — template literals, independent)
    └─► Step 7 (hover range — builds on extraction refactor from Step 6)
Step 8 (exportResult — independent, but wires into extension.ts)
Step 9 (tests — runs after Steps 1–8 are done)
Step 10 (push — final step, always last)
```

Steps 3, 4, 6, and 8 have no inter-dependencies and can be applied in the same `apply_diff` call within their respective files.

---

## File Change Summary

| File | Steps | Type of Change |
|------|-------|---------------|
| `src/core/types.ts` | 1 | Add `RollbackSuggestion` interface + field in `BlastRadiusResult` |
| `src/blastRadius/blastRadiusAnalyzer.ts` | 2, 3, 4, 5, 8 | Add methods + extend existing methods |
| `src/hoverProvider/sqlHoverProvider.ts` | 6, 7 | Fix extraction + add range |
| `src/extension.ts` | 8 | Register `dbscope.exportAnalysis` command |
| `src/test/blastRadiusAnalyzer.test.ts` | 9 | New file — 8 unit tests |

---

## Success Criteria

After all steps are complete, the following must be true:

- [ ] `tsc --noEmit` passes with zero errors
- [ ] All 8 unit tests pass
- [ ] Hovering over `ALTER TABLE users DROP COLUMN phone` in a `.sql` file shows:
  - Risk score ≥ 7
  - At least 1 breaking change listed
  - A rollback suggestion showing `ADD COLUMN phone ...`
  - The tooltip is anchored to the SQL token range (not the whole line)
- [ ] Hovering over ORM code like `` prisma.user.delete({ where: { id } }) `` shows the `users` table as an app dependency
- [ ] Running `DB-Scope: Analyze Migration Blast Radius` and then `DB-Scope: Export Analysis` saves a `.json` file
- [ ] All changes are committed and visible at `https://github.com/Tahmid2K22/DB-Scope`

---

## What the Agent Will NOT Do

- Will not change files owned by Member 2 (`contextManager`, `diagnostics`, `duplicateDetector`)
- Will not change files owned by Member 3 (`mergeAnalyzer`)
- Will not modify `README.md` (shared team file — avoid merge conflicts)
- Will not add dependencies to `package.json` (all features use VS Code API + stdlib only)

---

*Plan written for IBM Bob 2.0 Hackathon — DB-Scope project*
*Member 1 scope: `src/blastRadius/` + `src/hoverProvider/` + `src/utils/sqlParser.ts`*
