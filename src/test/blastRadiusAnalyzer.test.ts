/**
 * src/test/blastRadiusAnalyzer.test.ts
 * Unit tests for Member 1 — AI-Powered BlastRadiusAnalyzer
 *
 * Run with:  node --require ts-node/register src/test/blastRadiusAnalyzer.test.ts
 *
 * Uses only Node's built-in `assert` — no external test framework required.
 * Uses StubWatsonxClient so tests run fully offline without real API credentials.
 */

import * as assert from 'assert';
import { parseSql, parseSqlAI } from '../utils/sqlParser';
import { TableDefinition, DatabaseSchema } from '../core/types';
import { BlastRadiusAnalyzer } from '../blastRadius/blastRadiusAnalyzer';
import { SchemaStateMap } from '../core/schemaStateMap';

// ─── StubWatsonxClient ────────────────────────────────────────────────────────
// Returns pre-baked JSON strings so tests run offline with no API credentials.

class StubWatsonxClient {
  constructor(private responses: Record<string, string> = {}) {}

  async ask(system: string, _user: string, _maxTokens?: number): Promise<string> {
    // Match on a keyword in the system prompt to route to the right stub response
    for (const [key, resp] of Object.entries(this.responses)) {
      if (system.toLowerCase().includes(key.toLowerCase())) {
        return resp;
      }
    }
    // Default: return a minimal valid JSON for each prompt type
    if (system.includes('SQL parser')) {
      return JSON.stringify({ operation: 'UNKNOWN', tables: [], columns: [], isDestructive: false });
    }
    if (system.includes('schema-level impacts')) {
      return JSON.stringify({ breakingChanges: [], nonBreakingChanges: [], cascadeEffects: [], confidenceScore: 50, confidenceReason: 'stub' });
    }
    if (system.includes('data integrity risks')) {
      return JSON.stringify({ risks: [], confidenceScore: 50, confidenceReason: 'stub' });
    }
    if (system.includes('rollback')) {
      return JSON.stringify({ rollbacks: [{ description: 'stub rollback', sql: '-- stub', safetyLevel: 'manual_review' }] });
    }
    if (system.includes('code reviewer')) {
      return JSON.stringify({ results: [] });
    }
    // Risk score prompt
    return JSON.stringify({
      score: 5,
      explanation: 'stub explanation',
      suggestions: [],
      confidence: {
        overall:            { confidenceScore: 60, confidenceReason: 'stub' },
        schemaImpact:       { confidenceScore: 70, confidenceReason: 'stub' },
        appDependencies:    { confidenceScore: 50, confidenceReason: 'stub' },
        dataIntegrityRisks: { confidenceScore: 40, confidenceReason: 'stub' },
        documentationDrift: { confidenceScore: 80, confidenceReason: 'stub' },
      },
    });
  }
}

// ─── StubSchemaStateMap ───────────────────────────────────────────────────────

class StubSchemaStateMap {
  constructor(private tables: Record<string, TableDefinition> = {}) {}

  getTable(name: string): TableDefinition | null { return this.tables[name] ?? null; }
  getAllTableNames(): string[] { return Object.keys(this.tables); }
  async getCurrentSchema(): Promise<DatabaseSchema | null> { return null; }
  async updateSchema(): Promise<void> {}
  async getHistory() { return []; }
}

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): void {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result
        .then(() => { console.log(`  ✅ ${name}`); passed++; })
        .catch(err => { console.error(`  ❌ ${name}\n     ${err.message}`); failed++; });
    } else {
      console.log(`  ✅ ${name}`);
      passed++;
    }
  } catch (err: any) {
    console.error(`  ❌ ${name}\n     ${err.message}`);
    failed++;
  }
}

// ─── Schema fixture ───────────────────────────────────────────────────────────

const stubSchema = new StubSchemaStateMap({
  users: {
    name: 'users',
    indexes: [],
    rowCount: 500_000,
    columns: {
      id:    { name: 'id',    type: 'INTEGER', nullable: false, isPrimaryKey: true,  isForeignKey: false },
      email: { name: 'email', type: 'VARCHAR', nullable: false, isPrimaryKey: false, isForeignKey: false },
      phone: { name: 'phone', type: 'VARCHAR', nullable: true,  isPrimaryKey: false, isForeignKey: false },
    },
  },
  orders: {
    name: 'orders',
    indexes: [],
    rowCount: 2_000_000,
    columns: {
      id:      { name: 'id',      type: 'INTEGER', nullable: false, isPrimaryKey: true,  isForeignKey: false },
      user_id: { name: 'user_id', type: 'INTEGER', nullable: false, isPrimaryKey: false, isForeignKey: true,
                 referencesTable: 'users', referencesColumn: 'id' },
    },
  },
});

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log('\n🧪 BlastRadiusAnalyzer — AI Integration Tests\n');

// ── parseSql (sync fallback) ──────────────────────────────────────────────────

test('parseSql (fallback): DROP TABLE extracts operation and table name', () => {
  const result = parseSql('DROP TABLE users');
  assert.strictEqual(result.operation, 'DROP');
  assert.deepStrictEqual(result.tables, ['users']);
  assert.strictEqual(result.isDestructive, true);
});

test('parseSql (fallback): schema-qualified name strips schema prefix', () => {
  const result = parseSql('SELECT * FROM public.orders WHERE id = 1');
  assert.ok(result.tables.includes('orders'), `Expected 'orders', got: ${result.tables}`);
  assert.ok(!result.tables.includes('public'), `'public' should not be in tables`);
});

// ── parseSqlAI ────────────────────────────────────────────────────────────────

test('parseSqlAI: Granite parses CTE DELETE correctly', async () => {
  const stub = new StubWatsonxClient({
    'SQL parser': JSON.stringify({
      operation: 'DELETE',
      tables: ['orders', 'deleted_users'],
      columns: [],
      isDestructive: true,
    }),
  });
  const result = await parseSqlAI(
    'WITH deleted_users AS (SELECT id FROM users WHERE deleted_at < NOW()) DELETE FROM orders WHERE user_id IN (SELECT id FROM deleted_users)',
    stub
  );
  assert.strictEqual(result.operation, 'DELETE');
  assert.ok(result.tables.includes('orders'), `Expected orders in tables: ${result.tables}`);
  assert.strictEqual(result.isDestructive, true);
});

test('parseSqlAI: falls back to regex parser when AI throws', async () => {
  const throwingStub = { ask: async () => { throw new Error('network error'); } };
  const result = await parseSqlAI('DROP TABLE users', throwingStub);
  // Fallback regex parser should still extract the operation
  assert.strictEqual(result.operation, 'DROP');
  assert.ok(result.tables.includes('users'));
});

// ── analyzeSchemaImpact via full analyze() ────────────────────────────────────

test('analyze(): AI schema impact — breaking changes returned from Granite', async () => {
  const stub = new StubWatsonxClient({
    'schema-level impacts': JSON.stringify({
      breakingChanges:    ['DROP COLUMN phone destroys data permanently'],
      nonBreakingChanges: [],
      cascadeEffects:     [],
      confidenceScore:    88,
      confidenceReason:   'Full schema loaded for users table',
    }),
  });
  const analyzer = new BlastRadiusAnalyzer(stubSchema as unknown as SchemaStateMap, stub as any);
  const result   = await analyzer.analyze('ALTER TABLE users DROP COLUMN phone');
  assert.ok(result.schemaImpact.breakingChanges.length >= 1,
    'Expected at least 1 breaking change from Granite');
  assert.ok(result.schemaImpact.breakingChanges[0].includes('phone') ||
            result.schemaImpact.breakingChanges[0].toLowerCase().includes('drop'),
    `Unexpected breaking change: ${result.schemaImpact.breakingChanges[0]}`);
});

// ── assessDataIntegrityRisks via full analyze() ───────────────────────────────

test('analyze(): AI data risks — critical risk for DELETE without WHERE', async () => {
  const stub = new StubWatsonxClient({
    'data integrity risks': JSON.stringify({
      risks: [
        { description: 'DELETE without WHERE will remove ALL rows', severity: 'critical' },
      ],
      confidenceScore:  65,
      confidenceReason: 'Row count known but DB version unknown',
    }),
  });
  const analyzer = new BlastRadiusAnalyzer(stubSchema as unknown as SchemaStateMap, stub as any);
  const result   = await analyzer.analyze('DELETE FROM orders');
  assert.ok(result.dataIntegrityRisks.length >= 1);
  assert.ok(result.dataIntegrityRisks.some(r => r.severity === 'critical'),
    `Expected a critical risk, got: ${JSON.stringify(result.dataIntegrityRisks)}`);
});

// ── calculateRiskScore via full analyze() ────────────────────────────────────

test('analyze(): AI risk score + explanation populated from Granite', async () => {
  const stub = new StubWatsonxClient();  // default stub returns score=5, explanation='stub explanation'
  const analyzer = new BlastRadiusAnalyzer(stubSchema as unknown as SchemaStateMap, stub as any);
  const result   = await analyzer.analyze('ALTER TABLE orders DROP COLUMN user_id');
  assert.ok(result.riskScore >= 1 && result.riskScore <= 10,
    `Risk score out of range: ${result.riskScore}`);
  assert.ok(result.riskExplanation.length > 0,
    'riskExplanation should be populated');
});

// ── Confidence: per-dimension scores ─────────────────────────────────────────

test('analyze(): confidence object has all 5 dimensions populated', async () => {
  const stub = new StubWatsonxClient();
  const analyzer = new BlastRadiusAnalyzer(stubSchema as unknown as SchemaStateMap, stub as any);
  const result   = await analyzer.analyze('DROP TABLE users');
  const conf     = result.confidence;
  assert.ok(conf,                      'confidence should be present');
  assert.ok(conf.overall,              'confidence.overall should be present');
  assert.ok(conf.schemaImpact,         'confidence.schemaImpact should be present');
  assert.ok(conf.appDependencies,      'confidence.appDependencies should be present');
  assert.ok(conf.dataIntegrityRisks,   'confidence.dataIntegrityRisks should be present');
  assert.ok(conf.documentationDrift,   'confidence.documentationDrift should be present');
});

test('analyze(): per-dimension confidenceScore comes from Granite response', async () => {
  const stub = new StubWatsonxClient({
    'senior DBA': JSON.stringify({
      score: 8,
      explanation: 'High risk drop operation',
      suggestions: [],
      confidence: {
        overall:            { confidenceScore: 55, confidenceReason: 'Partial context' },
        schemaImpact:       { confidenceScore: 90, confidenceReason: 'Full schema loaded' },
        appDependencies:    { confidenceScore: 30, confidenceReason: 'No files scanned' },
        dataIntegrityRisks: { confidenceScore: 40, confidenceReason: 'Row count unknown' },
        documentationDrift: { confidenceScore: 60, confidenceReason: 'README found' },
      },
    }),
  });
  const analyzer = new BlastRadiusAnalyzer(stubSchema as unknown as SchemaStateMap, stub as any);
  const result   = await analyzer.analyze('DROP TABLE users');
  assert.strictEqual(result.confidence.schemaImpact.confidenceScore, 90,
    `Expected schemaImpact confidenceScore=90, got ${result.confidence.schemaImpact.confidenceScore}`);
  assert.strictEqual(result.confidence.appDependencies.confidenceScore, 30,
    `Expected appDependencies confidenceScore=30, got ${result.confidence.appDependencies.confidenceScore}`);
  assert.strictEqual(result.confidence.dataIntegrityRisks.confidenceScore, 40,
    `Expected dataIntegrityRisks confidenceScore=40, got ${result.confidence.dataIntegrityRisks.confidenceScore}`);
});

// ── Fallback: arithmetic score when AI throws ─────────────────────────────────

test('analyze(): arithmetic fallback activates when AI throws on score call', async () => {
  // Stub that throws on the risk scoring prompt (senior DBA) but works for others
  const partialStub = {
    async ask(system: string, _user: string): Promise<string> {
      if (system.includes('senior DBA')) { throw new Error('quota exceeded'); }
      if (system.includes('SQL parser')) {
        return JSON.stringify({ operation: 'DROP', tables: ['users'], columns: [], isDestructive: true });
      }
      if (system.includes('schema-level impacts')) {
        return JSON.stringify({ breakingChanges: ['DROP TABLE removes all data'], nonBreakingChanges: [], cascadeEffects: [], confidenceScore: 80, confidenceReason: 'schema loaded' });
      }
      if (system.includes('data integrity risks')) {
        return JSON.stringify({ risks: [{ description: 'irreversible', severity: 'critical' }], confidenceScore: 60, confidenceReason: 'stub' });
      }
      if (system.includes('rollback')) {
        return JSON.stringify({ rollbacks: [{ description: 'recreate', sql: 'CREATE TABLE users (...)', safetyLevel: 'manual_review' }] });
      }
      return JSON.stringify({ results: [] });
    },
  };
  const analyzer = new BlastRadiusAnalyzer(stubSchema as unknown as SchemaStateMap, partialStub as any);
  const result   = await analyzer.analyze('DROP TABLE users');
  // Should still return a valid result with riskScore >= 1
  assert.ok(result.riskScore >= 1, `Expected riskScore >= 1, got ${result.riskScore}`);
  assert.strictEqual(result.riskExplanation, 'AI unavailable — score computed from rule-based heuristics.');
  assert.strictEqual(result.confidence.overall.confidenceScore, 0,
    'UNAVAILABLE confidence should have confidenceScore=0');
});

// ── buildRollbackSuggestions via full analyze() ───────────────────────────────

test('analyze(): AI rollback contains AI-written SQL from Granite', async () => {
  const stub = new StubWatsonxClient({
    'rollback': JSON.stringify({
      rollbacks: [{
        description: 'Re-add phone column to users',
        sql: 'ALTER TABLE users ADD COLUMN phone VARCHAR(20);',
        safetyLevel: 'safe',
      }],
    }),
  });
  const analyzer = new BlastRadiusAnalyzer(stubSchema as unknown as SchemaStateMap, stub as any);
  const result   = await analyzer.analyze('ALTER TABLE users DROP COLUMN phone');
  assert.ok(result.rollbackSuggestions.length >= 1);
  assert.ok(result.rollbackSuggestions.some(r => r.sql.toLowerCase().includes('phone')),
    `Expected rollback SQL to mention phone, got: ${result.rollbackSuggestions.map(r => r.sql).join(' | ')}`);
});

// ─── Summary ──────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n──────────────────────────────────────`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) { process.exit(1); }
}, 500);
