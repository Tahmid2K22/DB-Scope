# Member 1 — AI Integration Plan
## Replace ALL Deterministic Logic with IBM watsonx.ai

> **Goal:** Every analysis decision in Member 1's files (`blastRadiusAnalyzer.ts`,
> `sqlHoverProvider.ts`, `sqlParser.ts`) must be produced by IBM watsonx.ai Granite,
> not by if/else or regex. The competition judges want to see real AI integration.

---

## What Needs to Change (Summary)

| Current (Deterministic) | Replacement (IBM watsonx.ai) |
|---|---|
| `if (/DROP COLUMN/i.test(sql))` → hardcoded breaking change | Granite reads the full SQL and returns breaking changes + **confidence** as JSON |
| `if (parsed.operation === 'DELETE' && !/WHERE/i.test(sql))` → fixed risk rule | Granite assesses all data risks + **per-risk confidence** |
| Arithmetic formula `breakingChanges * 2 + deps.length` → risk score | Granite scores 1-10 + explanation + **overall confidence + 4 per-dimension confidence scores** |
| `regex.exec(sql)` + template string → rollback SQL | Granite writes the correct rollback SQL |
| `lineText.includes(tableName)` → file search | Granite reads file content, classifies deps + **dependency confidence** |
| Hover tooltip = formatted struct fields | Granite writes a natural-language summary including **confidence indicators** |

---

## New File: `src/ai/watsonxClient.ts`

**Intent:** A single, thin client that wraps the IBM watsonx.ai Chat API
(`POST /ml/v1/text/chat`). All AI calls go through this one place so the
API key, project ID, model ID, and base URL are configured once.

**Expected Outcomes:**
- One exported class `WatsonxClient` with one public method:
  `ask(systemPrompt, userMessage, maxTokens): Promise<string>`
- Reads `dbscope.watsonxApiKey`, `dbscope.watsonxProjectId`,
  `dbscope.watsonxUrl` from VS Code settings (user must set these)
- Uses `node-fetch` (already in `package.json` dependencies) to call:
  `POST {url}/ml/v1/text/chat?version=2024-05-31`
- Authorization header: `Bearer {IAM_token}` (see note below on token exchange)
- Model: `ibm/granite-3-3-8b-instruct`
- Returns the first message content string from the response
- If the API call fails (network error, bad key, quota) it throws a
  descriptive `Error` so callers can surface a VS Code warning

**IBM watsonx.ai Chat API shape (from official docs):**
```
POST {url}/ml/v1/text/chat?version=2024-05-31
Authorization: Bearer {token}
Content-Type: application/json

{
  "model_id": "ibm/granite-3-3-8b-instruct",
  "project_id": "{project_id}",
  "messages": [
    { "role": "system", "content": "{system_prompt}" },
    { "role": "user",   "content": "{user_message}"  }
  ],
  "parameters": { "max_new_tokens": {maxTokens} }
}
```
Response: `result.choices[0].message.content`

**IAM Token Note:** watsonx.ai accepts an IBM Cloud IAM API key exchanged for
a bearer token via `POST https://iam.cloud.ibm.com/identity/token`. Add a
`getIamToken(apiKey)` helper inside the client that caches the token for
50 minutes and auto-refreshes.

**Todo List:**
- [ ] Create `src/ai/watsonxClient.ts`
- [ ] Add `getIamToken(apiKey)` with 50-minute in-memory cache
- [ ] Add `ask(system, user, maxTokens)` method using `node-fetch`
- [ ] Add `dbscope.watsonxApiKey`, `dbscope.watsonxProjectId`, `dbscope.watsonxUrl`
      to `package.json` `contributes.configuration.properties`
- [ ] Export a singleton `getWatsonxClient()` factory

**Relevant Files:** `package.json`, `src/utils/logger.ts`

**Status:** `[ ] pending`

---

## Step 1 — AI-Powered Schema Impact Analysis

**File:** `src/blastRadius/blastRadiusAnalyzer.ts` — `analyzeSchemaImpact()`

**Intent:** Replace every `if/regex` block with a single Granite call that reads
the SQL, understands intent, and returns structured JSON listing breaking changes,
non-breaking changes, and cascade effects.

**Current (DELETE):**
```typescript
if (/DROP\s+COLUMN/i.test(sql)) {
  breaking.push(`DROP COLUMN destroys column data permanently`);
}
```

**Replacement — Granite prompt:**
```
SYSTEM: You are a database migration safety expert.
        Given a SQL statement and a table schema, return ONLY valid JSON.
        Also score your own confidence (0-100) based on how much schema context was provided.

USER: SQL: ALTER TABLE users DROP COLUMN phone
      Schema available: yes — { users: { phone: { type: VARCHAR, nullable: true } } }

      Return JSON: {
        "breakingChanges": ["<reason>"],
        "nonBreakingChanges": ["<reason>"],
        "cascadeEffects": ["<reason>"],
        "confidenceScore": 85,
        "confidenceReason": "Full schema provided; foreign key relationships unknown"
      }
```
Parse `JSON.parse(response)` directly. The `confidenceScore` and `confidenceReason`
are stored on the new `DimensionConfidence` interface (see types step below).

**What drives low confidence for schema impact:**
- Schema snapshot not loaded (no columns known) → confidence ≤ 30
- Only partial schema (some tables missing) → confidence 30–60
- Full schema + FK relationships known → confidence 80–100

**Expected Outcomes:**
- `analyzeSchemaImpact()` makes one `watsonxClient.ask()` call
- Returns `{ schemaImpact: SchemaImpact, confidence: DimensionConfidence }`
- Falls back with `confidenceScore: 0, confidenceReason: "AI unavailable"` on error

**Todo List:**
- [ ] Inject `WatsonxClient` into `BlastRadiusAnalyzer` constructor
- [ ] Add `DimensionConfidence` interface to `src/core/types.ts`
- [ ] Replace `analyzeSchemaImpact()` body with `buildSchemaImpactPrompt()` helper
      that serialises the relevant schema tables as JSON into the prompt
- [ ] Call `watsonxClient.ask()` and `JSON.parse()` the response including confidence fields
- [ ] Add fallback on parse error or API error

**Relevant Files:** `src/blastRadius/blastRadiusAnalyzer.ts:64-112`,
`src/core/types.ts:64-68`

**Status:** `[ ] pending`

---

## Step 2 — AI-Powered Data Integrity Risk Assessment

**File:** `src/blastRadius/blastRadiusAnalyzer.ts` — `assessDataIntegrityRisks()`

**Intent:** Replace the 9 hardcoded risk rules (DELETE without WHERE, DROP FK, etc.)
with a Granite call that reads the full SQL and produces a ranked list of risks it
actually understands — including risks the regex rules can never catch, like
"this UPDATE will lock the table for 10 minutes on a 2M-row InnoDB table".

**Granite prompt pattern:**
```
SYSTEM: You are a database reliability engineer.
        Identify ALL data integrity risks in the given SQL.
        Score your confidence (0-100) based on how much runtime context was provided
        (row counts, FK graph, database version).
        Return ONLY JSON: {
          "risks": [{ "description": "...", "severity": "critical|high|medium|low" }],
          "confidenceScore": 70,
          "confidenceReason": "Row counts provided; lock behavior depends on DB version (unknown)"
        }

USER: SQL: DELETE FROM orders WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@temp.com')
      Table row counts: orders=2000000, users=500000
      Database version: unknown
```

**What drives low confidence for data risks:**
- Row counts unknown (cannot assess lock/duration risk) → confidence ≤ 40
- Database version unknown (locking behavior differs) → confidence ≤ 60
- Full row counts + DB version known → confidence 75–100

**Expected Outcomes:**
- `assessDataIntegrityRisks()` makes one AI call
- Returns `{ risks: DataIntegrityRisk[], confidence: DimensionConfidence }`
- Granite can detect complex patterns: subquery risk, lock escalation, batch size issues

**Todo List:**
- [ ] Replace entire method body with one `watsonxClient.ask()` call
- [ ] Pass `parsed.rawSql` + table row counts + DB type from `schemaState` in the prompt
- [ ] Parse response as `{ risks: DataIntegrityRisk[], confidenceScore, confidenceReason }` with fallback

**Relevant Files:** `src/blastRadius/blastRadiusAnalyzer.ts:195-257`

**Status:** `[ ] pending`

---

## Step 3 — AI-Powered Risk Score + Explanation

**File:** `src/blastRadius/blastRadiusAnalyzer.ts` — `calculateRiskScore()`

**Intent:** Replace the arithmetic formula (`breakingChanges.length * 2 + ...`)
with a Granite call that considers ALL four dimension results holistically and
produces a 1-10 score WITH a plain-English explanation of WHY it's that score.

**Why AI here:** The fixed formula can never weigh context — e.g. "1 breaking
change + 0 app deps" in a dev schema is risk 2, but the same in production with
5M rows is risk 9. Granite understands this nuance.

**New types — extend `BlastRadiusResult` and add `DimensionConfidence`:**
```typescript
// Add to src/core/types.ts

export interface DimensionConfidence {
  confidenceScore: number;   // 0-100
  confidenceReason: string;  // AI's plain-English explanation of what was missing
}

export interface AnalysisConfidence {
  overall: DimensionConfidence;       // holistic score across all 4 dimensions
  schemaImpact: DimensionConfidence;  // was schema snapshot available?
  appDependencies: DimensionConfidence; // were source files scanned?
  dataIntegrityRisks: DimensionConfidence; // were row counts and DB version known?
  documentationDrift: DimensionConfidence; // were doc files found?
}

// Add to BlastRadiusResult:
riskExplanation: string;
confidence: AnalysisConfidence;
```

**Granite prompt pattern for risk score (single call returns both score AND all confidence scores):**
```
SYSTEM: You are a senior DBA scoring migration risk.
        You also score the confidence of each analysis dimension separately.
        Score risk from 1 (trivial) to 10 (catastrophic).
        Score each confidence from 0 (no context) to 100 (full context).
        Return ONLY JSON:
        {
          "score": 7,
          "explanation": "...",
          "confidence": {
            "overall": { "confidenceScore": 62, "confidenceReason": "Row counts missing for 2 tables" },
            "schemaImpact": { "confidenceScore": 90, "confidenceReason": "Full schema loaded" },
            "appDependencies": { "confidenceScore": 55, "confidenceReason": "Only 12 of ~40 source files scanned" },
            "dataIntegrityRisks": { "confidenceScore": 40, "confidenceReason": "Row count for orders unknown" },
            "documentationDrift": { "confidenceScore": 70, "confidenceReason": "README found; API docs not present" }
          }
        }

USER: SQL: ALTER TABLE orders DROP COLUMN legacy_code
      Breaking changes: ["DROP COLUMN destroys data"]
      App dependencies: 3 files reference this column (12 files scanned of ~40 total)
      Data risks: ["irreversible data loss"]
      Schema loaded: yes — orders has columns [id, user_id, legacy_code, created_at]
      Row count for orders: unknown
      Documentation files found: README.md
```

**Expected Outcomes:**
- `calculateRiskScore()` becomes `async` and returns `{ score, explanation, confidence: AnalysisConfidence }`
- `BlastRadiusResult.riskExplanation` and `BlastRadiusResult.confidence` are both populated
- Hover tooltip shows the AI explanation AND a compact confidence indicator per dimension
- This is ONE Granite call — all five confidence scores returned in a single response

**Todo List:**
- [ ] Add `DimensionConfidence`, `AnalysisConfidence` interfaces to `src/core/types.ts`
- [ ] Add `riskExplanation: string` and `confidence: AnalysisConfidence` to `BlastRadiusResult`
- [ ] Make `calculateRiskScore()` async, call `watsonxClient.ask()`
- [ ] Pass all four dimension results + file scan stats + schema availability into the prompt
- [ ] Return `{ score, explanation, confidence }` and update `analyze()` to store both
- [ ] Update `buildHover()` in `sqlHoverProvider.ts` to show confidence bars per dimension

**Relevant Files:** `src/blastRadius/blastRadiusAnalyzer.ts:299-340`,
`src/core/types.ts:50-62`, `src/hoverProvider/sqlHoverProvider.ts:137`

**Status:** `[ ] pending`

---

## Step 4 — AI-Powered Rollback SQL Generation

**File:** `src/blastRadius/blastRadiusAnalyzer.ts` — `buildRollbackSuggestions()`

**Intent:** Replace every `RegExp.exec()` + template string rollback with a
Granite call that actually writes the correct rollback SQL for ANY migration,
including complex multi-statement migrations the regex can never handle.

**Current limitation:** Regex only handles simple single-clause ALTERs. It fails on:
- Multi-statement migrations
- `ALTER TABLE ... MODIFY COLUMN` (type change rollback)
- MySQL vs PostgreSQL syntax differences
- `CREATE TABLE AS SELECT ...`

**Granite prompt pattern:**
```
SYSTEM: You are a database migration engineer.
        Write the exact SQL to UNDO the given migration.
        Return ONLY JSON:
        { "rollbacks": [{ "description": "...", "sql": "...", "safetyLevel": "safe|manual_review|destructive" }] }
        If no rollback is possible, set safetyLevel to "destructive" and explain in description.

USER: SQL: ALTER TABLE users MODIFY COLUMN email VARCHAR(500) NOT NULL
      Current schema: { users: { email: { type: VARCHAR(255), nullable: false } } }
      Database type: postgresql
```

**Expected Outcomes:**
- `buildRollbackSuggestions()` makes one AI call
- Granite writes syntactically correct rollback SQL for the target DB dialect
- Same `RollbackSuggestion[]` return type

**Todo List:**
- [ ] Replace all `if/regex` blocks in `buildRollbackSuggestions()` with one AI call
- [ ] Pass DB type from config (`dbscope.dbType`) into the prompt
- [ ] Pass the relevant table schema snapshot into the prompt
- [ ] Parse `{ rollbacks: RollbackSuggestion[] }` with fallback

**Relevant Files:** `src/blastRadius/blastRadiusAnalyzer.ts:378-478`

**Status:** `[ ] pending`

---

## Step 5 — AI-Powered App Dependency Classification

**File:** `src/blastRadius/blastRadiusAnalyzer.ts` — `findAppDependencies()`

**Intent:** The current scanner finds files that *contain the table name string*
and classifies severity by checking if the line contains "delete" or "update".
Replace the severity classification with a Granite call that reads each matching
code snippet and decides if it is a **real dependency** and what the true severity is.

**Why this matters:** String matching produces false positives (comments, test
fixtures, migration scripts). Granite reads the code and understands intent.

**Design — two-phase approach:**
1. **Phase 1 (keep deterministic):** VS Code `findFiles` + string search to find
   candidate lines. This is I/O, not intelligence — keep it fast.
2. **Phase 2 (AI):** For each candidate batch, call Granite with the code snippets
   and ask it to classify each one: `real_dependency | false_positive` + severity.

**Granite prompt pattern (batched — all candidates in one call):**
```
SYSTEM: You are a code reviewer.
        For each code snippet, decide if it is a REAL database dependency on table "{tableName}"
        or a false positive (comment, test fixture, migration file).
        Return ONLY JSON: { "results": [{ "filePath": "...", "lineNumber": 1, "isDependency": true, "severity": "high", "reason": "..." }] }

USER: Table: orders
      Snippets:
      1. src/orderService.ts:42 — `await db.query('DELETE FROM orders WHERE id = $1', [id])`
      2. src/migrations/001.ts:5 — `// Drop orders table after migration`
      3. README.md:10 — `The orders table stores all purchases`
```

**Expected Outcomes:**
- False positives (comments, docs, migration files) are filtered out
- Severity labels come from Granite's code understanding, not keyword matching
- Same `AppDependency[]` return type, with `usage` field containing Granite's reason

**Todo List:**
- [ ] Keep Phase 1 file search as-is (I/O only)
- [ ] Batch collected candidates (up to 20 per call) into a Granite prompt
- [ ] Replace `classifyDepSeverity()` with AI classification
- [ ] Filter out items where `isDependency === false`
- [ ] Map AI response back to `AppDependency[]`

**Relevant Files:** `src/blastRadius/blastRadiusAnalyzer.ts:118-189`

**Status:** `[ ] pending`

---

## Step 6 — AI-Powered Hover Tooltip with Confidence Indicators

**File:** `src/hoverProvider/sqlHoverProvider.ts` — `buildHover()`

**Intent:** Instead of assembling a tooltip by looping over struct fields,
call Granite to write a single, clear, natural-language paragraph that a developer
can immediately understand — including the risk score rationale and a compact
per-dimension confidence display so the developer instantly knows which parts of
the analysis to trust.

**Granite output (natural language + confidence):**
```
### 🟠 DB-Scope: Migration Impact — Risk 8/10 (HIGH)

Dropping the `legacy_code` column from `orders` (2M rows) is **irreversible**.
3 files in your codebase reference this column — update `orderService.ts`,
`reportingController.ts`, and `adminPanel.ts` before deploying.

**To roll back:** `ALTER TABLE orders ADD COLUMN legacy_code VARCHAR(50);`
⚠ You must also restore data from a backup — this column contained live data.

---
**Analysis Confidence**
Schema Impact      ████████░░  90%  Full schema loaded
App Dependencies   █████░░░░░  55%  12/~40 files scanned — run Fetch Context for full scan
Data Risks         ████░░░░░░  40%  ⚠ Row count unknown — run Fetch Context
Doc Drift          ███████░░░  70%  README found; no API docs detected
Overall            ██████░░░░  62%  Fetch database context to improve accuracy
```

The confidence bars are rendered as Unicode block characters computed from the
`confidence.*.confidenceScore` fields already present on `BlastRadiusResult`.
The label text comes from `confidence.*.confidenceReason` (written by Granite).

**Implementation:** After `analyzer.analyze()` returns a result, make one
additional Granite call passing the structured result as context and asking for
a markdown summary. Cache both the analysis result AND the AI summary under the
same SQL key.

**Expected Outcomes:**
- `buildHover()` takes an optional `aiSummary: string` parameter
- When `aiSummary` is present it is shown as the primary content
- The structured fields (breaking changes list, rollbacks list) appear as a
  collapsed "Details" section below the AI summary

**Todo List:**
- [ ] Add `generateHoverSummary(result: BlastRadiusResult): Promise<string>` to
      `SqlHoverProvider` (calls watsonxClient)
- [ ] Call `generateHoverSummary()` in `provideHover()` after `analyzer.analyze()`
- [ ] Update `buildHover()` to accept and render `aiSummary`
- [ ] Keep the structured fallback if AI call fails

**Relevant Files:** `src/hoverProvider/sqlHoverProvider.ts:129-186`

**Status:** `[ ] pending`

---

## Step 7 — AI-Powered SQL Parser (Intent Understanding)

**File:** `src/utils/sqlParser.ts` — `parseSql()`

**Intent:** The current parser uses `sql.split(' ')[0]` to detect the operation
and regex loops to find table names. This fails for CTEs, subqueries, stored
procedure calls, and dialect-specific syntax. Replace with a Granite call that
understands SQL intent.

**Current failure cases:**
- `WITH cte AS (SELECT ...) DELETE FROM orders` → detected as `WITH` (UNKNOWN)
- `CALL migrate_users()` → detected as UNKNOWN, no tables extracted
- `MERGE INTO target USING source ON ...` → detected as UNKNOWN

**Granite prompt pattern:**
```
SYSTEM: You are a SQL parser. Extract the primary operation and all referenced tables.
        Return ONLY JSON: { "operation": "DELETE", "tables": ["orders"], "isDestructive": true, "columns": [] }
        Valid operations: SELECT INSERT UPDATE DELETE ALTER DROP CREATE TRUNCATE UNKNOWN

USER: WITH deleted_users AS (SELECT id FROM users WHERE deleted_at < NOW())
      DELETE FROM orders WHERE user_id IN (SELECT id FROM deleted_users)
```

**Expected Outcomes:**
- `parseSql()` becomes async: `parseSqlAI(sql): Promise<ParsedSql>`
- Returns same `ParsedSql` interface — no downstream changes
- Falls back to current regex parser if AI call fails (resilience)
- All callers of `parseSql` in `blastRadiusAnalyzer.ts` updated to `await parseSqlAI()`

**Todo List:**
- [ ] Add `parseSqlAI(sql: string): Promise<ParsedSql>` to `sqlParser.ts`
- [ ] Keep `parseSql()` as the synchronous fallback
- [ ] Update `blastRadiusAnalyzer.ts` `analyze()` to `await parseSqlAI(sql)`
- [ ] Update unit test to test `parseSqlAI` with CTE + MERGE inputs

**Relevant Files:** `src/utils/sqlParser.ts`, `src/blastRadius/blastRadiusAnalyzer.ts:33`

**Status:** `[ ] pending`

---

## Step 8 — Update `package.json` Configuration

**Intent:** Expose the three IBM watsonx.ai credentials as VS Code settings so
the user can configure them in Settings UI without touching code.

**New settings to add to `contributes.configuration.properties`:**
```json
"dbscope.watsonxUrl": {
  "type": "string",
  "default": "https://us-south.ml.cloud.ibm.com",
  "description": "IBM watsonx.ai region URL (e.g. https://us-south.ml.cloud.ibm.com)"
},
"dbscope.watsonxApiKey": {
  "type": "string",
  "default": "",
  "description": "IBM Cloud API key for watsonx.ai authentication"
},
"dbscope.watsonxProjectId": {
  "type": "string",
  "default": "",
  "description": "watsonx.ai project ID (from the project URL in IBM Cloud)"
}
```

**Todo List:**
- [ ] Add three new settings to `package.json`
- [ ] Read these in `WatsonxClient` constructor via `vscode.workspace.getConfiguration('dbscope')`

**Relevant Files:** `package.json:46-76`

**Status:** `[ ] pending`

---

## Step 9 — Update Unit Tests for AI-Powered Methods

**File:** `src/test/blastRadiusAnalyzer.test.ts`

**Intent:** The existing tests test private regex methods directly. With AI
integration, we need tests that mock `WatsonxClient` and verify:
1. The correct prompts are sent to the AI
2. The correct `BlastRadiusResult` shape is returned from the parsed AI response
3. Fallback logic works when the AI call fails

**Approach:** Use a `StubWatsonxClient` that returns pre-baked JSON strings,
ensuring tests don't hit the real API and run offline.

**Todo List:**
- [ ] Add `StubWatsonxClient` class to the test file
- [ ] Replace tests that call private regex methods with tests that assert on
      the final `BlastRadiusResult` shape
- [ ] Add a test for fallback: stub throws → result still has `riskScore >= 1`
- [ ] Add a test for AI risk explanation: stub returns score 8 + explanation →
      `result.riskExplanation` is populated
- [ ] Add a test for confidence: stub returns `confidenceScore: 40` for dataRisks →
      `result.confidence.dataIntegrityRisks.confidenceScore === 40`
- [ ] Add a test for overall confidence: stub returns all 5 dimension scores →
      `result.confidence.overall.confidenceScore` is populated and non-zero

**Relevant Files:** `src/test/blastRadiusAnalyzer.test.ts`

**Status:** `[ ] pending`

---

## Execution Order & Dependencies

```
Step 8 (package.json — settings)
  └─► New File: watsonxClient.ts (reads settings, provides AI)
        ├─► Step 7 (parseSqlAI — uses watsonxClient)
        │     └─► Step 1 (schemaImpact — uses parseSqlAI output)
        │     └─► Step 2 (dataRisks — uses parseSqlAI output)
        │     └─► Step 3 (riskScore — uses all dimension results)
        │     └─► Step 4 (rollbacks — uses parseSqlAI output)
        │     └─► Step 5 (appDeps — uses watsonxClient for classification)
        └─► Step 6 (hover — uses watsonxClient for natural-language summary)
Step 9 (tests — runs after all above)
```

---

## File Change Summary

| File | Change |
|---|---|
| `src/ai/watsonxClient.ts` | **New file** — IBM watsonx.ai client |
| `package.json` | Add 3 new settings for API key, project ID, URL |
| `src/core/types.ts` | Add `DimensionConfidence`, `AnalysisConfidence` interfaces + `riskExplanation` + `confidence` to `BlastRadiusResult` |
| `src/utils/sqlParser.ts` | Add `parseSqlAI()` async AI-powered parser |
| `src/blastRadius/blastRadiusAnalyzer.ts` | All 4 dimension methods + score + rollbacks → AI; each dimension returns its own `DimensionConfidence` |
| `src/hoverProvider/sqlHoverProvider.ts` | Hover tooltip → AI natural-language summary + per-dimension confidence bars |
| `src/test/blastRadiusAnalyzer.test.ts` | Update tests with `StubWatsonxClient`; add confidence assertion tests |

---

## What Judges Will See

After this plan is implemented, every analysis output is **non-deterministic AI** with a transparent confidence layer:

- The risk score is explained in Granite's own words
- **Each of the 4 analysis dimensions carries its own AI-scored confidence (0–100)**
- **An overall confidence score tells the developer exactly how much to trust the analysis**
- **Granite explains in plain English what context was missing and how to fix it**
- The rollback SQL is written by Granite, not a template
- The hover tooltip reads like a senior DBA wrote it, with confidence bars per dimension
- Complex SQL (CTEs, MERGE, stored procedures) is understood correctly
- App dependency classification filters out false positives using code reasoning

---

*Plan written for IBM Bob 2.0 Hackathon — DB-Scope project*
*Member 1 scope: `src/blastRadius/` + `src/hoverProvider/` + `src/utils/sqlParser.ts`*
