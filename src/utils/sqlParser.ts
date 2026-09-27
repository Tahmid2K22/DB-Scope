// src/utils/sqlParser.ts — SQL parsing utilities
// parseSqlAI uses IBM watsonx.ai Granite to understand ANY SQL dialect.
// parseSql (regex fallback) is kept as the offline/error fallback.

export type SqlOperation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALTER' | 'DROP' | 'CREATE' | 'TRUNCATE' | 'UNKNOWN';

export interface ParsedSql {
  operation: SqlOperation;
  tables: string[];
  columns: string[];
  isDestructive: boolean;
  rawSql: string;
}

const TABLE_PATTERNS: Record<string, RegExp[]> = {
  FROM: [/\bFROM\s+([`"]?[\w.]+[`"]?)/gi],
  JOIN: [/\bJOIN\s+([`"]?[\w.]+[`"]?)/gi],
  INTO: [/\bINTO\s+([`"]?[\w.]+[`"]?)/gi],
  UPDATE: [/\bUPDATE\s+([`"]?[\w.]+[`"]?)/gi],
  TABLE: [/\bTABLE\s+(?:IF\s+EXISTS\s+)?([`"]?[\w.]+[`"]?)/gi],
};

const DESTRUCTIVE_OPS: SqlOperation[] = ['DELETE', 'DROP', 'TRUNCATE', 'ALTER'];

/**
 * AI-powered SQL parser — uses Granite to handle CTEs, MERGE, stored procedures,
 * and any dialect. Falls back to the regex parser if the AI call fails.
 */
export async function parseSqlAI(sql: string, watsonxClient?: { ask(s: string, u: string, t?: number): Promise<string> }): Promise<ParsedSql> {
  if (!watsonxClient) {
    return parseSql(sql);
  }
  try {
    const system = `You are a SQL parser.
Extract the primary SQL operation and all referenced table names from the given SQL statement.
Handle CTEs, subqueries, MERGE statements, and any SQL dialect correctly.
Return ONLY valid JSON with no extra text:
{ "operation": "DELETE", "tables": ["orders","users"], "columns": [], "isDestructive": true }
Valid operations: SELECT INSERT UPDATE DELETE ALTER DROP CREATE TRUNCATE UNKNOWN
isDestructive is true for DELETE, DROP, TRUNCATE, ALTER.`;

    const user = `SQL:\n${sql}`;
    const raw  = await watsonxClient.ask(system, user, 256);

    // Extract JSON from the response (Granite may wrap it in markdown fences)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { throw new Error('No JSON in response'); }
    const parsed = JSON.parse(jsonMatch[0]) as {
      operation: SqlOperation;
      tables: string[];
      columns: string[];
      isDestructive: boolean;
    };

    return {
      operation:     parsed.operation     ?? 'UNKNOWN',
      tables:        [...new Set(parsed.tables   ?? [])],
      columns:       [...new Set(parsed.columns  ?? [])],
      isDestructive: parsed.isDestructive ?? false,
      rawSql:        sql,
    };
  } catch {
    // AI unavailable or parse error — fall back to regex parser silently
    return parseSql(sql);
  }
}

export function parseSql(sql: string): ParsedSql {
  const normalized = sql.trim().replace(/\s+/g, ' ');
  const operation = detectOperation(normalized);
  const tables = extractTables(normalized);
  const columns = extractColumns(normalized);

  return {
    operation,
    tables: [...new Set(tables)],
    columns: [...new Set(columns)],
    isDestructive: DESTRUCTIVE_OPS.includes(operation),
    rawSql: sql,
  };
}

function detectOperation(sql: string): SqlOperation {
  const first = sql.split(/\s+/)[0].toUpperCase();
  const ops: SqlOperation[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP', 'CREATE', 'TRUNCATE'];
  return ops.find(op => op === first) ?? 'UNKNOWN';
}

function extractTables(sql: string): string[] {
  const tables: string[] = [];
  for (const patterns of Object.values(TABLE_PATTERNS)) {
    for (const pattern of patterns) {
      // Always create a fresh RegExp so lastIndex starts at 0 for every call
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(sql)) !== null) {
        const table = match[1].replace(/[`"]/g, '');
        // Skip dotted names (schema.table) — keep only the table part
        const tableName = table.includes('.') ? table.split('.').pop()! : table;
        if (!SQL_KEYWORDS.has(tableName.toUpperCase())) {
          tables.push(tableName);
        }
      }
    }
  }
  return tables;
}

function extractColumns(sql: string): string[] {
  // Extract column names from ALTER TABLE ... ADD/DROP/MODIFY COLUMN ...
  const colPattern = /\b(?:ADD|DROP|MODIFY)\s+(?:COLUMN\s+)?([`"]?[\w]+[`"]?)/gi;
  const columns: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = colPattern.exec(sql)) !== null) {
    columns.push(match[1].replace(/[`"]/g, ''));
  }
  return columns;
}

// Common SQL keywords to exclude from table name extraction
const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL',
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'ON',
  'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'ALL',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'TRUNCATE',
  'CREATE', 'ALTER', 'DROP', 'TABLE', 'INDEX', 'VIEW', 'DATABASE',
  'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'CONSTRAINT', 'UNIQUE',
  'DEFAULT', 'NOT', 'NULL', 'AUTO_INCREMENT', 'SERIAL', 'CASCADE',
]);
