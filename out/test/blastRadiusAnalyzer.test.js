"use strict";
/**
 * src/test/blastRadiusAnalyzer.test.ts
 * Unit tests for Member 1 — BlastRadiusAnalyzer + sqlParser
 *
 * Run with:  node --require ts-node/register src/test/blastRadiusAnalyzer.test.ts
 *
 * Uses only Node's built-in `assert` — no external test framework required.
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
class StubSchemaStateMap {
    constructor(tables = {}) {
        this.tables = tables;
    }
    getTable(name) {
        return this.tables[name] ?? null;
    }
    getAllTableNames() { return Object.keys(this.tables); }
    async getCurrentSchema() { return null; }
    async updateSchema() { }
    async getHistory() { return []; }
}
// ─── Minimal BlastRadiusAnalyzer (private-method-testable subclass) ──────────
// We expose the private methods via a thin subclass so we can test them
// without spinning up a full VS Code workspace (findFiles / openTextDocument
// are VS Code API calls — not available in plain Node).
const blastRadiusAnalyzer_1 = require("../blastRadius/blastRadiusAnalyzer");
class TestableAnalyzer extends blastRadiusAnalyzer_1.BlastRadiusAnalyzer {
    // Expose private methods for direct testing via type assertion
    testSchemaImpact(sql) {
        const parsed = (0, sqlParser_1.parseSql)(sql);
        return this.analyzeSchemaImpact(parsed);
    }
    testDataRisks(sql) {
        const parsed = (0, sqlParser_1.parseSql)(sql);
        return this.assessDataIntegrityRisks(parsed);
    }
    testRollbacks(sql) {
        const parsed = (0, sqlParser_1.parseSql)(sql);
        return this.buildRollbackSuggestions(parsed);
    }
    testScore(schema, deps, data, docs, tables) {
        return this.calculateRiskScore(schema, deps, data, docs, tables);
    }
    testDeriveModelName(tableName) {
        return this.deriveModelName(tableName);
    }
}
// ─── Test runner helpers ──────────────────────────────────────────────────────
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
        console.error(`  ❌ ${name}\n     ${err.message}`);
        failed++;
    }
}
// ─── Test setup ──────────────────────────────────────────────────────────────
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
const analyzer = new TestableAnalyzer(stubSchema);
// ─── Tests ───────────────────────────────────────────────────────────────────
console.log('\n🧪 BlastRadiusAnalyzer — Unit Tests\n');
// ── parseSql ──────────────────────────────────────────────────────────────────
test('parseSql: DROP TABLE extracts operation and table name', () => {
    const result = (0, sqlParser_1.parseSql)('DROP TABLE users');
    assert.strictEqual(result.operation, 'DROP');
    assert.deepStrictEqual(result.tables, ['users']);
    assert.strictEqual(result.isDestructive, true);
});
test('parseSql: schema-qualified name strips schema prefix', () => {
    const result = (0, sqlParser_1.parseSql)('SELECT * FROM public.orders WHERE id = 1');
    assert.ok(result.tables.includes('orders'), `Expected 'orders', got: ${result.tables}`);
    assert.ok(!result.tables.includes('public'), `'public' should not be in tables`);
});
// ── analyzeSchemaImpact ───────────────────────────────────────────────────────
test('analyzeSchemaImpact: DROP COLUMN is a breaking change', async () => {
    const impact = await analyzer.testSchemaImpact('ALTER TABLE users DROP COLUMN phone');
    assert.ok(impact.breakingChanges.length >= 1, 'Should have at least 1 breaking change');
    assert.ok(impact.breakingChanges.some((c) => /DROP COLUMN/i.test(c)));
});
test('analyzeSchemaImpact: ADD COLUMN (nullable) is non-breaking', async () => {
    const impact = await analyzer.testSchemaImpact('ALTER TABLE users ADD COLUMN nickname VARCHAR(100)');
    assert.strictEqual(impact.breakingChanges.length, 0, 'Should have NO breaking changes');
    assert.ok(impact.nonBreakingChanges.length >= 1, 'Should have at least 1 non-breaking change');
});
// ── assessDataIntegrityRisks ──────────────────────────────────────────────────
test('assessDataIntegrityRisks: DELETE without WHERE is critical', async () => {
    const risks = await analyzer.testDataRisks('DELETE FROM orders');
    assert.ok(risks.length >= 1);
    assert.ok(risks.some((r) => r.severity === 'critical'));
});
test('assessDataIntegrityRisks: DELETE with WHERE has no critical risk', async () => {
    const risks = await analyzer.testDataRisks("DELETE FROM orders WHERE status = 'cancelled'");
    assert.ok(!risks.some((r) => r.severity === 'critical'), `Unexpected critical risks: ${risks.map((r) => r.description).join(', ')}`);
});
// ── calculateRiskScore ────────────────────────────────────────────────────────
test('calculateRiskScore: critical SQL with large table scores >= 7', () => {
    const schema = { breakingChanges: ['DROP COLUMN destroys column data permanently'], nonBreakingChanges: [], cascadeEffects: [] };
    const deps = [{ severity: 'critical', filePath: 'x.ts', tableName: 'orders', usage: 'del', lineNumber: 1 }];
    const data = [{ description: 'DELETE without WHERE', severity: 'critical' }];
    const docs = [{ filePath: 'README.md', issue: '...', suggestion: '...' }];
    const score = analyzer.testScore(schema, deps, data, docs, ['orders']);
    assert.ok(score >= 7, `Expected score >= 7, got ${score}`);
});
// ── buildRollbackSuggestions ──────────────────────────────────────────────────
test('buildRollbackSuggestions: DROP COLUMN generates ADD COLUMN rollback', () => {
    const rollbacks = analyzer.testRollbacks('ALTER TABLE users DROP COLUMN phone');
    assert.ok(rollbacks.length >= 1, 'Should generate at least one rollback');
    assert.ok(rollbacks.some((r) => /ADD COLUMN phone/i.test(r.sql)), `Expected rollback to contain ADD COLUMN phone, got: ${rollbacks.map((r) => r.sql).join(' | ')}`);
});
// ── deriveModelName ───────────────────────────────────────────────────────────
test('deriveModelName: plurals and snake_case correctly singularised', () => {
    assert.strictEqual(analyzer.testDeriveModelName('users'), 'User');
    assert.strictEqual(analyzer.testDeriveModelName('categories'), 'Category');
    assert.strictEqual(analyzer.testDeriveModelName('order_items'), 'OrderItem');
    assert.strictEqual(analyzer.testDeriveModelName('statuses'), 'Status');
});
// ─── Summary ─────────────────────────────────────────────────────────────────
setTimeout(() => {
    console.log(`\n──────────────────────────────────────`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}, 200);
//# sourceMappingURL=blastRadiusAnalyzer.test.js.map