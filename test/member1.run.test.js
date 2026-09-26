/**
 * test/member1.run.test.js
 * ════════════════════════════════════════════════════════════════════════════
 * Self-contained Node.js test runner — NO vscode, NO ts-node, NO npm install
 * Runs with: node test/member1.run.test.js
 *
 * Inlines the pure logic from:
 *   src/utils/sqlParser.ts
 *   src/blastRadius/blastRadiusAnalyzer.ts  (all private methods)
 *   src/hoverProvider/sqlHoverProvider.ts   (all private methods)
 * ════════════════════════════════════════════════════════════════════════════
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// ─────────────────────────────────────────────────────────────────────────────
// INLINED: parseSql  (src/utils/sqlParser.ts)
// ─────────────────────────────────────────────────────────────────────────────

const TABLE_PATTERNS = {
  FROM:   [/\bFROM\s+([`"]?[\w.]+[`"]?)/gi],
  JOIN:   [/\bJOIN\s+([`"]?[\w.]+[`"]?)/gi],
  INTO:   [/\bINTO\s+([`"]?[\w.]+[`"]?)/gi],
  UPDATE: [/\bUPDATE\s+([`"]?[\w.]+[`"]?)/gi],
  TABLE:  [/\bTABLE\s+(?:IF\s+EXISTS\s+)?([`"]?[\w.]+[`"]?)/gi],
  ON:     [/\bON\s+([`"]?[\w.]+[`"]?)\s*\(/gi],   // CREATE INDEX ... ON table(cols)
};

const DESTRUCTIVE_OPS = ['DELETE', 'DROP', 'TRUNCATE', 'ALTER'];

const SQL_KEYWORDS = new Set([
  'SELECT','FROM','WHERE','AND','OR','NOT','IN','IS','NULL',
  'JOIN','LEFT','RIGHT','INNER','OUTER','FULL','CROSS','ON',
  'GROUP','BY','ORDER','HAVING','LIMIT','OFFSET','UNION','ALL',
  'INSERT','INTO','VALUES','UPDATE','SET','DELETE','TRUNCATE',
  'CREATE','ALTER','DROP','TABLE','INDEX','VIEW','DATABASE',
  'PRIMARY','KEY','FOREIGN','REFERENCES','CONSTRAINT','UNIQUE',
  'DEFAULT','NOT','NULL','AUTO_INCREMENT','SERIAL','CASCADE',
]);

function detectOperation(sql) {
  const first = sql.split(/\s+/)[0].toUpperCase();
  const ops = ['SELECT','INSERT','UPDATE','DELETE','ALTER','DROP','CREATE','TRUNCATE'];
  return ops.find(op => op === first) ?? 'UNKNOWN';
}

function extractTables(sql) {
  const tables = [];
  for (const patterns of Object.values(TABLE_PATTERNS)) {
    for (const pattern of patterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = regex.exec(sql)) !== null) {
        const table = match[1].replace(/[`"]/g, '');
        const tableName = table.includes('.') ? table.split('.').pop() : table;
        if (!SQL_KEYWORDS.has(tableName.toUpperCase())) {
          tables.push(tableName);
        }
      }
    }
  }
  return tables;
}

function extractColumns(sql) {
  const colPattern = /\b(?:ADD|DROP|MODIFY)\s+(?:COLUMN\s+)?([`"]?[\w]+[`"]?)/gi;
  const columns = [];
  let match;
  while ((match = colPattern.exec(sql)) !== null) {
    columns.push(match[1].replace(/[`"]/g, ''));
  }
  return columns;
}

function parseSql(sql) {
  const normalized = sql.trim().replace(/\s+/g, ' ');
  const operation  = detectOperation(normalized);
  const tables     = extractTables(normalized);
  const columns    = extractColumns(normalized);
  return {
    operation,
    tables:      [...new Set(tables)],
    columns:     [...new Set(columns)],
    isDestructive: DESTRUCTIVE_OPS.includes(operation),
    rawSql:      sql,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// INLINED: BlastRadiusAnalyzer private methods
// ─────────────────────────────────────────────────────────────────────────────

// Stub SchemaStateMap
class StubSchema {
  constructor(tables = {}) { this._tables = tables; }
  getTable(name) { return this._tables[name] ?? null; }
}

// All pure (non-vscode) logic extracted from BlastRadiusAnalyzer
const Analyzer = {

  analyzeSchemaImpact(parsed, schema) {
    const breaking = [], nonBreaking = [], cascade = [];
    const sql = parsed.rawSql;

    if (parsed.operation === 'DROP') {
      breaking.push('DROP TABLE removes all data and invalidates all foreign key references');
    }
    if (parsed.operation === 'ALTER') {
      if (/DROP\s+COLUMN/i.test(sql))              breaking.push('DROP COLUMN destroys column data permanently');
      if (/RENAME\s+(?:COLUMN|TABLE)/i.test(sql))  breaking.push('RENAME will break all existing queries and ORM mappings');
      if (/\bMODIFY\b|\bCHANGE\b/i.test(sql))      breaking.push('Column type change may cause data truncation or conversion errors');
      if (/ADD\s+COLUMN/i.test(sql))               nonBreaking.push('ADD COLUMN is backward-compatible if nullable or has a default');
      if (/ADD.*NOT\s+NULL/i.test(sql) && !/DEFAULT/i.test(sql))
        breaking.push('NOT NULL constraint without DEFAULT will fail on existing rows');
    }
    if (parsed.operation === 'DELETE')   breaking.push('DELETE may cascade to child tables via foreign key constraints');
    if (parsed.operation === 'TRUNCATE') breaking.push('TRUNCATE removes ALL rows — irreversible without a backup');

    for (const tableName of parsed.tables) {
      const table = schema.getTable(tableName);
      if (table) {
        for (const col of Object.values(table.columns)) {
          if (col.isForeignKey && col.referencesTable)
            cascade.push(`Foreign key ${tableName}.${col.name} → ${col.referencesTable}.${col.referencesColumn}`);
        }
      }
    }
    return { breakingChanges: breaking, nonBreakingChanges: nonBreaking, cascadeEffects: cascade };
  },

  assessDataIntegrityRisks(parsed) {
    const risks = [];
    const sql = parsed.rawSql;

    if (parsed.operation === 'DELETE'  && !/WHERE/i.test(sql))
      risks.push({ description: 'DELETE without WHERE clause — will remove ALL rows in the table', severity: 'critical' });
    if (parsed.operation === 'UPDATE'  && !/WHERE/i.test(sql))
      risks.push({ description: 'UPDATE without WHERE clause — will update ALL rows in the table', severity: 'critical' });
    if (/ALTER.*DROP\s+COLUMN/i.test(sql))
      risks.push({ description: 'DROP COLUMN is irreversible — ensure a backup exists before proceeding', severity: 'high' });
    if (/NOT\s+NULL/i.test(sql) && !/DEFAULT/i.test(sql) && !/ADD\s+COLUMN/i.test(sql))
      risks.push({ description: 'Adding NOT NULL constraint without DEFAULT will fail if any existing row has NULL', severity: 'high' });
    if (/\bCASCADE\b/i.test(sql))
      risks.push({ description: 'CASCADE operation will propagate to all child tables — audit foreign key references', severity: 'medium' });
    if (/ALTER\s+TABLE.*DROP\s+FOREIGN\s+KEY/i.test(sql))
      risks.push({ description: 'DROP FOREIGN KEY removes referential integrity — orphan rows may be created', severity: 'high' });
    if (/ALTER\s+TABLE.*DROP\s+PRIMARY\s+KEY/i.test(sql))
      risks.push({ description: 'DROP PRIMARY KEY makes the table unaddressable by index — severe performance impact', severity: 'high' });
    if (/CREATE\s+UNIQUE\s+INDEX/i.test(sql))
      risks.push({ description: 'CREATE UNIQUE INDEX will fail if existing rows contain duplicate values in the indexed column(s)', severity: 'high' });
    if (/ENGINE\s*=/i.test(sql))
      risks.push({ description: 'Changing storage ENGINE (e.g. InnoDB → MyISAM) rewrites the entire table and is not easily reversible', severity: 'medium' });

    return risks;
  },

  buildRollbackSuggestions(parsed, schema) {
    const rollbacks = [];
    const sql = parsed.rawSql;

    if (parsed.operation === 'DROP') {
      for (const tableName of parsed.tables) {
        const table = schema.getTable(tableName);
        if (table) {
          const cols = Object.values(table.columns).map(c => {
            let def = `  ${c.name} ${c.type}`;
            if (!c.nullable)    def += ' NOT NULL';
            if (c.isPrimaryKey) def += ' PRIMARY KEY';
            return def;
          }).join(',\n');
          rollbacks.push({
            description: `Recreate table "${tableName}" from last known schema snapshot`,
            sql: `CREATE TABLE IF NOT EXISTS ${tableName} (\n${cols}\n);`,
            safetyLevel: 'manual_review',
          });
        } else {
          rollbacks.push({
            description: `Cannot auto-generate rollback for "${tableName}" — no schema snapshot available`,
            sql: '-- Run "DB-Scope: Fetch Database Context" before the migration to enable auto-rollback',
            safetyLevel: 'destructive',
          });
        }
      }
      return rollbacks;
    }

    const dropColMatch = /ALTER\s+TABLE\s+(\w+)\s+DROP\s+COLUMN\s+(\w+)/i.exec(sql);
    if (dropColMatch) {
      const [, tbl, col] = dropColMatch;
      const colDef = schema.getTable(tbl)?.columns[col];
      const typePart = colDef ? `${colDef.type}${colDef.nullable ? '' : ' NOT NULL'}` : 'TEXT /* original type unknown */';
      rollbacks.push({
        description: `Re-add column "${col}" to "${tbl}"`,
        sql: `ALTER TABLE ${tbl} ADD COLUMN ${col} ${typePart};`,
        safetyLevel: colDef ? 'safe' : 'manual_review',
      });
    }

    const addColMatch = /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/i.exec(sql);
    if (addColMatch) {
      const [, tbl, col] = addColMatch;
      rollbacks.push({
        description: `Remove newly added column "${col}" from "${tbl}"`,
        sql: `ALTER TABLE ${tbl} DROP COLUMN ${col};`,
        safetyLevel: 'safe',
      });
    }

    const renameColMatch = /ALTER\s+TABLE\s+(\w+)\s+RENAME\s+COLUMN\s+(\w+)\s+TO\s+(\w+)/i.exec(sql);
    if (renameColMatch) {
      const [, tbl, from, to] = renameColMatch;
      rollbacks.push({
        description: `Rename column "${to}" back to "${from}" on table "${tbl}"`,
        sql: `ALTER TABLE ${tbl} RENAME COLUMN ${to} TO ${from};`,
        safetyLevel: 'safe',
      });
    }

    const renameTblMatch = /RENAME\s+TABLE\s+(\w+)\s+TO\s+(\w+)/i.exec(sql);
    if (renameTblMatch) {
      const [, from, to] = renameTblMatch;
      rollbacks.push({
        description: `Rename table "${to}" back to "${from}"`,
        sql: `RENAME TABLE ${to} TO ${from};`,
        safetyLevel: 'safe',
      });
    }

    const createIdxMatch = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(\w+)/i.exec(sql);
    if (createIdxMatch) {
      const [, idxName] = createIdxMatch;
      rollbacks.push({
        description: `Drop the newly created index "${idxName}"`,
        sql: `DROP INDEX ${idxName};`,
        safetyLevel: 'safe',
      });
    }

    if (parsed.operation === 'DELETE' || parsed.operation === 'TRUNCATE') {
      rollbacks.push({
        description: 'No automatic rollback available for data deletion',
        sql: '-- Take a point-in-time backup (pg_dump / mysqldump) BEFORE running this statement.',
        safetyLevel: 'destructive',
      });
    }

    return rollbacks;
  },

  deriveModelName(tableName) {
    const pascal = tableName
      .split('_')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join('');
    if (pascal.endsWith('ies')) return pascal.slice(0, -3) + 'y';
    if (pascal.endsWith('ses')) return pascal.slice(0, -2);
    if (pascal.endsWith('s') && !pascal.endsWith('ss')) return pascal.slice(0, -1);
    return pascal;
  },

  classifyDepSeverity(lineText) {
    const line = lineText.toLowerCase();
    if (/delete|drop|truncate|remove/.test(line)) return 'critical';
    if (/update|alter|modify|insert/.test(line))  return 'high';
    if (/select|find|fetch|get|query/.test(line)) return 'medium';
    return 'low';
  },

  getTableSizeFactor(tables, schema) {
    let maxRows = 0;
    for (const tableName of tables) {
      const table = schema.getTable(tableName);
      if (table?.rowCount && table.rowCount > maxRows) maxRows = table.rowCount;
    }
    if (maxRows > 1_000_000) return 1.5;
    if (maxRows > 100_000)   return 1.25;
    if (maxRows > 10_000)    return 1.1;
    return 1.0;
  },

  scoreToLevel(score) {
    if (score >= 8) return 'critical';
    if (score >= 6) return 'high';
    if (score >= 4) return 'medium';
    return 'low';
  },

  calculateRiskScore(schemaImpact, deps, data, docs, tables, schema) {
    let score = 0;
    score += Math.min(schemaImpact.breakingChanges.length * 2, 4);
    score += Math.min(schemaImpact.cascadeEffects.length * 0.5, 1);
    score += Math.min(deps.filter(d => d.severity === 'critical').length, 2);
    score += Math.min(data.filter(r => r.severity === 'critical').length * 2, 2);
    score += Math.min(data.filter(r => r.severity === 'high').length, 1);
    score += Math.min(docs.length * 0.25, 1);
    const sizeFactor = Analyzer.getTableSizeFactor(tables, schema);
    score = score * sizeFactor;
    return Math.min(Math.max(Math.round(score), 1), 10);
  },

  buildSuggestions(schemaImpact, deps, data, score) {
    const suggestions = [];
    if (schemaImpact.breakingChanges.some(c => c.includes('NOT NULL')))
      suggestions.push('Make the column NULLABLE first, backfill data, then add the NOT NULL constraint');
    if (schemaImpact.breakingChanges.some(c => c.includes('DROP')))
      suggestions.push('Consider renaming the column/table first (soft-delete approach) instead of immediate DROP');
    if (data.some(r => r.description.includes('without WHERE')))
      suggestions.push('Add a WHERE clause or use a transaction with a dry-run SELECT count first');
    if (deps.length > 5)
      suggestions.push(`Update ${deps.length} affected files before applying migration`);
    if (score >= 7)
      suggestions.push('This migration scores HIGH RISK — require DBA approval before deploying to production');
    return suggestions;
  },

  exportResult(result, targetDir) {
    const tableSlug = (result.affectedTables[0] ?? 'unknown').replace(/[^a-z0-9]/gi, '-');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename  = `blast-radius-${tableSlug}-${timestamp}.json`;
    const filePath  = path.join(targetDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
    return filePath;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// INLINED: SqlHoverProvider private methods
// ─────────────────────────────────────────────────────────────────────────────

const HoverProvider = {

  extractSqlFromString(text, baseOffset) {
    // baseOffset unused in pure logic tests — positions tested separately
    const patterns = [
      /`(\s*(?:SELECT|INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)[\s\S]+?)`/i,
      /"((?:SELECT|INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)[^"]+)"/i,
      /'((?:SELECT|INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)[^']+)'/i,
    ];
    for (const pattern of patterns) {
      const m = pattern.exec(text);
      if (m) {
        const sqlContent = m[1].trim().replace(/\$\{[^}]*\}/g, '?');
        return { sql: sqlContent, matchIndex: m.index };
      }
    }
    return null;
  },

  extractStatementAt(text, offset) {
    let pos = 0;
    for (const stmt of text.split(';')) {
      const end = pos + stmt.length;
      if (offset >= pos && offset <= end) {
        const trimmed = stmt.trim();
        if (!trimmed) return null;
        return { sql: trimmed };
      }
      pos = end + 1;
    }
    const trimmed = text.trim();
    return trimmed ? { sql: trimmed } : null;
  },

  riskEmoji(level) {
    return { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' }[level];
  },

  buildHoverText(result) {
    // Returns plain string (equivalent of MarkdownString.value) for testing
    let md = '';
    md += `### ${HoverProvider.riskEmoji(result.riskLevel)} DB-Scope Impact Analysis\n\n`;
    md += `**Risk Score:** ${result.riskScore}/10 — \`${result.riskLevel.toUpperCase()}\`\n\n`;

    if (result.affectedTables.length > 0)
      md += `**Affected Tables:** ${result.affectedTables.map(t => `\`${t}\``).join(', ')}\n\n`;

    if (result.schemaImpact.breakingChanges.length > 0) {
      md += `**⚠ Breaking Changes:**\n`;
      for (const c of result.schemaImpact.breakingChanges) md += `- ${c}\n`;
      md += '\n';
    }

    if (result.dataIntegrityRisks.length > 0) {
      md += `**🔴 Data Risks:**\n`;
      for (const r of result.dataIntegrityRisks.slice(0, 3)) md += `- ${r.description}\n`;
      md += '\n';
    }

    if (result.schemaImpact.cascadeEffects.length > 0)
      md += `**🔗 Cascade Effects:** ${result.schemaImpact.cascadeEffects.length} foreign key(s) affected\n\n`;

    if (result.suggestions.length > 0) {
      md += `**💡 Suggestions:**\n`;
      for (const s of result.suggestions.slice(0, 2)) md += `- ${s}\n`;
      md += '\n';
    }

    if (result.rollbackSuggestions && result.rollbackSuggestions.length > 0) {
      md += `**↩ Rollback:**\n`;
      for (const r of result.rollbackSuggestions.slice(0, 2)) {
        const icon = r.safetyLevel === 'safe' ? '✅' : r.safetyLevel === 'manual_review' ? '⚠' : '🔴';
        md += `- ${icon} \`${r.sql.split('\n')[0].slice(0, 80)}\`\n`;
      }
      md += '\n';
    }

    md += `---\n_[Open Full Analysis](command:dbscope.analyzeBlastRadius)_`;
    return md;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES
// ─────────────────────────────────────────────────────────────────────────────

const TABLES = {
  users: {
    name: 'users', indexes: [], rowCount: 50_000,
    columns: {
      id:      { name: 'id',      type: 'INTEGER', nullable: false, isPrimaryKey: true,  isForeignKey: false },
      email:   { name: 'email',   type: 'VARCHAR', nullable: false, isPrimaryKey: false, isForeignKey: false },
      phone:   { name: 'phone',   type: 'VARCHAR', nullable: true,  isPrimaryKey: false, isForeignKey: false },
      role_id: { name: 'role_id', type: 'INTEGER', nullable: false, isPrimaryKey: false, isForeignKey: true,
                 referencesTable: 'roles', referencesColumn: 'id' },
    },
  },
  orders: {
    name: 'orders', indexes: [], rowCount: 2_000_000,
    columns: {
      id:      { name: 'id',      type: 'INTEGER', nullable: false, isPrimaryKey: true,  isForeignKey: false },
      user_id: { name: 'user_id', type: 'INTEGER', nullable: false, isPrimaryKey: false, isForeignKey: true,
                 referencesTable: 'users', referencesColumn: 'id' },
      total:   { name: 'total',   type: 'DECIMAL', nullable: false, isPrimaryKey: false, isForeignKey: false },
    },
  },
  tiny:  { name: 'tiny',  indexes: [], rowCount: 50,        columns: {} },
  mid:   { name: 'mid',   indexes: [], rowCount: 15_000,    columns: {} },
  big:   { name: 'big',   indexes: [], rowCount: 200_000,   columns: {} },
  huge:  { name: 'huge',  indexes: [], rowCount: 5_000_000, columns: {} },
};

const schema      = new StubSchema(TABLES);
const emptySchema = new StubSchema({});

const emptySchemaImpact = { breakingChanges: [], nonBreakingChanges: [], cascadeEffects: [] };

// ─────────────────────────────────────────────────────────────────────────────
// TEST RUNNER
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      // sync-only for simplicity — all inlined logic is sync
      r.catch(err => { console.error(`  ❌  ${name}\n       ${err.message}`); failures.push(name); failed++; });
    }
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌  ${name}`);
    console.error(`       ${err.message}`);
    failures.push(`${name}: ${err.message}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  ${title}`);
  console.log(`${'─'.repeat(64)}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — parseSql
// ═════════════════════════════════════════════════════════════════════════════
section('1  parseSql');

test('1-01  SELECT: operation=SELECT, isDestructive=false', () => {
  const r = parseSql('SELECT id, name FROM users WHERE id = 1');
  assert.strictEqual(r.operation, 'SELECT');
  assert.strictEqual(r.isDestructive, false);
  assert.ok(r.tables.includes('users'));
});

test('1-02  INSERT: extracts table from INTO clause', () => {
  const r = parseSql("INSERT INTO orders (user_id, total) VALUES (1, 99.99)");
  assert.strictEqual(r.operation, 'INSERT');
  assert.ok(r.tables.includes('orders'));
});

test('1-03  UPDATE: isDestructive=false (UPDATE not in DESTRUCTIVE_OPS)', () => {
  const r = parseSql("UPDATE users SET email='x@y.com' WHERE id=1");
  assert.strictEqual(r.operation, 'UPDATE');
  assert.strictEqual(r.isDestructive, false);
  assert.ok(r.tables.includes('users'));
});

test('1-04  DELETE: operation=DELETE, isDestructive=true', () => {
  const r = parseSql('DELETE FROM orders WHERE id = 42');
  assert.strictEqual(r.operation, 'DELETE');
  assert.strictEqual(r.isDestructive, true);
  assert.ok(r.tables.includes('orders'));
});

test('1-05  ALTER: operation=ALTER, isDestructive=true', () => {
  const r = parseSql('ALTER TABLE users DROP COLUMN phone');
  assert.strictEqual(r.operation, 'ALTER');
  assert.strictEqual(r.isDestructive, true);
  assert.ok(r.tables.includes('users'));
});

test('1-06  DROP TABLE: tables=[users]', () => {
  const r = parseSql('DROP TABLE users');
  assert.strictEqual(r.operation, 'DROP');
  assert.deepStrictEqual(r.tables, ['users']);
});

test('1-07  CREATE TABLE: operation=CREATE', () => {
  const r = parseSql('CREATE TABLE sessions (id INTEGER PRIMARY KEY)');
  assert.strictEqual(r.operation, 'CREATE');
  assert.ok(r.tables.includes('sessions'));
});

test('1-08  TRUNCATE: isDestructive=true', () => {
  const r = parseSql('TRUNCATE TABLE logs');
  assert.strictEqual(r.operation, 'TRUNCATE');
  assert.strictEqual(r.isDestructive, true);
});

test('1-09  EXPLAIN → UNKNOWN operation', () => {
  const r = parseSql('EXPLAIN SELECT * FROM users');
  assert.strictEqual(r.operation, 'UNKNOWN');
});

test('1-10  Schema-qualified public.users → tables=[users], no "public"', () => {
  const r = parseSql('SELECT * FROM public.users');
  assert.ok(r.tables.includes('users'), `Got: ${r.tables}`);
  assert.ok(!r.tables.includes('public'));
});

test('1-11  JOIN extracts both tables', () => {
  const r = parseSql('SELECT * FROM orders JOIN users ON orders.user_id = users.id');
  assert.ok(r.tables.includes('orders'));
  assert.ok(r.tables.includes('users'));
});

test('1-12  Duplicate table name deduplicated', () => {
  const r = parseSql('SELECT * FROM users u1, users u2');
  assert.strictEqual(r.tables.filter(t => t === 'users').length, 1);
});

test('1-13  Mixed-case keywords parsed correctly', () => {
  const r = parseSql('select * from Users where id=1');
  assert.strictEqual(r.operation, 'SELECT');
});

test('1-14  extractColumns: ADD and DROP column names captured', () => {
  const r = parseSql('ALTER TABLE users ADD COLUMN nickname VARCHAR(100), DROP COLUMN old_field');
  assert.ok(r.columns.includes('nickname'), `columns=${r.columns}`);
  assert.ok(r.columns.includes('old_field'), `columns=${r.columns}`);
});

test('1-15  rawSql preserved verbatim (whitespace not normalised)', () => {
  const raw = '  SELECT   *   FROM   users  ';
  assert.strictEqual(parseSql(raw).rawSql, raw);
});

test('1-16  SQL keywords not treated as table names (GROUP, BY, WHERE)', () => {
  const r = parseSql('SELECT * FROM orders WHERE id IN (1,2,3) GROUP BY status');
  const upper = r.tables.map(t => t.toUpperCase());
  for (const kw of ['GROUP','BY','WHERE','IN']) {
    assert.ok(!upper.includes(kw), `"${kw}" should not be a table`);
  }
});

test('1-17  DROP INDEX: operation=DROP', () => {
  assert.strictEqual(parseSql('DROP INDEX idx_users_email').operation, 'DROP');
});

test('1-18  CREATE UNIQUE INDEX: operation=CREATE, table extracted via ON clause', () => {
  const r = parseSql('CREATE UNIQUE INDEX idx_email ON users(email)');
  assert.strictEqual(r.operation, 'CREATE');
  assert.ok(r.tables.includes('users'), `Got tables: ${r.tables}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — analyzeSchemaImpact
// ═════════════════════════════════════════════════════════════════════════════
section('2  analyzeSchemaImpact');

test('2-01  DROP TABLE → breaking change', () => {
  const r = Analyzer.analyzeSchemaImpact(parseSql('DROP TABLE users'), schema);
  assert.ok(r.breakingChanges.length >= 1);
  assert.ok(r.breakingChanges.some(c => /DROP TABLE/i.test(c)));
});

test('2-02  ALTER DROP COLUMN → breaking change', () => {
  const r = Analyzer.analyzeSchemaImpact(parseSql('ALTER TABLE users DROP COLUMN phone'), schema);
  assert.ok(r.breakingChanges.some(c => /DROP COLUMN/i.test(c)));
});

test('2-03  ALTER ADD COLUMN (nullable) → non-breaking, no breaking', () => {
  const r = Analyzer.analyzeSchemaImpact(parseSql('ALTER TABLE users ADD COLUMN bio TEXT'), schema);
  assert.strictEqual(r.breakingChanges.length, 0);
  assert.ok(r.nonBreakingChanges.length >= 1);
});

test('2-04  ALTER ADD COLUMN NOT NULL no DEFAULT → breaking', () => {
  const r = Analyzer.analyzeSchemaImpact(parseSql('ALTER TABLE users ADD COLUMN score INT NOT NULL'), schema);
  assert.ok(r.breakingChanges.some(c => /NOT NULL/i.test(c)));
});

test('2-05  ALTER ADD COLUMN NOT NULL WITH DEFAULT → only non-breaking', () => {
  const r = Analyzer.analyzeSchemaImpact(parseSql('ALTER TABLE users ADD COLUMN score INT NOT NULL DEFAULT 0'), schema);
  assert.ok(!r.breakingChanges.some(c => /NOT NULL.*without DEFAULT/i.test(c)));
  assert.ok(r.nonBreakingChanges.length >= 1);
});

test('2-06  ALTER RENAME COLUMN → breaking change', () => {
  const r = Analyzer.analyzeSchemaImpact(parseSql('ALTER TABLE users RENAME COLUMN phone TO mobile'), schema);
  assert.ok(r.breakingChanges.some(c => /RENAME/i.test(c)));
});

test('2-07  ALTER MODIFY column → breaking change', () => {
  const r = Analyzer.analyzeSchemaImpact(parseSql('ALTER TABLE users MODIFY email TEXT'), schema);
  assert.ok(r.breakingChanges.some(c => /type change/i.test(c)));
});

test('2-08  DELETE → breaking change', () => {
  const r = Analyzer.analyzeSchemaImpact(parseSql('DELETE FROM orders WHERE id=1'), schema);
  assert.ok(r.breakingChanges.length >= 1);
});

test('2-09  TRUNCATE → breaking change', () => {
  const r = Analyzer.analyzeSchemaImpact(parseSql('TRUNCATE TABLE orders'), schema);
  assert.ok(r.breakingChanges.some(c => /TRUNCATE/i.test(c)));
});

test('2-10  CASCADE FK from schemaState appears in cascadeEffects', () => {
  const r = Analyzer.analyzeSchemaImpact(parseSql('SELECT * FROM users'), schema);
  assert.ok(r.cascadeEffects.some(c => c.includes('users.role_id')));
});

test('2-11  Unknown table → no cascade effects', () => {
  const r = Analyzer.analyzeSchemaImpact(parseSql('ALTER TABLE ghost DROP COLUMN x'), emptySchema);
  assert.strictEqual(r.cascadeEffects.length, 0);
});

test('2-12  SELECT → empty breaking and non-breaking arrays', () => {
  const r = Analyzer.analyzeSchemaImpact(parseSql('SELECT id FROM users'), schema);
  assert.strictEqual(r.breakingChanges.length, 0);
  assert.strictEqual(r.nonBreakingChanges.length, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — assessDataIntegrityRisks (9 rules)
// ═════════════════════════════════════════════════════════════════════════════
section('3  assessDataIntegrityRisks');

test('3-01  DELETE without WHERE → critical', () => {
  const r = Analyzer.assessDataIntegrityRisks(parseSql('DELETE FROM orders'));
  assert.ok(r.some(x => x.severity === 'critical' && /WHERE/.test(x.description)));
});

test('3-02  DELETE WITH WHERE → no critical', () => {
  const r = Analyzer.assessDataIntegrityRisks(parseSql("DELETE FROM orders WHERE status='done'"));
  assert.ok(!r.some(x => x.severity === 'critical'));
});

test('3-03  UPDATE without WHERE → critical', () => {
  const r = Analyzer.assessDataIntegrityRisks(parseSql('UPDATE users SET active=0'));
  assert.ok(r.some(x => x.severity === 'critical'));
});

test('3-04  UPDATE WITH WHERE → no critical', () => {
  const r = Analyzer.assessDataIntegrityRisks(parseSql('UPDATE users SET active=0 WHERE id=5'));
  assert.ok(!r.some(x => x.severity === 'critical'));
});

test('3-05  ALTER DROP COLUMN → high risk', () => {
  const r = Analyzer.assessDataIntegrityRisks(parseSql('ALTER TABLE users DROP COLUMN phone'));
  assert.ok(r.some(x => x.severity === 'high' && /DROP COLUMN/i.test(x.description)));
});

test('3-06  NOT NULL without DEFAULT (not ADD COLUMN) → high risk', () => {
  const r = Analyzer.assessDataIntegrityRisks(parseSql('ALTER TABLE users MODIFY score INT NOT NULL'));
  assert.ok(r.some(x => x.severity === 'high' && /NOT NULL/i.test(x.description)));
});

test('3-07  CASCADE keyword → medium risk', () => {
  const r = Analyzer.assessDataIntegrityRisks(parseSql('DELETE FROM users CASCADE'));
  assert.ok(r.some(x => x.severity === 'medium' && /CASCADE/i.test(x.description)));
});

test('3-08  DROP FOREIGN KEY → high risk', () => {
  const r = Analyzer.assessDataIntegrityRisks(parseSql('ALTER TABLE orders DROP FOREIGN KEY fk_user'));
  assert.ok(r.some(x => x.severity === 'high' && /FOREIGN KEY/i.test(x.description)));
});

test('3-09  DROP PRIMARY KEY → high risk', () => {
  const r = Analyzer.assessDataIntegrityRisks(parseSql('ALTER TABLE users DROP PRIMARY KEY'));
  assert.ok(r.some(x => x.severity === 'high' && /PRIMARY KEY/i.test(x.description)));
});

test('3-10  CREATE UNIQUE INDEX → high risk', () => {
  const r = Analyzer.assessDataIntegrityRisks(parseSql('CREATE UNIQUE INDEX idx_email ON users(email)'));
  assert.ok(r.some(x => x.severity === 'high' && /UNIQUE/i.test(x.description)));
});

test('3-11  ENGINE= change → medium risk', () => {
  const r = Analyzer.assessDataIntegrityRisks(parseSql('ALTER TABLE users ENGINE=MyISAM'));
  assert.ok(r.some(x => x.severity === 'medium' && /ENGINE/i.test(x.description)));
});

test('3-12  Safe SELECT → zero risks', () => {
  assert.strictEqual(Analyzer.assessDataIntegrityRisks(parseSql('SELECT * FROM users WHERE id=1')).length, 0);
});

test('3-13  Lowercase keywords still trigger rules', () => {
  const r = Analyzer.assessDataIntegrityRisks(parseSql('delete from orders'));
  assert.ok(r.some(x => x.severity === 'critical'));
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — buildRollbackSuggestions
// ═════════════════════════════════════════════════════════════════════════════
section('4  buildRollbackSuggestions');

test('4-01  DROP TABLE (in schema) → manual_review CREATE TABLE', () => {
  const r = Analyzer.buildRollbackSuggestions(parseSql('DROP TABLE users'), schema);
  assert.ok(r.length >= 1);
  assert.strictEqual(r[0].safetyLevel, 'manual_review');
  assert.ok(/CREATE TABLE/i.test(r[0].sql));
});

test('4-02  DROP TABLE (not in schema) → destructive no-snapshot', () => {
  const r = Analyzer.buildRollbackSuggestions(parseSql('DROP TABLE ghost_table'), schema);
  assert.ok(r.length >= 1);
  assert.strictEqual(r[0].safetyLevel, 'destructive');
});

test('4-03  ALTER DROP COLUMN (column in schema) → safe ADD COLUMN with correct type', () => {
  const r = Analyzer.buildRollbackSuggestions(parseSql('ALTER TABLE users DROP COLUMN phone'), schema);
  const rb = r.find(x => /ADD COLUMN phone/i.test(x.sql));
  assert.ok(rb, 'Expected ADD COLUMN phone rollback');
  assert.strictEqual(rb.safetyLevel, 'safe');
  assert.ok(/VARCHAR/i.test(rb.sql), 'Expected VARCHAR type from schema');
});

test('4-04  ALTER DROP COLUMN (col not in schema) → manual_review unknown type', () => {
  const r = Analyzer.buildRollbackSuggestions(parseSql('ALTER TABLE users DROP COLUMN nonexistent_col'), schema);
  const rb = r.find(x => /ADD COLUMN nonexistent_col/i.test(x.sql));
  assert.ok(rb, 'Expected ADD COLUMN rollback even for unknown col');
  assert.strictEqual(rb.safetyLevel, 'manual_review');
  assert.ok(/unknown/i.test(rb.sql));
});

test('4-05  ALTER ADD COLUMN → safe DROP COLUMN rollback', () => {
  const r = Analyzer.buildRollbackSuggestions(parseSql('ALTER TABLE users ADD COLUMN nickname VARCHAR(100)'), schema);
  const rb = r.find(x => /DROP COLUMN nickname/i.test(x.sql));
  assert.ok(rb, 'Expected DROP COLUMN nickname rollback');
  assert.strictEqual(rb.safetyLevel, 'safe');
});

test('4-06  ALTER RENAME COLUMN → reverse rename rollback', () => {
  const r = Analyzer.buildRollbackSuggestions(parseSql('ALTER TABLE users RENAME COLUMN phone TO mobile'), schema);
  const rb = r.find(x => /RENAME COLUMN mobile TO phone/i.test(x.sql));
  assert.ok(rb, `Expected reverse rename. Got: ${r.map(x => x.sql).join(' | ')}`);
  assert.strictEqual(rb.safetyLevel, 'safe');
});

test('4-07  RENAME TABLE → reverse rename rollback', () => {
  const r = Analyzer.buildRollbackSuggestions(parseSql('RENAME TABLE users TO customers'), schema);
  const rb = r.find(x => /RENAME TABLE customers TO users/i.test(x.sql));
  assert.ok(rb, 'Expected reverse table rename');
  assert.strictEqual(rb.safetyLevel, 'safe');
});

test('4-08  CREATE INDEX → DROP INDEX rollback', () => {
  const r = Analyzer.buildRollbackSuggestions(parseSql('CREATE INDEX idx_email ON users(email)'), schema);
  const rb = r.find(x => /DROP INDEX idx_email/i.test(x.sql));
  assert.ok(rb, 'Expected DROP INDEX rollback');
  assert.strictEqual(rb.safetyLevel, 'safe');
});

test('4-09  CREATE UNIQUE INDEX → DROP INDEX rollback', () => {
  const r = Analyzer.buildRollbackSuggestions(parseSql('CREATE UNIQUE INDEX idx_u_email ON users(email)'), schema);
  const rb = r.find(x => /DROP INDEX idx_u_email/i.test(x.sql));
  assert.ok(rb, 'Expected DROP INDEX rollback for UNIQUE index');
  assert.strictEqual(rb.safetyLevel, 'safe');
});

test('4-10  DELETE → destructive rollback', () => {
  const r = Analyzer.buildRollbackSuggestions(parseSql("DELETE FROM orders WHERE status='old'"), schema);
  assert.ok(r.some(x => x.safetyLevel === 'destructive'));
});

test('4-11  TRUNCATE → destructive rollback', () => {
  const r = Analyzer.buildRollbackSuggestions(parseSql('TRUNCATE TABLE logs'), schema);
  assert.ok(r.some(x => x.safetyLevel === 'destructive'));
});

test('4-12  SELECT → empty rollbacks', () => {
  assert.strictEqual(Analyzer.buildRollbackSuggestions(parseSql('SELECT * FROM users'), schema).length, 0);
});

test('4-13  DROP TABLE CREATE output contains correct column defs', () => {
  const r = Analyzer.buildRollbackSuggestions(parseSql('DROP TABLE orders'), schema);
  const sql = r[0].sql;
  assert.ok(/user_id/.test(sql),  'Should include user_id column');
  assert.ok(/total/.test(sql),    'Should include total column');
  assert.ok(/NOT NULL/.test(sql), 'Non-nullable columns have NOT NULL');
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — deriveModelName
// ═════════════════════════════════════════════════════════════════════════════
section('5  deriveModelName');

test('5-01  users → User',            () => assert.strictEqual(Analyzer.deriveModelName('users'),       'User'));
test('5-02  orders → Order',          () => assert.strictEqual(Analyzer.deriveModelName('orders'),      'Order'));
test('5-03  categories → Category',   () => assert.strictEqual(Analyzer.deriveModelName('categories'),  'Category'));
test('5-04  order_items → OrderItem', () => assert.strictEqual(Analyzer.deriveModelName('order_items'), 'OrderItem'));
test('5-05  statuses → Status',       () => assert.strictEqual(Analyzer.deriveModelName('statuses'),    'Status'));
test('5-06  class → Class (no strip)',() => assert.strictEqual(Analyzer.deriveModelName('class'),       'Class'));
test('5-07  staff (ends ss) → Staff', () => assert.strictEqual(Analyzer.deriveModelName('staff'),       'Staff'));

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — classifyDepSeverity
// ═════════════════════════════════════════════════════════════════════════════
section('6  classifyDepSeverity');

test('6-01  "delete" → critical',  () => assert.strictEqual(Analyzer.classifyDepSeverity('await repo.delete(id)'),           'critical'));
test('6-02  "drop" → critical',    () => assert.strictEqual(Analyzer.classifyDepSeverity('dropTable("users")'),              'critical'));
test('6-03  "truncate" → critical',() => assert.strictEqual(Analyzer.classifyDepSeverity('truncate(tableName)'),             'critical'));
test('6-04  "remove" → critical',  () => assert.strictEqual(Analyzer.classifyDepSeverity('await userRepo.remove(user)'),     'critical'));
test('6-05  "update" → high',      () => assert.strictEqual(Analyzer.classifyDepSeverity('db.update("users", data)'),        'high'));
test('6-06  "insert" → high',      () => assert.strictEqual(Analyzer.classifyDepSeverity('await insert(user)'),              'high'));
test('6-07  "select" → medium',    () => assert.strictEqual(Analyzer.classifyDepSeverity('const r = db.select(users)'),      'medium'));
test('6-08  "findOne" → medium',   () => assert.strictEqual(Analyzer.classifyDepSeverity('User.findOne({id})'),              'medium'));
test('6-09  plain text → low',     () => assert.strictEqual(Analyzer.classifyDepSeverity('const tableName = "users"'),       'low'));
test('6-10  empty string → low',   () => assert.strictEqual(Analyzer.classifyDepSeverity(''),                                'low'));

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — getTableSizeFactor
// ═════════════════════════════════════════════════════════════════════════════
section('7  getTableSizeFactor');

test('7-01  >1M rows → 1.5',      () => assert.strictEqual(Analyzer.getTableSizeFactor(['huge'],          schema), 1.5));
test('7-02  >100k rows → 1.25',   () => assert.strictEqual(Analyzer.getTableSizeFactor(['big'],           schema), 1.25));
test('7-03  >10k rows → 1.1',     () => assert.strictEqual(Analyzer.getTableSizeFactor(['mid'],           schema), 1.1));
test('7-04  <10k rows → 1.0',     () => assert.strictEqual(Analyzer.getTableSizeFactor(['tiny'],          schema), 1.0));
test('7-05  unknown table → 1.0', () => assert.strictEqual(Analyzer.getTableSizeFactor(['ghost'],         schema), 1.0));
test('7-06  empty array → 1.0',   () => assert.strictEqual(Analyzer.getTableSizeFactor([],               schema), 1.0));
test('7-07  max of multiple tables chosen', () => {
  assert.strictEqual(Analyzer.getTableSizeFactor(['tiny', 'huge'], schema), 1.5);
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — scoreToLevel
// ═════════════════════════════════════════════════════════════════════════════
section('8  scoreToLevel');

test('8-01  10 → critical', () => assert.strictEqual(Analyzer.scoreToLevel(10), 'critical'));
test('8-02   8 → critical', () => assert.strictEqual(Analyzer.scoreToLevel(8),  'critical'));
test('8-03   7 → high',     () => assert.strictEqual(Analyzer.scoreToLevel(7),  'high'));
test('8-04   6 → high',     () => assert.strictEqual(Analyzer.scoreToLevel(6),  'high'));
test('8-05   5 → medium',   () => assert.strictEqual(Analyzer.scoreToLevel(5),  'medium'));
test('8-06   4 → medium',   () => assert.strictEqual(Analyzer.scoreToLevel(4),  'medium'));
test('8-07   3 → low',      () => assert.strictEqual(Analyzer.scoreToLevel(3),  'low'));
test('8-08   1 → low',      () => assert.strictEqual(Analyzer.scoreToLevel(1),  'low'));

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — calculateRiskScore
// ═════════════════════════════════════════════════════════════════════════════
section('9  calculateRiskScore');

test('9-01  All empty → minimum score 1', () => {
  const s = Analyzer.calculateRiskScore(emptySchemaImpact, [], [], [], [], schema);
  assert.strictEqual(s, 1);
});

test('9-02  2 breaking changes → score >= 4', () => {
  const si = { breakingChanges: ['a','b'], nonBreakingChanges: [], cascadeEffects: [] };
  const s = Analyzer.calculateRiskScore(si, [], [], [], ['tiny'], schema);
  assert.ok(s >= 4, `Expected >=4 got ${s}`);
});

test('9-03  Breaking changes capped at 4 (3 == 2 breaking changes score)', () => {
  const si2 = { breakingChanges: ['a','b'],     nonBreakingChanges: [], cascadeEffects: [] };
  const si3 = { breakingChanges: ['a','b','c'], nonBreakingChanges: [], cascadeEffects: [] };
  const s2 = Analyzer.calculateRiskScore(si2, [], [], [], [], schema);
  const s3 = Analyzer.calculateRiskScore(si3, [], [], [], [], schema);
  assert.strictEqual(s2, s3, 'Score should cap at 4 for schema breaking changes');
});

test('9-04  2 critical data risks → contributes 2 pts', () => {
  const data = [{ severity:'critical' }, { severity:'critical' }, { severity:'critical' }];
  const s = Analyzer.calculateRiskScore(emptySchemaImpact, [], data, [], ['tiny'], schema);
  assert.ok(s >= 2);
});

test('9-05  Large table (orders, >1M rows) applies 1.5x multiplier vs tiny', () => {
  const si = { breakingChanges: ['a'], nonBreakingChanges: [], cascadeEffects: [] };
  const sSmall = Analyzer.calculateRiskScore(si, [], [], [], ['tiny'],   schema);
  const sHuge  = Analyzer.calculateRiskScore(si, [], [], [], ['orders'], schema);
  assert.ok(sHuge >= sSmall, `Large table should amplify: tiny=${sSmall} orders=${sHuge}`);
});

test('9-06  Score never exceeds 10', () => {
  const si   = { breakingChanges: ['a','b','c'], nonBreakingChanges: [], cascadeEffects: ['x','x','x'] };
  const data = Array(5).fill({ severity:'critical' });
  const deps = Array(10).fill({ severity:'critical', filePath:'x', tableName:'t', usage:'u' });
  const docs = Array(10).fill({ filePath:'README.md', issue:'i', suggestion:'s' });
  const s = Analyzer.calculateRiskScore(si, deps, data, docs, ['huge'], schema);
  assert.ok(s <= 10, `Score ${s} exceeds maximum of 10`);
});

test('9-07  Score never below 1', () => {
  const s = Analyzer.calculateRiskScore(emptySchemaImpact, [], [], [], ['tiny'], schema);
  assert.ok(s >= 1);
});

test('9-08  Docs drift capped at 1 pt (4 vs 8 docs same score)', () => {
  const docs4 = Array(4).fill({ filePath:'README.md', issue:'i', suggestion:'s' });
  const docs8 = Array(8).fill({ filePath:'README.md', issue:'i', suggestion:'s' });
  const s4 = Analyzer.calculateRiskScore(emptySchemaImpact, [], [], docs4, [], schema);
  const s8 = Analyzer.calculateRiskScore(emptySchemaImpact, [], [], docs8, [], schema);
  assert.strictEqual(s4, s8, 'Docs drift contribution capped at 1 pt');
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — buildSuggestions
// ═════════════════════════════════════════════════════════════════════════════
section('10  buildSuggestions');

test('10-01  NOT NULL breaking change → NULLABLE-first suggestion', () => {
  const si = { breakingChanges:['NOT NULL constraint without DEFAULT'], nonBreakingChanges:[], cascadeEffects:[] };
  assert.ok(Analyzer.buildSuggestions(si, [], [], 5).some(x => /NULLABLE/i.test(x)));
});

test('10-02  DROP breaking change → rename-first suggestion', () => {
  const si = { breakingChanges:['DROP COLUMN destroys data'], nonBreakingChanges:[], cascadeEffects:[] };
  // Suggestion is: "Consider renaming the column/table first..."
  assert.ok(Analyzer.buildSuggestions(si, [], [], 5).some(x => /renaming/i.test(x)));
});

test('10-03  DELETE without WHERE risk → WHERE clause suggestion', () => {
  const data = [{ description:'DELETE without WHERE clause', severity:'critical' }];
  assert.ok(Analyzer.buildSuggestions(emptySchemaImpact, [], data, 5).some(x => /WHERE/i.test(x)));
});

test('10-04  >5 app deps → update N files suggestion', () => {
  const deps = Array(6).fill({ filePath:'f', tableName:'t', usage:'u', severity:'low' });
  assert.ok(Analyzer.buildSuggestions(emptySchemaImpact, deps, [], 5).some(x => /6 affected files/i.test(x)));
});

test('10-05  Score >= 7 → DBA approval suggestion', () => {
  assert.ok(Analyzer.buildSuggestions(emptySchemaImpact, [], [], 8).some(x => /DBA/i.test(x)));
});

test('10-06  Score < 7, no hazards → empty suggestions', () => {
  assert.strictEqual(Analyzer.buildSuggestions(emptySchemaImpact, [], [], 3).length, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 11 — exportResult
// ═════════════════════════════════════════════════════════════════════════════
section('11  exportResult');

const mockResult = {
  sql: 'DROP TABLE users', riskScore: 9, riskLevel: 'critical',
  affectedTables: ['users'],
  schemaImpact: emptySchemaImpact,
  appDependencies: [], dataIntegrityRisks: [], documentationDrift: [],
  suggestions: [], rollbackSuggestions: [], generatedAt: Date.now(),
};

test('11-01  Creates file in target dir', () => {
  const tmpDir  = os.tmpdir();
  const fp      = Analyzer.exportResult(mockResult, tmpDir);
  assert.ok(fs.existsSync(fp), `File not created: ${fp}`);
  fs.unlinkSync(fp);
});

test('11-02  Exported file is valid JSON with correct values', () => {
  const tmpDir  = os.tmpdir();
  const fp      = Analyzer.exportResult(mockResult, tmpDir);
  const parsed  = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  assert.strictEqual(parsed.riskScore, 9);
  assert.strictEqual(parsed.affectedTables[0], 'users');
  fs.unlinkSync(fp);
});

test('11-03  Filename contains table name and .json extension', () => {
  const tmpDir   = os.tmpdir();
  const fp       = Analyzer.exportResult(mockResult, tmpDir);
  const basename = path.basename(fp);
  assert.ok(basename.startsWith('blast-radius-users-'), `Bad filename: ${basename}`);
  assert.ok(basename.endsWith('.json'));
  fs.unlinkSync(fp);
});

test('11-04  No affectedTables → filename uses "unknown"', () => {
  const tmpDir = os.tmpdir();
  const fp     = Analyzer.exportResult({ ...mockResult, affectedTables: [] }, tmpDir);
  assert.ok(path.basename(fp).includes('unknown'));
  fs.unlinkSync(fp);
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 12 — extractSqlFromString
// ═════════════════════════════════════════════════════════════════════════════
section('12  HoverProvider — extractSqlFromString');

test('12-01  Double-quoted SQL string extracted', () => {
  const m = HoverProvider.extractSqlFromString('const q = "SELECT * FROM users WHERE id=1"', 0);
  assert.ok(m && /SELECT/i.test(m.sql));
});

test('12-02  Single-quoted SQL string extracted', () => {
  const m = HoverProvider.extractSqlFromString("db.raw('DELETE FROM logs WHERE old=true')", 0);
  assert.ok(m && /DELETE/i.test(m.sql));
});

test('12-03  Backtick single-line SQL extracted', () => {
  const m = HoverProvider.extractSqlFromString('const q = `ALTER TABLE users DROP COLUMN phone`', 0);
  assert.ok(m && /ALTER/i.test(m.sql));
});

test('12-04  Multi-line template literal extracted', () => {
  // Build a string that contains an actual backtick, newlines, and SQL.
  // We use String.fromCharCode(96) for the backtick to avoid template literal conflicts.
  const bt = String.fromCharCode(96);
  const text = 'const q = ' + bt + '\n  SELECT *\n  FROM users\n  WHERE id = 1\n' + bt;
  const m = HoverProvider.extractSqlFromString(text, 0);
  assert.ok(m && /SELECT/i.test(m.sql), `Expected SQL match, got: ${JSON.stringify(m)}`);
});

test('12-05  Template literal with interpolation: replaced with ?', () => {
  const text = 'const q = `SELECT * FROM users WHERE id = ${userId}`';
  const m = HoverProvider.extractSqlFromString(text, 0);
  assert.ok(m, 'Expected a match');
  assert.ok(m.sql.includes('?'), 'Should replace interpolation with ?');
  assert.ok(!m.sql.includes('${'), 'Should not contain ${');
});

test('12-06  No SQL keyword → null', () => {
  assert.strictEqual(HoverProvider.extractSqlFromString('const name = "John Doe"', 0), null);
});

test('12-07  Empty string → null', () => {
  assert.strictEqual(HoverProvider.extractSqlFromString('', 0), null);
});

test('12-08  UPDATE in double quotes extracted', () => {
  const m = HoverProvider.extractSqlFromString('"UPDATE orders SET status=\'done\' WHERE id=1"', 0);
  assert.ok(m && /UPDATE/i.test(m.sql));
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 13 — extractStatementAt
// ═════════════════════════════════════════════════════════════════════════════
section('13  HoverProvider — extractStatementAt');

test('13-01  Single statement cursor in middle → full statement', () => {
  const sql = 'SELECT * FROM users WHERE id = 1';
  const m = HoverProvider.extractStatementAt(sql, 10);
  assert.ok(m && /SELECT/i.test(m.sql));
});

test('13-02  Two stmts — cursor at offset 12 → second stmt (DROP)', () => {
  const sql = 'SELECT 1; DROP TABLE users';
  const m = HoverProvider.extractStatementAt(sql, 12);
  assert.ok(m && /DROP/i.test(m.sql), `Got: ${m?.sql}`);
});

test('13-03  Cursor at offset 0 → first statement', () => {
  const sql = 'SELECT 1; SELECT 2';
  const m = HoverProvider.extractStatementAt(sql, 0);
  assert.ok(m && /SELECT 1/i.test(m.sql));
});

test('13-04  Only semicolons (empty stmt) → null', () => {
  assert.strictEqual(HoverProvider.extractStatementAt(';', 0), null);
});

test('13-05  No semicolons → returns whole trimmed text', () => {
  const sql = '  ALTER TABLE users DROP COLUMN phone  ';
  const m = HoverProvider.extractStatementAt(sql, 5);
  assert.ok(m && /ALTER/i.test(m.sql));
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 14 — riskEmoji
// ═════════════════════════════════════════════════════════════════════════════
section('14  riskEmoji');

test('14-01  low → 🟢',      () => assert.strictEqual(HoverProvider.riskEmoji('low'),      '🟢'));
test('14-02  medium → 🟡',   () => assert.strictEqual(HoverProvider.riskEmoji('medium'),   '🟡'));
test('14-03  high → 🟠',     () => assert.strictEqual(HoverProvider.riskEmoji('high'),     '🟠'));
test('14-04  critical → 🔴', () => assert.strictEqual(HoverProvider.riskEmoji('critical'), '🔴'));

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 15 — buildHoverText
// ═════════════════════════════════════════════════════════════════════════════
section('15  HoverProvider — buildHoverText');

const critResult = {
  sql: 'ALTER TABLE users DROP COLUMN phone',
  riskScore: 8, riskLevel: 'critical', affectedTables: ['users'],
  schemaImpact: { breakingChanges: ['DROP COLUMN destroys data'], nonBreakingChanges: [], cascadeEffects: ['users.role_id → roles.id'] },
  appDependencies: [], dataIntegrityRisks: [{ description: 'DROP COLUMN irreversible', severity: 'high' }],
  documentationDrift: [],
  suggestions: ['Rename first'],
  rollbackSuggestions: [{ description: 'Re-add phone', sql: 'ALTER TABLE users ADD COLUMN phone VARCHAR;', safetyLevel: 'safe' }],
  generatedAt: Date.now(),
};

const lowResult = {
  sql: 'SELECT * FROM users', riskScore: 1, riskLevel: 'low', affectedTables: ['users'],
  schemaImpact: { breakingChanges: [], nonBreakingChanges: [], cascadeEffects: [] },
  appDependencies: [], dataIntegrityRisks: [], documentationDrift: [],
  suggestions: [], rollbackSuggestions: [], generatedAt: Date.now(),
};

test('15-01  Contains risk score "8/10"', () => {
  assert.ok(HoverProvider.buildHoverText(critResult).includes('8/10'));
});

test('15-02  Contains risk level "CRITICAL"', () => {
  assert.ok(HoverProvider.buildHoverText(critResult).includes('CRITICAL'));
});

test('15-03  Contains affected table name', () => {
  assert.ok(HoverProvider.buildHoverText(critResult).includes('users'));
});

test('15-04  Breaking Changes section rendered when present', () => {
  assert.ok(HoverProvider.buildHoverText(critResult).includes('Breaking Changes'));
});

test('15-05  Data Risks section rendered when present', () => {
  assert.ok(HoverProvider.buildHoverText(critResult).includes('DROP COLUMN irreversible'));
});

test('15-06  Cascade Effects section rendered when present', () => {
  assert.ok(HoverProvider.buildHoverText(critResult).includes('Cascade Effects'));
});

test('15-07  Suggestions section rendered when present', () => {
  assert.ok(HoverProvider.buildHoverText(critResult).includes('Rename first'));
});

test('15-08  Rollback section rendered when present', () => {
  assert.ok(HoverProvider.buildHoverText(critResult).includes('Rollback'));
});

test('15-09  Safe rollback shows check-mark icon', () => {
  assert.ok(HoverProvider.buildHoverText(critResult).includes('✅'));
});

test('15-10  Low-risk result: no Breaking Changes section', () => {
  assert.ok(!HoverProvider.buildHoverText(lowResult).includes('Breaking Changes'));
});

test('15-11  Low-risk result: no Rollback section', () => {
  assert.ok(!HoverProvider.buildHoverText(lowResult).includes('Rollback'));
});

test('15-12  "Open Full Analysis" link present in all hovers', () => {
  assert.ok(HoverProvider.buildHoverText(critResult).includes('dbscope.analyzeBlastRadius'));
});

test('15-13  Rollback SQL truncated to 80 chars in hover text', () => {
  const longSql = 'A'.repeat(200);
  const result = { ...lowResult, rollbackSuggestions: [{ description:'x', sql: longSql, safetyLevel:'safe' }] };
  const text = HoverProvider.buildHoverText(result);
  assert.ok(!text.includes('A'.repeat(81)), 'SQL should be truncated to 80 chars');
});

test('15-14  manual_review rollback shows warning icon', () => {
  const result = { ...lowResult, rollbackSuggestions: [{ description:'x', sql:'DO SOMETHING;', safetyLevel:'manual_review' }] };
  assert.ok(HoverProvider.buildHoverText(result).includes('⚠'));
});

test('15-15  destructive rollback shows red icon', () => {
  const result = { ...lowResult, rollbackSuggestions: [{ description:'x', sql:'-- backup first', safetyLevel:'destructive' }] };
  assert.ok(HoverProvider.buildHoverText(result).includes('🔴'));
});

// ═════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n' + '═'.repeat(64));
console.log(`  Total:   ${passed + failed}`);
console.log(`  Passed:  ${passed} ✅`);
console.log(`  Failed:  ${failed} ❌`);
if (failures.length > 0) {
  console.log('\n  Failed tests:');
  failures.forEach(f => console.log(`    • ${f}`));
}
console.log('═'.repeat(64) + '\n');
process.exit(failed > 0 ? 1 : 0);
