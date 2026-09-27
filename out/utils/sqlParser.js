"use strict";
// src/utils/sqlParser.ts — Lightweight SQL parsing utilities
// Extracts table references, operation type, and affected columns from raw SQL
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSql = parseSql;
const TABLE_PATTERNS = {
    FROM: [/\bFROM\s+([`"]?[\w.]+[`"]?)/gi],
    JOIN: [/\bJOIN\s+([`"]?[\w.]+[`"]?)/gi],
    INTO: [/\bINTO\s+([`"]?[\w.]+[`"]?)/gi],
    UPDATE: [/\bUPDATE\s+([`"]?[\w.]+[`"]?)/gi],
    TABLE: [/\bTABLE\s+(?:IF\s+EXISTS\s+)?([`"]?[\w.]+[`"]?)/gi],
};
const DESTRUCTIVE_OPS = ['DELETE', 'DROP', 'TRUNCATE', 'ALTER'];
function parseSql(sql) {
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
function detectOperation(sql) {
    const first = sql.split(/\s+/)[0].toUpperCase();
    const ops = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP', 'CREATE', 'TRUNCATE'];
    return ops.find(op => op === first) ?? 'UNKNOWN';
}
function extractTables(sql) {
    const tables = [];
    for (const patterns of Object.values(TABLE_PATTERNS)) {
        for (const pattern of patterns) {
            // Always create a fresh RegExp so lastIndex starts at 0 for every call
            const regex = new RegExp(pattern.source, pattern.flags);
            let match;
            while ((match = regex.exec(sql)) !== null) {
                const table = match[1].replace(/[`"]/g, '');
                // Skip dotted names (schema.table) — keep only the table part
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
    // Extract column names from ALTER TABLE ... ADD/DROP/MODIFY COLUMN ...
    const colPattern = /\b(?:ADD|DROP|MODIFY)\s+(?:COLUMN\s+)?([`"]?[\w]+[`"]?)/gi;
    const columns = [];
    let match;
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
//# sourceMappingURL=sqlParser.js.map