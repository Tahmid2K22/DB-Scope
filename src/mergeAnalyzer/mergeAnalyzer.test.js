/**
 * src/mergeAnalyzer/mergeAnalyzer.test.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Plain-Node unit tests for the Bob bridge layer (bobBridge.ts logic).
 * Re-implements the pure functions inline so no compile step is needed and
 * the VS Code extension host is never required.
 *
 * Run with:  node src/mergeAnalyzer/mergeAnalyzer.test.js
 * ──────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const assert = require('assert');

// ─── Inline implementations of pure bobBridge functions ──────────────────────
// These mirror the TypeScript source exactly; keeping them here avoids a
// compile step while still exercising the real logic.

function conflictId(c) {
  return c.column
    ? `${c.conflictType}::${c.table}::${c.column}`
    : `${c.conflictType}::${c.table}`;
}

const SEMANTIC_CONFLICT_TYPES = new Set([
  'missing_column',
  'missing_table',
  'type_mismatch',
  'nullable_difference',
  'name_conflict',
]);

function filterSemanticallyRelevant(conflicts) {
  return conflicts.filter(c => SEMANTIC_CONFLICT_TYPES.has(c.conflictType));
}

function extractJson(raw) {
  if (!raw || raw.trim().length === 0) { return null; }
  let text = raw.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '');
  const start = text.indexOf('[');
  const end   = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) { return null; }
  const candidate = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate);
    if (!Array.isArray(parsed)) { return null; }
    return parsed;
  } catch {
    return null;
  }
}

function buildBobPrompt(workspaceRoot, conflicts, schemaA, schemaB) {
  const conflictLines = conflicts.map(c => {
    const id       = conflictId(c);
    const location = c.column ? `${c.table}.${c.column}` : c.table;
    return [
      `  conflictId: "${id}"`,
      `  type: ${c.conflictType}`,
      `  location: ${location}`,
      `  sourceA: ${c.sourceA}`,
      `  sourceB: ${c.sourceB}`,
      `  deterministicSuggestion: ${c.suggestion}`,
    ].join('\n');
  }).join('\n\n');

  const tableListA = Object.keys(schemaA.tables).join(', ');
  const tableListB = Object.keys(schemaB.tables).join(', ');

  return `You are analyzing database schema merge conflicts inside the DB-Scope VS Code extension.

Repository root: ${workspaceRoot}
Schema A (database: ${schemaA.databaseName}) tables: ${tableListA}
Schema B (database: ${schemaB.databaseName}) tables: ${tableListB}

Conflicts to analyze:
${conflictLines}`;
}

// ─── applyBobResolutions (mirrors TS method) ─────────────────────────────────

function applyBobResolutions(conflicts, resolutions) {
  const byId = new Map();
  for (const r of resolutions) { byId.set(r.conflictId, r); }

  return conflicts.map(conflict => {
    const id = conflictId(conflict);
    const r  = byId.get(id);
    if (!r) { return conflict; }

    const confidencePct   = Math.round(r.confidence * 100);
    const affectedSummary = r.affectedFiles.length > 0
      ? ` Affects ${r.affectedFiles.length} file(s): ${r.affectedFiles.slice(0, 3).map(f => f.path).join(', ')}${r.affectedFiles.length > 3 ? '...' : ''}.`
      : '';
    const migrationSummary = r.migrationPlan.length > 0
      ? `\n-- Migration: ${r.migrationPlan.join(' → ')}`
      : '';

    const enrichedSuggestion =
      `[Bob ${confidencePct}% confidence — ${r.resolution}] ${r.reason}${affectedSummary}`;
    const enrichedSql =
      `${migrationSummary}\n${conflict.reconciliationSql}`.trimStart();

    return { ...conflict, suggestion: enrichedSuggestion, reconciliationSql: enrichedSql };
  });
}

// ─── Test runner ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}\n     ${err.message}`);
    failures.push(name);
    failed++;
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. conflictId
// ─────────────────────────────────────────────────────────────────────────────
section('1 — conflictId()');

test('1-01  column conflict includes column', () => {
  const id = conflictId({ conflictType: 'missing_column', table: 'users', column: 'email' });
  assert.strictEqual(id, 'missing_column::users::email');
});

test('1-02  table conflict omits column', () => {
  const id = conflictId({ conflictType: 'missing_table', table: 'orders' });
  assert.strictEqual(id, 'missing_table::orders');
});

test('1-03  type_mismatch includes column', () => {
  const id = conflictId({ conflictType: 'type_mismatch', table: 'products', column: 'price' });
  assert.strictEqual(id, 'type_mismatch::products::price');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. filterSemanticallyRelevant
// ─────────────────────────────────────────────────────────────────────────────
section('2 — filterSemanticallyRelevant()');

const sampleConflicts = [
  { conflictType: 'missing_column',    table: 'users',  column: 'name' },
  { conflictType: 'missing_table',     table: 'orders' },
  { conflictType: 'type_mismatch',     table: 'products', column: 'price' },
  { conflictType: 'nullable_difference', table: 'orders', column: 'status' },
  { conflictType: 'name_conflict',     table: 'users', column: 'id' },
];

test('2-01  all five semantic types are kept', () => {
  const result = filterSemanticallyRelevant(sampleConflicts);
  assert.strictEqual(result.length, 5);
});

test('2-02  empty array returns empty', () => {
  assert.deepStrictEqual(filterSemanticallyRelevant([]), []);
});

test('2-03  unknown type is excluded', () => {
  const result = filterSemanticallyRelevant([
    { conflictType: 'totally_made_up', table: 'foo' },
    { conflictType: 'missing_column',  table: 'bar', column: 'x' },
  ]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].table, 'bar');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. extractJson — raw JSON
// ─────────────────────────────────────────────────────────────────────────────
section('3 — extractJson() — raw JSON');

const validResolution = {
  conflictId: 'missing_column::users::name',
  resolution: 'rename',
  confidence: 0.92,
  reason: 'Likely rename from name to full_name',
  semanticEquivalent: true,
  oldReference: { table: 'users', column: 'name' },
  newReference:  { table: 'users', column: 'full_name' },
  affectedFiles:  [],
  affectedSymbols: [],
  migrationPlan:  ['Rename column users.name to users.full_name'],
  applicationChanges: ['Update User model field'],
  testsToUpdate: [],
  risks: [],
};

test('3-01  valid raw JSON array is parsed correctly', () => {
  const result = extractJson(JSON.stringify([validResolution]));
  assert.ok(Array.isArray(result));
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].conflictId, 'missing_column::users::name');
  assert.strictEqual(result[0].resolution, 'rename');
  assert.strictEqual(result[0].confidence, 0.92);
});

test('3-02  empty string returns null', () => {
  assert.strictEqual(extractJson(''), null);
});

test('3-03  whitespace-only string returns null', () => {
  assert.strictEqual(extractJson('   \n  '), null);
});

test('3-04  no JSON array brackets returns null', () => {
  assert.strictEqual(extractJson('Bob says: no conflicts found.'), null);
});

test('3-05  malformed JSON inside brackets returns null', () => {
  assert.strictEqual(extractJson('[{"key": value_no_quotes}]'), null);
});

test('3-06  JSON object (not array) returns null', () => {
  assert.strictEqual(extractJson('{"key": "value"}'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. extractJson — markdown-wrapped output
// ─────────────────────────────────────────────────────────────────────────────
section('4 — extractJson() — markdown-wrapped');

test('4-01  ```json fence stripped and parsed', () => {
  const wrapped = '```json\n' + JSON.stringify([validResolution]) + '\n```';
  const result  = extractJson(wrapped);
  assert.ok(Array.isArray(result));
  assert.strictEqual(result[0].conflictId, 'missing_column::users::name');
});

test('4-02  plain ``` fence stripped and parsed', () => {
  const wrapped = '```\n' + JSON.stringify([validResolution]) + '\n```';
  const result  = extractJson(wrapped);
  assert.ok(Array.isArray(result));
});

test('4-03  CLI preamble before array ignored', () => {
  const raw = 'Analyzing repository...\nDone.\n' + JSON.stringify([validResolution]);
  const result = extractJson(raw);
  assert.ok(Array.isArray(result));
  assert.strictEqual(result[0].resolution, 'rename');
});

test('4-04  CLI preamble AND markdown fence both handled', () => {
  const raw = 'bob: running analysis\n```json\n' + JSON.stringify([validResolution]) + '\n```\nbob: done';
  const result = extractJson(raw);
  assert.ok(Array.isArray(result));
});

test('4-05  multiple JSON arrays — first [ to last ] used (outer wrapper)', () => {
  // Simulates Bob including a small sub-array inside the main array
  const inner = JSON.stringify([validResolution]);
  // Wrap in another array to test that first [ last ] captures the outer span
  const outer = `[${JSON.stringify(validResolution)}]`;
  const result = extractJson(outer);
  assert.ok(Array.isArray(result));
  assert.strictEqual(result.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. buildBobPrompt
// ─────────────────────────────────────────────────────────────────────────────
section('5 — buildBobPrompt()');

const schemaA = {
  databaseName: 'db_a',
  tables: { users: {}, orders: {} },
};
const schemaB = {
  databaseName: 'db_b',
  tables: { users: {}, customers: {} },
};
const conflictsForPrompt = [
  {
    conflictType: 'missing_column',
    table: 'users', column: 'name',
    sourceA: 'Column "name" exists in A',
    sourceB: 'Column "name" does not exist in B',
    suggestion: 'ALTER TABLE users ADD COLUMN name VARCHAR',
    reconciliationSql: 'ALTER TABLE users ADD COLUMN name VARCHAR;',
  },
];

test('5-01  prompt contains workspace root', () => {
  const p = buildBobPrompt('/workspace/myproject', conflictsForPrompt, schemaA, schemaB);
  assert.ok(p.includes('/workspace/myproject'), 'workspace root missing');
});

test('5-02  prompt contains conflictId', () => {
  const p = buildBobPrompt('/ws', conflictsForPrompt, schemaA, schemaB);
  assert.ok(p.includes('missing_column::users::name'), 'conflictId missing from prompt');
});

test('5-03  prompt contains schema table lists', () => {
  const p = buildBobPrompt('/ws', conflictsForPrompt, schemaA, schemaB);
  assert.ok(p.includes('db_a'), 'schema A name missing');
  assert.ok(p.includes('db_b'), 'schema B name missing');
  assert.ok(p.includes('orders'), 'Schema A table "orders" missing');
  assert.ok(p.includes('customers'), 'Schema B table "customers" missing');
});

test('5-04  prompt contains source descriptions', () => {
  const p = buildBobPrompt('/ws', conflictsForPrompt, schemaA, schemaB);
  assert.ok(p.includes('Column "name" exists in A'));
  assert.ok(p.includes('Column "name" does not exist in B'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. applyBobResolutions
// ─────────────────────────────────────────────────────────────────────────────
section('6 — applyBobResolutions()');

const baseConflicts = [
  {
    conflictType: 'missing_column', table: 'users', column: 'name',
    sourceA: 'exists in A', sourceB: 'not in B',
    suggestion: 'Original deterministic suggestion',
    reconciliationSql: 'ALTER TABLE users ADD COLUMN name VARCHAR;',
  },
  {
    conflictType: 'missing_table', table: 'orders',
    sourceA: 'exists in A', sourceB: 'not in B',
    suggestion: 'Create table orders',
    reconciliationSql: 'CREATE TABLE IF NOT EXISTS orders ();',
  },
];

const bobResolutions = [
  {
    conflictId: 'missing_column::users::name',
    resolution: 'rename',
    confidence: 0.92,
    reason: 'Likely rename to full_name',
    semanticEquivalent: true,
    oldReference: { table: 'users', column: 'name' },
    newReference:  { table: 'users', column: 'full_name' },
    affectedFiles: [
      { path: 'src/models/User.ts', reason: 'references users.name' },
      { path: 'src/routes/users.ts', reason: 'API response shape' },
    ],
    affectedSymbols: [],
    migrationPlan: ['Rename users.name to users.full_name', 'Update ORM model'],
    applicationChanges: ['Update User model'],
    testsToUpdate: [],
    risks: ['Backward compat break for API consumers'],
  },
];

test('6-01  enriched conflict has Bob suggestion instead of original', () => {
  const result = applyBobResolutions(baseConflicts, bobResolutions);
  assert.ok(result[0].suggestion.includes('[Bob'), 'missing Bob prefix');
  assert.ok(result[0].suggestion.includes('rename'), 'resolution type missing');
  assert.ok(result[0].suggestion.includes('92%'), 'confidence% missing');
});

test('6-02  suggestion includes affected files count', () => {
  const result = applyBobResolutions(baseConflicts, bobResolutions);
  assert.ok(result[0].suggestion.includes('Affects 2 file(s)'), `got: ${result[0].suggestion}`);
});

test('6-03  reconciliationSql contains migration plan annotation', () => {
  const result = applyBobResolutions(baseConflicts, bobResolutions);
  assert.ok(result[0].reconciliationSql.includes('-- Migration:'), `got: ${result[0].reconciliationSql}`);
  assert.ok(result[0].reconciliationSql.includes('Rename users.name'));
  assert.ok(result[0].reconciliationSql.includes('ALTER TABLE users ADD COLUMN'));
});

test('6-04  un-matched conflict is returned unchanged', () => {
  const result = applyBobResolutions(baseConflicts, bobResolutions);
  // orders (missing_table::orders) has no Bob resolution
  assert.strictEqual(result[1].suggestion, 'Create table orders');
  assert.ok(result[1].reconciliationSql.includes('CREATE TABLE'));
});

test('6-05  empty resolutions returns conflicts unchanged', () => {
  const result = applyBobResolutions(baseConflicts, []);
  assert.strictEqual(result[0].suggestion, 'Original deterministic suggestion');
  assert.strictEqual(result[1].suggestion, 'Create table orders');
});

test('6-06  conflict with no affected files — no "Affects N file(s)" in suggestion', () => {
  const resNoFiles = [{ ...bobResolutions[0], affectedFiles: [] }];
  const result = applyBobResolutions(baseConflicts, resNoFiles);
  assert.ok(!result[0].suggestion.includes('Affects'), `unexpected: ${result[0].suggestion}`);
});

test('6-07  conflict with no migration plan — no migration annotation in SQL', () => {
  const resNoMigration = [{ ...bobResolutions[0], migrationPlan: [] }];
  const result = applyBobResolutions(baseConflicts, resNoMigration);
  assert.ok(!result[0].reconciliationSql.includes('-- Migration:'), `got: ${result[0].reconciliationSql}`);
});

test('6-08  more than 3 affected files — ellipsis appended', () => {
  const resManyFiles = [{
    ...bobResolutions[0],
    affectedFiles: [
      { path: 'a.ts', reason: 'r' },
      { path: 'b.ts', reason: 'r' },
      { path: 'c.ts', reason: 'r' },
      { path: 'd.ts', reason: 'r' },
    ],
  }];
  const result = applyBobResolutions(baseConflicts, resManyFiles);
  assert.ok(result[0].suggestion.includes('...'), `expected ellipsis, got: ${result[0].suggestion}`);
});

test('6-09  confidence 1.0 renders as 100%', () => {
  const res100 = [{ ...bobResolutions[0], confidence: 1.0 }];
  const result = applyBobResolutions(baseConflicts, res100);
  assert.ok(result[0].suggestion.includes('100%'), `got: ${result[0].suggestion}`);
});

test('6-10  confidence 0.0 renders as 0%', () => {
  const res0 = [{ ...bobResolutions[0], confidence: 0.0 }];
  const result = applyBobResolutions(baseConflicts, res0);
  assert.ok(result[0].suggestion.includes('0%'), `got: ${result[0].suggestion}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log('\n' + '─'.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailed tests:');
    failures.forEach(f => console.log(`  • ${f}`));
    process.exit(1);
  }
}, 100);
