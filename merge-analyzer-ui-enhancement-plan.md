# Merge Analyzer UI Enhancement Plan

## Top-Level Overview

**Goal:** Surface IBM Bob's rich semantic analysis data (confidence, affected files,
migration steps, risks) in the VS Code WebView dashboard so users can see whether
the analysis was AI-enhanced and act on Bob's specific recommendations.

**Scope:**
- `src/core/types.ts` — add one optional field to `MergeAnalysisResult`
- `src/mergeAnalyzer/mergeAnalyzer.ts` — populate that field when Bob runs
- `src/dashboard/dashboardPanel.ts` — render Bob data in `mergeHtml()`

**Non-goals:**
- No changes to `bobBridge.ts` logic or tests
- No new VS Code commands
- No changes to blast radius, hover provider, or any other member's files
- No new npm dependencies

---

## Sub-Tasks

---

### Sub-Task 1 — Add `bobResolutions` to `MergeAnalysisResult`

**Intent:**  
Give the dashboard a structured place to read Bob's full resolution objects.
Currently `applyBobResolutions()` bakes everything into plain-text `suggestion`
strings and discards the rest. Adding one optional array field carries the full
data forward without breaking any existing consumers.

**Expected Outcomes:**
- `MergeAnalysisResult` has an optional `bobResolutions?: BobConflictResolution[]` field
- The TypeScript type is importable in `dashboardPanel.ts`
- The existing `MergeConflict.suggestion` string is unchanged (still works as before)
- All existing tests continue to pass (no type changes to existing fields)

**Todo List:**
- [ ] In `src/core/types.ts`, add `bobResolutions?: import('./mergeAnalyzer/bobBridge').BobConflictResolution[]` to `MergeAnalysisResult` — OR, cleaner: re-export only the needed shape via a new local interface `BobResolutionSummary` in `types.ts` to avoid a cross-module import cycle
- [ ] Preferred approach: define a small `BobResolutionSummary` interface directly in `types.ts` that mirrors the fields the UI actually needs:
  ```ts
  export interface BobResolutionSummary {
    conflictId: string;
    resolution: string;
    confidence: number;
    reason: string;
    affectedFiles: { path: string; reason: string }[];
    affectedSymbols: { name: string; kind: string; file: string }[];
    migrationPlan: string[];
    applicationChanges: string[];
    testsToUpdate: string[];
    risks: string[];
  }
  ```
- [ ] Add `bobResolutions?: BobResolutionSummary[]` to `MergeAnalysisResult`

**Relevant Context:**
- [`src/core/types.ts`](src/core/types.ts) — `MergeAnalysisResult` is at line 142
- [`src/mergeAnalyzer/bobBridge.ts`](src/mergeAnalyzer/bobBridge.ts) — `BobConflictResolution` at line 32

**Status:** `[ ] pending`

---

### Sub-Task 2 — Populate `bobResolutions` in `MergeAnalyzer.enrichWithBob()`

**Intent:**  
Wire the new field so that when Bob successfully enriches the analysis, his full
resolution objects are attached to the returned `MergeAnalysisResult`.

**Expected Outcomes:**
- After a successful Bob run, `result.bobResolutions` contains the parsed resolution array
- When Bob is unavailable or fails, `result.bobResolutions` is `undefined` (graceful degradation unchanged)
- No change to `conflicts`, `reconciledSql`, or any existing field

**Todo List:**
- [ ] In `src/mergeAnalyzer/mergeAnalyzer.ts`, in the `enrichWithBob()` method, add `bobResolutions: bobResult.resolutions` to the returned object spread when `bobResult.resolutions.length > 0`
- [ ] No change needed when Bob is unavailable — the field simply stays `undefined`

**Relevant Context:**
- [`src/mergeAnalyzer/mergeAnalyzer.ts`](src/mergeAnalyzer/mergeAnalyzer.ts) — `enrichWithBob()` at line 133; the return at line 190

**Status:** `[ ] pending`

---

### Sub-Task 3 — Enhance `mergeHtml()` in the Dashboard

**Intent:**  
Replace the plain minimal table with a rich view that shows:
1. A "🤖 AI-Enhanced by IBM Bob" banner when Bob ran
2. Per-conflict confidence badge next to the type badge
3. An "Affected Files" expandable section per conflict (shown as a sub-list)
4. A "Migration Plan" section per conflict (numbered steps)
5. A "Risks" sub-list per conflict when Bob flagged risks
6. A per-type conflict count breakdown in the header
7. Better conflict severity colors (`missing_table` → `high`, not `medium`)

**Expected Outcomes:**
- When `r.bobResolutions` is present and non-empty, a teal/blue banner appears at the top: "🤖 Bob AI-Enhanced — N conflicts analyzed by IBM Bob Shell"
- Each conflict row shows a confidence pill (e.g. `92%`) when a matching Bob resolution exists
- Below each conflict row's suggestion, affected files are listed with file paths and reasons
- Migration plan steps appear as a numbered list when present
- Risks appear as a warning list when present
- The header conflict count badge shows a type breakdown: "5 conflicts: 2 missing_column · 1 missing_table · 2 type_mismatch"
- `missing_table` uses `high` badge, `type_mismatch` uses `high`, `nullable_difference` uses `low`, `name_conflict` uses `medium`, `missing_column` uses `medium`
- The reconciliation SQL `<pre>` block is preserved as-is at the bottom

**Todo List:**
- [ ] In `mergeHtml()`, build a `Map<conflictId, BobResolutionSummary>` from `r.bobResolutions` (or empty map if undefined)
- [ ] Add Bob banner HTML block: shown only when `r.bobResolutions && r.bobResolutions.length > 0`
- [ ] Add conflict type breakdown summary line in header
- [ ] Update per-row badge color logic to use a proper severity map per `conflictType`
- [ ] For each conflict row, look up the Bob resolution by `conflictId()` key and render:
  - Confidence pill alongside the type badge
  - Affected files sub-list (up to 5, then "…and N more")
  - Migration plan as a numbered `<ol>` when non-empty
  - Risks as a `⚠` prefixed `<ul>` when non-empty
- [ ] Add a small CSS block for the new elements (confidence pill, bob-banner, migration-step) inside the existing `<style>` tag in `baseHtml()`

**Relevant Context:**
- [`src/dashboard/dashboardPanel.ts`](src/dashboard/dashboardPanel.ts) — `mergeHtml()` at line 182
- [`src/dashboard/dashboardPanel.ts`](src/dashboard/dashboardPanel.ts) — `baseHtml()` CSS at line 96; `esc()` helper at line 270
- [`src/mergeAnalyzer/bobBridge.ts`](src/mergeAnalyzer/bobBridge.ts) — `conflictId()` function at line 77 (the same key format `"type::table::column"` is used to match Bob resolutions to conflicts)

**Status:** `[ ] pending`

---

## File Change Summary

| File | Sub-Task | Change |
|------|----------|--------|
| `src/core/types.ts` | 1 | Add `BobResolutionSummary` interface + `bobResolutions?` field in `MergeAnalysisResult` |
| `src/mergeAnalyzer/mergeAnalyzer.ts` | 2 | Populate `bobResolutions` in `enrichWithBob()` return value |
| `src/dashboard/dashboardPanel.ts` | 3 | Enhance `mergeHtml()` with Bob banner, confidence pills, affected files, migration steps |

No other files are touched.

---

## Success Criteria

- [ ] `tsc --noEmit` passes with zero type errors
- [ ] Running `dbscope.mergeDatabases` with two schemas that have conflicts shows the conflict table
- [ ] When Bob is available and runs, the dashboard shows the "🤖 AI-Enhanced by IBM Bob" banner
- [ ] Each Bob-analyzed conflict shows a `92%` confidence pill next to the type badge
- [ ] Affected files listed under the conflict suggestion
- [ ] Migration plan steps visible as a numbered list
- [ ] When Bob is unavailable, the dashboard shows no banner and no confidence pills — pure deterministic view unchanged
- [ ] All 31 existing `mergeAnalyzer.test.js` tests still pass (no logic changed, only data passed through)
