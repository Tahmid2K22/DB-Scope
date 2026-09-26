// src/mergeAnalyzer/mergeAnalyzer.ts
// Member 3 — Database Merge Conflict Analyzer
// Detects structural conflicts when merging two database schemas.
// Identifies type mismatches, name conflicts, nullable differences,
// and missing tables/columns. Suggests reconciliation SQL.

import * as vscode from 'vscode';
import {
  DatabaseSchema,
  MergeConflict,
  MergeAnalysisResult,
  TableDefinition,
  ColumnDefinition,
} from '../core/types';
import { SchemaStateMap } from '../core/schemaStateMap';
import { Logger } from '../utils/logger';

export class MergeAnalyzer {
  private readonly logger = Logger.getInstance();

  constructor(private readonly schemaState: SchemaStateMap) {}

  // ──────────────────────────────────────────────
  // Entry point: prompt user to select two schema files, then analyze
  // ──────────────────────────────────────────────

  async promptAndAnalyze(): Promise<MergeAnalysisResult | null> {
    const options: vscode.OpenDialogOptions = {
      canSelectMany: false,
      filters: { 'SQL or JSON Schema': ['sql', 'json'] },
      openLabel: 'Select Schema A',
    };

    const fileAUris = await vscode.window.showOpenDialog(options);
    if (!fileAUris || fileAUris.length === 0) { return null; }

    const fileBUris = await vscode.window.showOpenDialog({ ...options, openLabel: 'Select Schema B' });
    if (!fileBUris || fileBUris.length === 0) { return null; }

    const docA = await vscode.workspace.openTextDocument(fileAUris[0]);
    const docB = await vscode.workspace.openTextDocument(fileBUris[0]);

    const schemaA = this.parseSchemaFile(docA.getText(), 'Database_A');
    const schemaB = this.parseSchemaFile(docB.getText(), 'Database_B');

    return this.analyze(schemaA, schemaB);
  }

  /**
   * Core analysis: compare schemaA and schemaB and produce a MergeAnalysisResult.
   */
  analyze(schemaA: DatabaseSchema, schemaB: DatabaseSchema): MergeAnalysisResult {
    this.logger.info(`MergeAnalyzer: comparing ${Object.keys(schemaA.tables).length} vs ${Object.keys(schemaB.tables).length} tables`);

    const conflicts: MergeConflict[] = [];

    // 1. Tables in A missing from B
    for (const tableName of Object.keys(schemaA.tables)) {
      if (!schemaB.tables[tableName]) {
        conflicts.push({
          table: tableName,
          conflictType: 'missing_table',
          sourceA: `Table "${tableName}" exists in Database A`,
          sourceB: `Table "${tableName}" does NOT exist in Database B`,
          suggestion: `Add CREATE TABLE ${tableName} to Database B or merge its definition`,
          reconciliationSql: this.generateCreateTableSql(schemaA.tables[tableName]),
        });
      }
    }

    // 2. Tables in B missing from A
    for (const tableName of Object.keys(schemaB.tables)) {
      if (!schemaA.tables[tableName]) {
        conflicts.push({
          table: tableName,
          conflictType: 'missing_table',
          sourceA: `Table "${tableName}" does NOT exist in Database A`,
          sourceB: `Table "${tableName}" exists in Database B`,
          suggestion: `Add CREATE TABLE ${tableName} to Database A or merge its definition`,
          reconciliationSql: this.generateCreateTableSql(schemaB.tables[tableName]),
        });
      }
    }

    // 3. Compare columns in shared tables
    for (const tableName of Object.keys(schemaA.tables)) {
      if (!schemaB.tables[tableName]) { continue; }
      const tableConflicts = this.compareColumns(tableName, schemaA.tables[tableName], schemaB.tables[tableName]);
      conflicts.push(...tableConflicts);
    }

    // 4. Build reconciled schema and SQL
    const unifiedSchema = this.buildUnifiedSchema(schemaA, schemaB);
    const reconciledSql = this.generateReconciledSql(conflicts, unifiedSchema);

    this.logger.info(`MergeAnalyzer: found ${conflicts.length} conflict(s)`);

    return {
      schemaA,
      schemaB,
      conflicts,
      reconciledSql,
      unifiedSchema,
      mergedAt: Date.now(),
    };
  }

  // ──────────────────────────────────────────────
  // Column-level comparison
  // ──────────────────────────────────────────────

  private compareColumns(
    tableName: string,
    tableA: TableDefinition,
    tableB: TableDefinition
  ): MergeConflict[] {
    const conflicts: MergeConflict[] = [];

    // Columns in A not in B
    for (const colName of Object.keys(tableA.columns)) {
      if (!tableB.columns[colName]) {
        conflicts.push({
          table: tableName,
          column: colName,
          conflictType: 'missing_column',
          sourceA: `Column "${colName}" (${tableA.columns[colName].type}) exists in A`,
          sourceB: `Column "${colName}" does not exist in B`,
          suggestion: `ALTER TABLE ${tableName} ADD COLUMN ${colName} ${tableA.columns[colName].type}`,
          reconciliationSql: `ALTER TABLE ${tableName} ADD COLUMN ${colName} ${tableA.columns[colName].type};`,
        });
        continue;
      }

      const colA = tableA.columns[colName];
      const colB = tableB.columns[colName];

      // Type mismatch
      if (!this.typesCompatible(colA.type, colB.type)) {
        conflicts.push({
          table: tableName,
          column: colName,
          conflictType: 'type_mismatch',
          sourceA: `${tableName}.${colName} is ${colA.type} in A`,
          sourceB: `${tableName}.${colName} is ${colB.type} in B`,
          suggestion: this.suggestTypeResolution(colA.type, colB.type),
          reconciliationSql: this.generateTypeCastSql(tableName, colName, colA.type, colB.type),
        });
      }

      // Nullable difference
      if (colA.nullable !== colB.nullable) {
        const toNullable = colA.nullable ? 'A (nullable)' : 'B (nullable)';
        conflicts.push({
          table: tableName,
          column: colName,
          conflictType: 'nullable_difference',
          sourceA: `${tableName}.${colName} is ${colA.nullable ? 'NULLABLE' : 'NOT NULL'} in A`,
          sourceB: `${tableName}.${colName} is ${colB.nullable ? 'NULLABLE' : 'NOT NULL'} in B`,
          suggestion: `Use the more permissive definition (NULLABLE) to avoid data loss. Use ${toNullable}.`,
          reconciliationSql: `ALTER TABLE ${tableName} ALTER COLUMN ${colName} DROP NOT NULL;`,
        });
      }
    }

    // Columns in B not in A
    for (const colName of Object.keys(tableB.columns)) {
      if (!tableA.columns[colName]) {
        conflicts.push({
          table: tableName,
          column: colName,
          conflictType: 'missing_column',
          sourceA: `Column "${colName}" does not exist in A`,
          sourceB: `Column "${colName}" (${tableB.columns[colName].type}) exists in B`,
          suggestion: `ALTER TABLE ${tableName} ADD COLUMN ${colName} ${tableB.columns[colName].type}`,
          reconciliationSql: `ALTER TABLE ${tableName} ADD COLUMN ${colName} ${tableB.columns[colName].type};`,
        });
      }
    }

    return conflicts;
  }

  // ──────────────────────────────────────────────
  // Unified Schema Builder
  // ──────────────────────────────────────────────

  private buildUnifiedSchema(a: DatabaseSchema, b: DatabaseSchema): DatabaseSchema {
    const tables: Record<string, TableDefinition> = {};

    // Merge all tables from A
    for (const [name, table] of Object.entries(a.tables)) {
      tables[name] = { ...table, columns: { ...table.columns } };
    }

    // Merge tables from B — add missing columns/tables
    for (const [name, tableB] of Object.entries(b.tables)) {
      if (!tables[name]) {
        tables[name] = { ...tableB, columns: { ...tableB.columns } };
        continue;
      }
      // Merge columns: prefer NULLABLE (more permissive)
      for (const [colName, colB] of Object.entries(tableB.columns)) {
        if (!tables[name].columns[colName]) {
          tables[name].columns[colName] = colB;
        } else {
          const colA = tables[name].columns[colName];
          tables[name].columns[colName] = {
            ...colA,
            nullable: colA.nullable || colB.nullable, // prefer nullable
            type: this.preferredType(colA.type, colB.type),
          };
        }
      }
    }

    return {
      dbType: a.dbType,
      databaseName: `${a.databaseName}_merged_${b.databaseName}`,
      tables,
      extractedAt: Date.now(),
    };
  }

  // ──────────────────────────────────────────────
  // SQL Generators
  // ──────────────────────────────────────────────

  private generateCreateTableSql(table: TableDefinition): string {
    const cols = Object.values(table.columns)
      .map(c => {
        let def = `  ${c.name} ${c.type}`;
        if (!c.nullable) { def += ' NOT NULL'; }
        if (c.isPrimaryKey) { def += ' PRIMARY KEY'; }
        return def;
      })
      .join(',\n');
    return `CREATE TABLE IF NOT EXISTS ${table.name} (\n${cols}\n);`;
  }

  private generateTypeCastSql(table: string, column: string, typeA: string, typeB: string): string {
    const preferred = this.preferredType(typeA, typeB);
    return `-- WARNING: Type mismatch detected for ${table}.${column} (${typeA} vs ${typeB})\n` +
      `-- Preferred type: ${preferred}\n` +
      `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${preferred} USING ${column}::${preferred};`;
  }

  private generateReconciledSql(conflicts: MergeConflict[], unified: DatabaseSchema): string {
    const lines: string[] = [
      '-- ============================================================',
      '-- DB-Scope: Reconciliation SQL (Auto-generated)',
      `-- Generated at: ${new Date().toISOString()}`,
      '-- Review carefully before executing against production!',
      '-- ============================================================',
      '',
    ];

    for (const conflict of conflicts) {
      lines.push(`-- Conflict: [${conflict.conflictType.toUpperCase()}] ${conflict.table}${conflict.column ? '.' + conflict.column : ''}`);
      lines.push(`-- ${conflict.suggestion}`);
      lines.push(conflict.reconciliationSql);
      lines.push('');
    }

    return lines.join('\n');
  }

  // ──────────────────────────────────────────────
  // Type helpers
  // ──────────────────────────────────────────────

  private typesCompatible(a: string, b: string): boolean {
    const normalize = (t: string) => t.toLowerCase().replace(/\([^)]+\)/, '').trim();
    const na = normalize(a);
    const nb = normalize(b);
    if (na === nb) { return true; }
    // Compatible groups
    const intGroup = ['int', 'integer', 'bigint', 'smallint', 'tinyint', 'serial', 'bigserial'];
    const floatGroup = ['float', 'double', 'real', 'decimal', 'numeric'];
    const strGroup = ['varchar', 'text', 'char', 'nvarchar', 'nchar', 'character varying'];
    const groups = [intGroup, floatGroup, strGroup];
    return groups.some(g => g.includes(na) && g.includes(nb));
  }

  private preferredType(a: string, b: string): string {
    // Prefer the more general/larger type
    const order = ['bigint', 'integer', 'smallint', 'text', 'varchar', 'char', 'double', 'float', 'decimal'];
    const na = a.toLowerCase().replace(/\([^)]+\)/, '').trim();
    const nb = b.toLowerCase().replace(/\([^)]+\)/, '').trim();
    const ia = order.indexOf(na);
    const ib = order.indexOf(nb);
    if (ia === -1) { return a; }
    if (ib === -1) { return b; }
    return ia <= ib ? a : b; // lower index = more general
  }

  private suggestTypeResolution(a: string, b: string): string {
    const preferred = this.preferredType(a, b);
    return `Use "${preferred}" as the canonical type to avoid data loss. Cast the other side: USING column::${preferred}`;
  }

  // ──────────────────────────────────────────────
  // Schema file parser (SQL or JSON)
  // ──────────────────────────────────────────────

  private parseSchemaFile(content: string, name: string): DatabaseSchema {
    // Try JSON first (exported schema format)
    try {
      const parsed = JSON.parse(content) as DatabaseSchema;
      if (parsed.tables) { return parsed; }
    } catch {
      // Not JSON — treat as SQL
    }

    // Parse as SQL CREATE TABLE statements
    const tables: Record<string, TableDefinition> = {};
    const createRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(([^;]+)\)/gis;
    let match: RegExpExecArray | null;

    while ((match = createRegex.exec(content)) !== null) {
      const tableName = match[1];
      const columns = this.parseColumnDefs(match[2]);
      tables[tableName] = { name: tableName, columns, indexes: [] };
    }

    return {
      dbType: 'postgresql',
      databaseName: name,
      tables,
      extractedAt: Date.now(),
    };
  }

  private parseColumnDefs(defs: string): Record<string, ColumnDefinition> {
    const columns: Record<string, ColumnDefinition> = {};
    const lines = defs.split('\n').map(l => l.trim()).filter(l => l && !/^\s*(PRIMARY|FOREIGN|UNIQUE|CHECK|INDEX|CONSTRAINT|KEY)/i.test(l));

    for (const line of lines) {
      const m = /["`]?(\w+)["`]?\s+(\w+(?:\([^)]+\))?)/i.exec(line);
      if (!m) { continue; }
      columns[m[1]] = {
        name: m[1],
        type: m[2],
        nullable: !line.toUpperCase().includes('NOT NULL'),
        isPrimaryKey: line.toUpperCase().includes('PRIMARY KEY'),
        isForeignKey: line.toUpperCase().includes('REFERENCES'),
      };
    }

    return columns;
  }
}
