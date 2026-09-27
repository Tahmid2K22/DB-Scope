"use strict";
/**
 * src/test/blastRadiusAnalyzer.test.ts
 * Unit tests for Member 1 — AI-Powered BlastRadiusAnalyzer
 *
 * Run with:  node --require ts-node/register src/test/blastRadiusAnalyzer.test.ts
 *
 * Uses only Node's built-in `assert` — no external test framework required.
 * Uses StubWatsonxClient so tests run fully offline without real API credentials.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const assert = __importStar(require("assert"));
const sqlParser_1 = require("../utils/sqlParser");
const blastRadiusAnalyzer_1 = require("../blastRadius/blastRadiusAnalyzer");
// ─── StubWatsonxClient ────────────────────────────────────────────────────────
// Returns pre-baked JSON strings so tests run offline with no API credentials.
class StubWatsonxClient {
    constructor(responses = {}) {
        this.responses = responses;
    }
    async ask(system, _user, _maxTokens) {
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
                overall: { confidenceScore: 60, confidenceReason: 'stub' },
                schemaImpact: { confidenceScore: 70, confidenceReason: 'stub' },
                appDependencies: { confidenceScore: 50, confidenceReason: 'stub' },
                dataIntegrityRisks: { confidenceScore: 40, confidenceReason: 'stub' },
                documentationDrift: { confidenceScore: 80, confidenceReason: 'stub' },
            },
        });
    }
}
// ─── StubSchemaStateMap ───────────────────────────────────────────────────────
class StubSchemaStateMap {
    constructor(tables = {}) {
        this.tables = tables;
    }
    getTable(name) { return this.tables[name] ?? null; }
    getAllTableNames() { return Object.keys(this.tables); }
    async getCurrentSchema() { return null; }
    async updateSchema() { }
    async getHistory() { return []; }
}
// ─── Test runner ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function test(name, fn) {
    try {
        const result = fn();
        if (result instanceof Promise) {
            result
                .then(() => { console.log(`  ✅ ${name}`); passed++; })
                .catch(err => { console.error(`  ❌ ${name}\n     ${err.message}`); failed++; });
        }
        else {
            console.log(`  ✅ ${name}`);
            passed++;
        }
    }
    catch (err) {
        console.error(`  ❌ ${name}\n     ${err instanceof Error ? err.message : String(err)}`);
        failed++;
    }
}
// ─── Schema fixture ───────────────────────────────────────────────────────────
const stubSchema = new StubSchemaStateMap({
    users: {
        name: 'users',
        indexes: [],
        rowCount: 500000,
        columns: {
            id: { name: 'id', type: 'INTEGER', nullable: false, isPrimaryKey: true, isForeignKey: false },
            email: { name: 'email', type: 'VARCHAR', nullable: false, isPrimaryKey: false, isForeignKey: false },
            phone: { name: 'phone', type: 'VARCHAR', nullable: true, isPrimaryKey: false, isForeignKey: false },
        },
    },
    orders: {
        name: 'orders',
        indexes: [],
        rowCount: 2000000,
        columns: {
            id: { name: 'id', type: 'INTEGER', nullable: false, isPrimaryKey: true, isForeignKey: false },
            user_id: { name: 'user_id', type: 'INTEGER', nullable: false, isPrimaryKey: false, isForeignKey: true,
                referencesTable: 'users', referencesColumn: 'id' },
        },
    },
});
// ─── Tests ───────────────────────────────────────────────────────────────────
console.log('\n🧪 BlastRadiusAnalyzer — AI Integration Tests\n');
// ── parseSql (sync fallback) ──────────────────────────────────────────────────
test('parseSql (fallback): DROP TABLE extracts operation and table name', () => {
    const result = (0, sqlParser_1.parseSql)('DROP TABLE users');
    assert.strictEqual(result.operation, 'DROP');
    assert.deepStrictEqual(result.tables, ['users']);
    assert.strictEqual(result.isDestructive, true);
});
test('parseSql (fallback): schema-qualified name strips schema prefix', () => {
    const result = (0, sqlParser_1.parseSql)('SELECT * FROM public.orders WHERE id = 1');
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
    const result = await (0, sqlParser_1.parseSqlAI)('WITH deleted_users AS (SELECT id FROM users WHERE deleted_at < NOW()) DELETE FROM orders WHERE user_id IN (SELECT id FROM deleted_users)', stub);
    assert.strictEqual(result.operation, 'DELETE');
    assert.ok(result.tables.includes('orders'), `Expected orders in tables: ${result.tables}`);
    assert.strictEqual(result.isDestructive, true);
});
test('parseSqlAI: falls back to regex parser when AI throws', async () => {
    const throwingStub = { ask: async () => { throw new Error('network error'); } };
    const result = await (0, sqlParser_1.parseSqlAI)('DROP TABLE users', throwingStub);
    // Fallback regex parser should still extract the operation
    assert.strictEqual(result.operation, 'DROP');
    assert.ok(result.tables.includes('users'));
});
// ── analyzeSchemaImpact via full analyze() ────────────────────────────────────
test('analyze(): AI schema impact — breaking changes returned from Granite', async () => {
    const stub = new StubWatsonxClient({
        'schema-level impacts': JSON.stringify({
            breakingChanges: ['DROP COLUMN phone destroys data permanently'],
            nonBreakingChanges: [],
            cascadeEffects: [],
            confidenceScore: 88,
            confidenceReason: 'Full schema loaded for users table',
        }),
    });
    const analyzer = new blastRadiusAnalyzer_1.BlastRadiusAnalyzer(stubSchema, stub);
    const result = await analyzer.analyze('ALTER TABLE users DROP COLUMN phone');
    assert.ok(result.schemaImpact.breakingChanges.length >= 1, 'Expected at least 1 breaking change from Granite');
    assert.ok(result.schemaImpact.breakingChanges[0].includes('phone') ||
        result.schemaImpact.breakingChanges[0].toLowerCase().includes('drop'), `Unexpected breaking change: ${result.schemaImpact.breakingChanges[0]}`);
});
// ── assessDataIntegrityRisks via full analyze() ───────────────────────────────
test('analyze(): AI data risks — critical risk for DELETE without WHERE', async () => {
    const stub = new StubWatsonxClient({
        'data integrity risks': JSON.stringify({
            risks: [
                { description: 'DELETE without WHERE will remove ALL rows', severity: 'critical' },
            ],
            confidenceScore: 65,
            confidenceReason: 'Row count known but DB version unknown',
        }),
    });
    const analyzer = new blastRadiusAnalyzer_1.BlastRadiusAnalyzer(stubSchema, stub);
    const result = await analyzer.analyze('DELETE FROM orders');
    assert.ok(result.dataIntegrityRisks.length >= 1);
    assert.ok(result.dataIntegrityRisks.some(r => r.severity === 'critical'), `Expected a critical risk, got: ${JSON.stringify(result.dataIntegrityRisks)}`);
});
// ── calculateRiskScore via full analyze() ────────────────────────────────────
test('analyze(): AI risk score + explanation populated from Granite', async () => {
    const stub = new StubWatsonxClient(); // default stub returns score=5, explanation='stub explanation'
    const analyzer = new blastRadiusAnalyzer_1.BlastRadiusAnalyzer(stubSchema, stub);
    const result = await analyzer.analyze('ALTER TABLE orders DROP COLUMN user_id');
    assert.ok(result.riskScore >= 1 && result.riskScore <= 10, `Risk score out of range: ${result.riskScore}`);
    assert.ok(result.riskExplanation.length > 0, 'riskExplanation should be populated');
});
// ── Confidence: per-dimension scores ─────────────────────────────────────────
test('analyze(): confidence object has all 5 dimensions populated', async () => {
    const stub = new StubWatsonxClient();
    const analyzer = new blastRadiusAnalyzer_1.BlastRadiusAnalyzer(stubSchema, stub);
    const result = await analyzer.analyze('DROP TABLE users');
    const conf = result.confidence;
    assert.ok(conf, 'confidence should be present');
    assert.ok(conf.overall, 'confidence.overall should be present');
    assert.ok(conf.schemaImpact, 'confidence.schemaImpact should be present');
    assert.ok(conf.appDependencies, 'confidence.appDependencies should be present');
    assert.ok(conf.dataIntegrityRisks, 'confidence.dataIntegrityRisks should be present');
    assert.ok(conf.documentationDrift, 'confidence.documentationDrift should be present');
});
test('analyze(): per-dimension confidenceScore comes from Granite response', async () => {
    const stub = new StubWatsonxClient({
        'senior DBA': JSON.stringify({
            score: 8,
            explanation: 'High risk drop operation',
            suggestions: [],
            confidence: {
                overall: { confidenceScore: 55, confidenceReason: 'Partial context' },
                schemaImpact: { confidenceScore: 90, confidenceReason: 'Full schema loaded' },
                appDependencies: { confidenceScore: 30, confidenceReason: 'No files scanned' },
                dataIntegrityRisks: { confidenceScore: 40, confidenceReason: 'Row count unknown' },
                documentationDrift: { confidenceScore: 60, confidenceReason: 'README found' },
            },
        }),
    });
    const analyzer = new blastRadiusAnalyzer_1.BlastRadiusAnalyzer(stubSchema, stub);
    const result = await analyzer.analyze('DROP TABLE users');
    assert.strictEqual(result.confidence.schemaImpact.confidenceScore, 90, `Expected schemaImpact confidenceScore=90, got ${result.confidence.schemaImpact.confidenceScore}`);
    assert.strictEqual(result.confidence.appDependencies.confidenceScore, 30, `Expected appDependencies confidenceScore=30, got ${result.confidence.appDependencies.confidenceScore}`);
    assert.strictEqual(result.confidence.dataIntegrityRisks.confidenceScore, 40, `Expected dataIntegrityRisks confidenceScore=40, got ${result.confidence.dataIntegrityRisks.confidenceScore}`);
});
// ── Fallback: arithmetic score when AI throws ─────────────────────────────────
test('analyze(): arithmetic fallback activates when AI throws on score call', async () => {
    // Stub that throws on the risk scoring prompt (senior DBA) but works for others
    const partialStub = {
        async ask(system, _user) {
            if (system.includes('senior DBA')) {
                throw new Error('quota exceeded');
            }
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
    const analyzer = new blastRadiusAnalyzer_1.BlastRadiusAnalyzer(stubSchema, partialStub);
    const result = await analyzer.analyze('DROP TABLE users');
    // Should still return a valid result with riskScore >= 1
    assert.ok(result.riskScore >= 1, `Expected riskScore >= 1, got ${result.riskScore}`);
    assert.strictEqual(result.riskExplanation, 'AI unavailable — score computed from rule-based heuristics.');
    assert.strictEqual(result.confidence.overall.confidenceScore, 0, 'UNAVAILABLE confidence should have confidenceScore=0');
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
    const analyzer = new blastRadiusAnalyzer_1.BlastRadiusAnalyzer(stubSchema, stub);
    const result = await analyzer.analyze('ALTER TABLE users DROP COLUMN phone');
    assert.ok(result.rollbackSuggestions.length >= 1);
    assert.ok(result.rollbackSuggestions.some(r => r.sql.toLowerCase().includes('phone')), `Expected rollback SQL to mention phone, got: ${result.rollbackSuggestions.map(r => r.sql).join(' | ')}`);
});
// ─── Summary ──────────────────────────────────────────────────────────────────
setTimeout(() => {
    console.log(`\n──────────────────────────────────────`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}, 500);
//# sourceMappingURL=blastRadiusAnalyzer.test.js.map