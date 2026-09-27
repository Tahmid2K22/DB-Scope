// src/diagnostics/schemaDiagnostics.ts
// Member 2 — Schema-Aware SQL Diagnostic Rule Engine
// Pure (vscode-free) module. Consumes a DatabaseSchema and a tokenized SqlStatement
// to produce SqlDiagnostic entries for schema violations.

import { DatabaseSchema, SqlDiagnostic } from '../core/types';
import {
  SqlStatement,
  extractTablesFromStatement,
  extractWhereColumns,
  extractSelectColumns,
  extractSetColumns,
  extractInsertColumns,
  extractFirstKeyword,
  extractCteNames,
  hasClause,
} from './sqlTokenizer';

// ─────────────────────────────────────────────────────────────────────────────
// Rule codes
// ─────────────────────────────────────────────────────────────────────────────

export const RULE_CODES = {
  SCHEMA_001: 'DBS-SCHEMA-001', // Non-existent table
  SCHEMA_002: 'DBS-SCHEMA-002', // Non-existent column
  SCHEMA_003: 'DBS-SCHEMA-003', // DROP COLUMN referenced by FK
  SCHEMA_004: 'DBS-SCHEMA-004', // Duplicate column on ADD COLUMN
  SCHEMA_005: 'DBS-SCHEMA-005', // NOT NULL column without DEFAULT on table with rows
};

// ─────────────────────────────────────────────────────────────────────────────
// runSchemaRules — entry point called per statement
// ─────────────────────────────────────────────────────────────────────────────

export function runSchemaRules(
  stmt: SqlStatement,
  schema: DatabaseSchema | null
): SqlDiagnostic[] {
  if (!schema) { return []; }
  const diagnostics: SqlDiagnostic[] = [];

  const keyword = extractFirstKeyword(stmt.clauseMask);
  const cteNames = extractCteNames(stmt.parseMask);

  // Rule DBS-SCHEMA-001: Non-existent table
  checkNonExistentTable(stmt, schema, cteNames, keyword, diagnostics);

  // Rule DBS-SCHEMA-002: Non-existent column
  checkNonExistentColumn(stmt, schema, cteNames, keyword, diagnostics);

  // Rule DBS-SCHEMA-003: DROP COLUMN referenced by FK
  if (keyword === 'ALTER') {
    checkDropColumnFkDependency(stmt, schema, diagnostics);
  }

  // Rule DBS-SCHEMA-004: Duplicate column on ADD COLUMN
  if (keyword === 'ALTER') {
    checkDuplicateColumn(stmt, schema, diagnostics);
  }

  // Rule DBS-SCHEMA-005: NOT NULL without DEFAULT on existing table
  if (keyword === 'ALTER') {
    checkNotNullWithoutDefault(stmt, schema, diagnostics);
  }

  return diagnostics;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: case-insensitive table lookup
// ─────────────────────────────────────────────────────────────────────────────

function lookupTable(schema: DatabaseSchema, name: string): string | null {
  if (schema.tables[name]) { return name; }
  // Case-insensitive fallback
  const lower = name.toLowerCase();
  const found = Object.keys(schema.tables).find(k => k.toLowerCase() === lower);
  return found ?? null;
}

function lookupColumn(schema: DatabaseSchema, tableName: string, colName: string): boolean {
  const resolvedTable = lookupTable(schema, tableName);
  if (!resolvedTable) { return false; }
  const table = schema.tables[resolvedTable];
  if (table.columns[colName]) { return true; }
  const lower = colName.toLowerCase();
  return Object.keys(table.columns).some(k => k.toLowerCase() === lower);
}

// ─────────────────────────────────────────────────────────────────────────────
// DBS-SCHEMA-001: Non-existent table
// ─────────────────────────────────────────────────────────────────────────────

// Keywords indicating DROP IF EXISTS (suppress false positives)
const RE_DROP_IF_EXISTS_TABLE = /\bDROP\s+(?:TEMPORARY\s+)?TABLE\s+IF\s+EXISTS\b/i;
const RE_CREATE_OR_REPLACE = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|INDEX)\b/i;

function checkNonExistentTable(
  stmt: SqlStatement,
  schema: DatabaseSchema,
  cteNames: Set<string>,
  keyword: string,
  out: SqlDiagnostic[]
): void {
  // Skip CREATE (it creates tables), CREATE OR REPLACE, DROP IF EXISTS
  if (RE_CREATE_OR_REPLACE.test(stmt.clauseMask)) { return; }
  if (RE_DROP_IF_EXISTS_TABLE.test(stmt.clauseMask)) { return; }
  // Skip pure DDL without schema checks (CREATE, DROP alone checked below)
  if (['CREATE', 'COMMENT'].includes(keyword)) { return; }

  const tables = extractTablesFromStatement(stmt.parseMask);
  for (const tName of tables) {
    if (cteNames.has(tName)) { continue; } // CTE alias — skip
    if (SQL_KEYWORDS_SKIP.has(tName)) { continue; } // e.g. 'dual', keywords
    if (!lookupTable(schema, tName)) {
      // Find offset in original sql
      const idx = findIdentifierOffset(stmt.sql, tName, stmt.startOffset);
      out.push({
        message: `Table "${tName}" does not exist in the current schema.`,
        severity: 'error',
        startOffset: idx ?? stmt.startOffset,
        endOffset: (idx ?? stmt.startOffset) + tName.length,
        suggestion: 'Check for typos or run "Fetch Database Context" to refresh the schema.',
        code: RULE_CODES.SCHEMA_001,
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DBS-SCHEMA-002: Non-existent column
// ─────────────────────────────────────────────────────────────────────────────

function checkNonExistentColumn(
  stmt: SqlStatement,
  schema: DatabaseSchema,
  cteNames: Set<string>,
  keyword: string,
  out: SqlDiagnostic[]
): void {
  if (!['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(keyword)) { return; }

  const tables = extractTablesFromStatement(stmt.parseMask)
    .filter(t => !cteNames.has(t) && lookupTable(schema, t) !== null);

  if (tables.length === 0) { return; } // Can't validate without a known table

  const primaryTable = tables[0];
  let colsToCheck: string[] = [];

  if (keyword === 'SELECT') {
    const selectCols = extractSelectColumns(stmt.parseMask);
    if (selectCols.includes('*')) { return; } // SELECT * — no column check
    colsToCheck = selectCols;
  } else if (keyword === 'UPDATE') {
    colsToCheck = [...extractSetColumns(stmt.parseMask), ...extractWhereColumns(stmt.parseMask)];
  } else if (keyword === 'DELETE') {
    colsToCheck = extractWhereColumns(stmt.parseMask);
  } else if (keyword === 'INSERT') {
    colsToCheck = extractInsertColumns(stmt.parseMask);
  }

  for (const col of colsToCheck) {
    if (SQL_KEYWORDS_SKIP.has(col)) { continue; }
    if (!lookupColumn(schema, primaryTable, col)) {
      const idx = findIdentifierOffset(stmt.sql, col, stmt.startOffset);
      out.push({
        message: `Column "${col}" does not exist in table "${primaryTable}".`,
        severity: 'error',
        startOffset: idx ?? stmt.startOffset,
        endOffset: (idx ?? stmt.startOffset) + col.length,
        suggestion: `Check the column name or refresh schema context.`,
        code: RULE_CODES.SCHEMA_002,
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DBS-SCHEMA-003: DROP COLUMN referenced by FK in another table
// ─────────────────────────────────────────────────────────────────────────────

function checkDropColumnFkDependency(
  stmt: SqlStatement,
  schema: DatabaseSchema,
  out: SqlDiagnostic[]
): void {
  // Match: ALTER TABLE t DROP [COLUMN] colName
  const m = /\bALTER\s+TABLE\s+([`"]?[\w.]+[`"]?)\s+DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?([`"]?[\w]+[`"]?)/i.exec(stmt.parseMask);
  if (!m) { return; }

  const targetTable = m[1].replace(/[`"[\]]/g, '').split('.').pop()?.toLowerCase() ?? '';
  const droppedCol = m[2].replace(/[`"[\]]/g, '').toLowerCase();

  const dependents: string[] = [];
  for (const [tName, tDef] of Object.entries(schema.tables)) {
    for (const [cName, col] of Object.entries(tDef.columns)) {
      if (col.referencesTable?.toLowerCase() === targetTable &&
          col.referencesColumn?.toLowerCase() === droppedCol) {
        dependents.push(`${tName}.${cName}`);
      }
    }
  }

  if (dependents.length > 0) {
    out.push({
      message: `Column "${targetTable}.${droppedCol}" is referenced by ${dependents.length} foreign key(s): ${dependents.join(', ')}. Dropping it will break referential integrity.`,
      severity: 'error',
      startOffset: stmt.startOffset,
      endOffset: stmt.endOffset,
      suggestion: 'Drop the foreign key constraints first, then drop the column.',
      code: RULE_CODES.SCHEMA_003,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DBS-SCHEMA-004: Duplicate column on ADD COLUMN
// ─────────────────────────────────────────────────────────────────────────────

function checkDuplicateColumn(
  stmt: SqlStatement,
  schema: DatabaseSchema,
  out: SqlDiagnostic[]
): void {
  // Only fires for ADD COLUMN (not ADD COLUMN IF NOT EXISTS)
  if (!/\bADD\s+(?:COLUMN\s+)?(?!IF\s+NOT\s+EXISTS)/i.test(stmt.clauseMask)) { return; }
  if (/\bADD\s+(?:COLUMN\s+)?IF\s+NOT\s+EXISTS/i.test(stmt.clauseMask)) { return; }

  const tableM = /\bALTER\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([`"]?[\w.]+[`"]?)/i.exec(stmt.parseMask);
  if (!tableM) { return; }
  const targetTable = tableM[1].replace(/[`"[\]]/g, '').split('.').pop()?.toLowerCase() ?? '';
  const resolvedTable = lookupTable(schema, targetTable);
  if (!resolvedTable) { return; }

  const table = schema.tables[resolvedTable];
  // Extract new column name from ADD [COLUMN] name type
  const addM = /\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([`"]?[\w]+[`"]?)\s+\w/i.exec(stmt.parseMask);
  if (!addM) { return; }
  const newCol = addM[1].replace(/[`"[\]]/g, '').toLowerCase();

  if (lookupColumn(schema, resolvedTable, newCol)) {
    out.push({
      message: `Column "${newCol}" already exists in table "${targetTable}".`,
      severity: 'error',
      startOffset: stmt.startOffset,
      endOffset: stmt.endOffset,
      suggestion: 'Use ALTER COLUMN to modify the existing column, or choose a different name.',
      code: RULE_CODES.SCHEMA_004,
    });
  }
  void table; // suppress unused
}

// ─────────────────────────────────────────────────────────────────────────────
// DBS-SCHEMA-005: NOT NULL column without DEFAULT on table with rows
// ─────────────────────────────────────────────────────────────────────────────

function checkNotNullWithoutDefault(
  stmt: SqlStatement,
  schema: DatabaseSchema,
  out: SqlDiagnostic[]
): void {
  // ALTER TABLE t ADD [COLUMN] name type NOT NULL  (no DEFAULT anywhere)
  if (!/\bNOT\s+NULL\b/i.test(stmt.clauseMask)) { return; }
  if (/\bDEFAULT\b/i.test(stmt.clauseMask)) { return; } // has DEFAULT — ok
  if (!/\bADD\s+(?:COLUMN\s+)?/i.test(stmt.clauseMask)) { return; }

  const tableM = /\bALTER\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([`"]?[\w.]+[`"]?)/i.exec(stmt.parseMask);
  if (!tableM) { return; }
  const targetTable = tableM[1].replace(/[`"[\]]/g, '').split('.').pop()?.toLowerCase() ?? '';
  const resolvedTable = lookupTable(schema, targetTable);
  const rowCount = resolvedTable ? (schema.tables[resolvedTable]?.rowCount) : undefined;

  const severity: SqlDiagnostic['severity'] = rowCount === 0 ? 'info' : 'warning';
  out.push({
    message: `Adding NOT NULL column without DEFAULT to "${targetTable}"${rowCount !== undefined ? ` (${rowCount} rows)` : ''}. Existing rows will fail the constraint.`,
    severity,
    startOffset: stmt.startOffset,
    endOffset: stmt.endOffset,
    suggestion: 'Add DEFAULT value or make the column nullable first, then backfill.',
    code: RULE_CODES.SCHEMA_005,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: find offset of an identifier in the original SQL
// ─────────────────────────────────────────────────────────────────────────────

function findIdentifierOffset(sql: string, identifier: string, baseOffset: number): number | null {
  const re = new RegExp(`\\b${escapeRegex(identifier)}\\b`, 'i');
  const m = re.exec(sql);
  return m ? baseOffset + m.index : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Common tokens that should never be treated as table names
const SQL_KEYWORDS_SKIP = new Set([
  'dual', 'excluded', 'new', 'old', 'inserted', 'deleted',
  'select', 'from', 'where', 'join', 'left', 'right', 'inner', 'outer',
  'full', 'cross', 'on', 'using', 'union', 'all', 'with', 'as',
  'set', 'values', 'into', 'update', 'delete', 'insert',
  'create', 'alter', 'drop', 'table', 'index', 'view', 'database',
  'primary', 'key', 'foreign', 'references', 'constraint',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Legacy pattern rules (enhanced with code field, running on clauseMask)
// ─────────────────────────────────────────────────────────────────────────────

interface PatternRule {
  pattern: RegExp;
  message: string;
  severity: SqlDiagnostic['severity'];
  suggestion?: string;
  code: string;
  modal?: boolean;
}

export const PATTERN_RULES: PatternRule[] = [
  {
    pattern: /\bDROP\s+(?:TABLE|DATABASE)\b/i,
    message: 'Destructive operation: permanently removes data.',
    severity: 'error',
    suggestion: 'Consider a soft-delete approach first.',
    code: 'DBS-DESTRUCT-001',
    modal: true,
  },
  {
    pattern: /\bDROP\s+(?:COLUMN)\b/i,
    message: 'Dropping a column removes it and all its data permanently.',
    severity: 'error',
    suggestion: 'Rename the column first to soft-deprecate it.',
    code: 'DBS-DESTRUCT-001b',
    modal: false,
  },
  {
    pattern: /\bTRUNCATE\b/i,
    message: 'TRUNCATE removes ALL rows — this is irreversible without a backup.',
    severity: 'error',
    suggestion: 'Use DELETE with a WHERE clause if you only need to remove some rows.',
    code: 'DBS-DESTRUCT-002',
    modal: true,
  },
  {
    pattern: /\bDELETE\s+FROM\b/i,
    message: 'DELETE without WHERE will remove ALL rows in the table.',
    severity: 'error',
    suggestion: 'Add a WHERE clause to target specific rows.',
    code: 'DBS-DESTRUCT-003',
    modal: true,
    // WHERE-check done at runtime via hasWhereClause on clauseMask
  },
  {
    pattern: /\bUPDATE\s+\w[\w$]*\s+SET\b/i,
    message: 'UPDATE without WHERE will modify ALL rows in the table.',
    severity: 'error',
    suggestion: 'Add a WHERE clause to target specific rows.',
    code: 'DBS-DESTRUCT-004',
    modal: false,
  },
  {
    pattern: /\bALTER\s+TABLE\s+\w[\w$]*\s+ADD\s+(?:COLUMN\s+)?\w[\w$]*\s+\w[\w$]*(?:\([^)]*\))?\s+NOT\s+NULL(?!\s+DEFAULT)(?!\s+GENERATED)/i,
    message: 'NOT NULL column without DEFAULT will fail on tables with existing rows.',
    severity: 'warning',
    suggestion: 'Add a DEFAULT value or make the column NULLABLE first, then backfill.',
    code: 'DBS-SCHEMA-005',
  },
  {
    pattern: /\bDROP\s+INDEX\b/i,
    message: 'Dropping an index may slow down queries that rely on it.',
    severity: 'warning',
    suggestion: 'Check query performance before removing this index.',
    code: 'DBS-PERF-001',
  },
  {
    pattern: /\bSELECT\s+\*/i,
    message: 'SELECT * fetches all columns — can be slow and fragile.',
    severity: 'info',
    suggestion: 'Specify only the columns you need for better performance.',
    code: 'DBS-PERF-002',
  },
  {
    pattern: /\bALTER\s+TABLE\s+\w[\w$]*\s+RENAME\b/i,
    message: 'Renaming a table/column breaks all queries and ORM mappings referencing it.',
    severity: 'warning',
    suggestion: 'Add an alias or view layer before renaming.',
    code: 'DBS-BREAK-001',
  },
];

/**
 * Run the legacy pattern rules against a clauseMask string.
 * Returns diagnostics with offsets relative to baseOffset.
 */
export function runPatternRules(
  sql: string,
  clauseMask: string,
  baseOffset: number,
  _skipIfHasWhere = false
): SqlDiagnostic[] {
  const diagnostics: SqlDiagnostic[] = [];

  for (const rule of PATTERN_RULES) {
    // For DELETE/UPDATE rules, only fire if no WHERE clause
    if ((rule.code === 'DBS-DESTRUCT-003' || rule.code === 'DBS-DESTRUCT-004')) {
      if (!rule.pattern.test(clauseMask)) { continue; }
      if (hasClause(clauseMask, 'WHERE')) { continue; }
      if (hasClause(clauseMask, 'LIMIT')) { continue; } // LIMIT qualifies DELETE in MySQL
    } else {
      if (!rule.pattern.test(clauseMask)) { continue; }
    }

    // Find match in original sql for accurate offset
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      diagnostics.push({
        message: rule.message,
        severity: rule.severity,
        startOffset: baseOffset + m.index,
        endOffset: baseOffset + m.index + m[0].length,
        suggestion: rule.suggestion,
        code: rule.code,
      });
    }
  }

  return diagnostics;
}
