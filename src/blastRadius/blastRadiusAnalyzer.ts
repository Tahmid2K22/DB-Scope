// src/blastRadius/blastRadiusAnalyzer.ts
// Member 1 — 4-Dimension Blast Radius Analyzer
// Predicts the full impact of any migration across: schema, app dependencies,
// data integrity, and documentation drift.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  BlastRadiusResult,
  AppDependency,
  DataIntegrityRisk,
  DocumentationDrift,
  SchemaImpact,
  RiskLevel,
  RollbackSuggestion,
} from '../core/types';
import { SchemaStateMap } from '../core/schemaStateMap';
import { parseSql } from '../utils/sqlParser';
import { Logger } from '../utils/logger';

export class BlastRadiusAnalyzer {
  private readonly logger = Logger.getInstance();

  constructor(private readonly schemaState: SchemaStateMap) {}

  // ──────────────────────────────────────────────
  // Main entry point
  // ──────────────────────────────────────────────

  async analyze(sql: string): Promise<BlastRadiusResult> {
    this.logger.info(`BlastRadius: analyzing SQL (${sql.length} chars)`);
    const parsed = parseSql(sql);

    const [schemaImpact, appDeps, dataRisks, docDrift] = await Promise.all([
      this.analyzeSchemaImpact(parsed),
      this.findAppDependencies(parsed.tables),
      this.assessDataIntegrityRisks(parsed),
      this.detectDocumentationDrift(parsed.tables),
    ]);

    const riskScore = this.calculateRiskScore(schemaImpact, appDeps, dataRisks, docDrift, parsed.tables);
    const riskLevel = this.scoreToLevel(riskScore);

    return {
      sql,
      riskScore,
      riskLevel,
      affectedTables: parsed.tables,
      schemaImpact,
      appDependencies: appDeps,
      dataIntegrityRisks: dataRisks,
      documentationDrift: docDrift,
      suggestions: this.buildSuggestions(schemaImpact, appDeps, dataRisks, riskScore),
      rollbackSuggestions: this.buildRollbackSuggestions(parsed),
      generatedAt: Date.now(),
    };
  }

  // ──────────────────────────────────────────────
  // Dimension 1: Schema Impact
  // ──────────────────────────────────────────────

  private async analyzeSchemaImpact(parsed: ReturnType<typeof parseSql>): Promise<SchemaImpact> {
    const breaking: string[] = [];
    const nonBreaking: string[] = [];
    const cascade: string[] = [];

    // Use original SQL with /i flag — no need to uppercase
    const sql = parsed.rawSql;

    if (parsed.operation === 'DROP') {
      breaking.push(`DROP TABLE removes all data and invalidates all foreign key references`);
    }
    if (parsed.operation === 'ALTER') {
      if (/DROP\s+COLUMN/i.test(sql)) {
        breaking.push(`DROP COLUMN destroys column data permanently`);
      }
      if (/RENAME\s+(?:COLUMN|TABLE)/i.test(sql)) {
        breaking.push(`RENAME will break all existing queries and ORM mappings`);
      }
      if (/\bMODIFY\b|\bCHANGE\b/i.test(sql)) {
        breaking.push(`Column type change may cause data truncation or conversion errors`);
      }
      if (/ADD\s+COLUMN/i.test(sql)) {
        nonBreaking.push(`ADD COLUMN is backward-compatible if nullable or has a default`);
      }
      if (/ADD.*NOT\s+NULL/i.test(sql) && !/DEFAULT/i.test(sql)) {
        breaking.push(`NOT NULL constraint without DEFAULT will fail on existing rows`);
      }
    }
    if (parsed.operation === 'DELETE') {
      breaking.push(`DELETE may cascade to child tables via foreign key constraints`);
    }
    if (parsed.operation === 'TRUNCATE') {
      breaking.push(`TRUNCATE removes ALL rows — irreversible without a backup`);
    }

    // Check cascade effects from schema
    for (const tableName of parsed.tables) {
      const table = this.schemaState.getTable(tableName);
      if (table) {
        for (const col of Object.values(table.columns)) {
          if (col.isForeignKey && col.referencesTable) {
            cascade.push(`Foreign key ${tableName}.${col.name} → ${col.referencesTable}.${col.referencesColumn}`);
          }
        }
      }
    }

    return { breakingChanges: breaking, nonBreakingChanges: nonBreaking, cascadeEffects: cascade };
  }

  // ──────────────────────────────────────────────
  // Dimension 2: App Dependencies
  // ──────────────────────────────────────────────

  private async findAppDependencies(tables: string[]): Promise<AppDependency[]> {
    if (tables.length === 0) { return []; }

    const deps: AppDependency[] = [];
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) { return []; }

    const sourceGlob = '**/*.{ts,js,py,java,rb,go,cs}';
    const files = await vscode.workspace.findFiles(sourceGlob, '**/node_modules/**', 200);

    for (const file of files) {
      try {
        const doc = await vscode.workspace.openTextDocument(file);
        const text = doc.getText();
        for (const tableName of tables) {
          // Build search terms: literal table name + ORM model class name (PascalCase singular)
          const searchTerms = [tableName, this.deriveModelName(tableName)];
          let foundInFile = false;

          for (const term of searchTerms) {
            if (foundInFile) { break; }
            const pattern = new RegExp(`\\b${term}\\b`, 'gi');
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(text)) !== null) {
              const line = doc.positionAt(match.index).line;
              const lineText = doc.lineAt(line).text.trim();
              // Filter out comment-only lines and bare import/require lines
              if (lineText.startsWith('//') || lineText.startsWith('#') || lineText.startsWith('import') || lineText.startsWith('require')) { continue; }
              deps.push({
                filePath: vscode.workspace.asRelativePath(file),
                lineNumber: line + 1,
                tableName,
                usage: lineText.slice(0, 100),
                severity: this.classifyDepSeverity(lineText),
              });
              foundInFile = true;
              break; // one match per (table + file) pair
            }
          }
        }
      } catch {
        // skip unreadable files
      }
    }

    return deps.slice(0, 50); // cap results
  }

  /**
   * Derives the ORM model class name from a table name.
   * "users" → "User",  "order_items" → "OrderItem",  "categories" → "Category"
   */
  private deriveModelName(tableName: string): string {
    // Split on underscores, capitalise each word, join
    const pascal = tableName
      .split('_')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join('');
    // Strip common plural suffixes to get the singular model name
    if (pascal.endsWith('ies')) { return pascal.slice(0, -3) + 'y'; }  // categories → Category
    if (pascal.endsWith('ses')) { return pascal.slice(0, -2); }          // statuses → Status
    if (pascal.endsWith('s') && !pascal.endsWith('ss')) { return pascal.slice(0, -1); } // users → User
    return pascal;
  }

  private classifyDepSeverity(lineText: string): RiskLevel {
    const line = lineText.toLowerCase();
    if (/delete|drop|truncate|remove/.test(line)) { return 'critical'; }
    if (/update|alter|modify|insert/.test(line)) { return 'high'; }
    if (/select|find|fetch|get|query/.test(line)) { return 'medium'; }
    return 'low';
  }

  // ──────────────────────────────────────────────
  // Dimension 3: Data Integrity Risks
  // ──────────────────────────────────────────────

  private async assessDataIntegrityRisks(parsed: ReturnType<typeof parseSql>): Promise<DataIntegrityRisk[]> {
    const risks: DataIntegrityRisk[] = [];
    // Use original SQL with /i flag — no uppercase needed
    const sql = parsed.rawSql;

    if (parsed.operation === 'DELETE' && !/WHERE/i.test(sql)) {
      risks.push({
        description: 'DELETE without WHERE clause — will remove ALL rows in the table',
        severity: 'critical',
      });
    }
    if (parsed.operation === 'UPDATE' && !/WHERE/i.test(sql)) {
      risks.push({
        description: 'UPDATE without WHERE clause — will update ALL rows in the table',
        severity: 'critical',
      });
    }
    if (/ALTER.*DROP\s+COLUMN/i.test(sql)) {
      risks.push({
        description: 'DROP COLUMN is irreversible — ensure a backup exists before proceeding',
        severity: 'high',
      });
    }
    if (/NOT\s+NULL/i.test(sql) && !/DEFAULT/i.test(sql) && !/ADD\s+COLUMN/i.test(sql)) {
      risks.push({
        description: 'Adding NOT NULL constraint without DEFAULT will fail if any existing row has NULL',
        severity: 'high',
      });
    }
    if (/\bCASCADE\b/i.test(sql)) {
      risks.push({
        description: 'CASCADE operation will propagate to all child tables — audit foreign key references',
        severity: 'medium',
      });
    }
    // Step 4 — 4 additional rules
    if (/ALTER\s+TABLE.*DROP\s+FOREIGN\s+KEY/i.test(sql)) {
      risks.push({
        description: 'DROP FOREIGN KEY removes referential integrity — orphan rows may be created',
        severity: 'high',
      });
    }
    if (/ALTER\s+TABLE.*DROP\s+PRIMARY\s+KEY/i.test(sql)) {
      risks.push({
        description: 'DROP PRIMARY KEY makes the table unaddressable by index — severe performance impact',
        severity: 'high',
      });
    }
    if (/CREATE\s+UNIQUE\s+INDEX/i.test(sql)) {
      risks.push({
        description: 'CREATE UNIQUE INDEX will fail if existing rows contain duplicate values in the indexed column(s)',
        severity: 'high',
      });
    }
    if (/ENGINE\s*=/i.test(sql)) {
      risks.push({
        description: 'Changing storage ENGINE (e.g. InnoDB → MyISAM) rewrites the entire table and is not easily reversible',
        severity: 'medium',
      });
    }

    return risks;
  }

  // ──────────────────────────────────────────────
  // Dimension 4: Documentation Drift
  // ──────────────────────────────────────────────

  private async detectDocumentationDrift(tables: string[]): Promise<DocumentationDrift[]> {
    const drifts: DocumentationDrift[] = [];
    if (tables.length === 0) { return []; }

    const docFiles = await vscode.workspace.findFiles('**/*.{md,yaml,yml,json}', '**/node_modules/**', 50);

    for (const file of docFiles) {
      try {
        const relPath = vscode.workspace.asRelativePath(file);
        const isDocFile = /readme|api|schema/i.test(relPath);
        if (!isDocFile) { continue; } // skip early — no need to open non-doc files

        const doc = await vscode.workspace.openTextDocument(file);
        const text = doc.getText().toLowerCase();

        for (const tableName of tables) {
          if (!text.includes(tableName.toLowerCase())) {
            drifts.push({
              filePath: relPath,
              issue: `Table "${tableName}" is not documented in ${path.basename(file.fsPath)}`,
              suggestion: `Add documentation for the ${tableName} table to ${relPath}`,
            });
          }
        }
      } catch {
        // skip unreadable files
      }
    }

    return drifts.slice(0, 20);
  }

  // ──────────────────────────────────────────────
  // Risk Score (1-10)
  // ──────────────────────────────────────────────

  private calculateRiskScore(
    schema: SchemaImpact,
    deps: AppDependency[],
    data: DataIntegrityRisk[],
    docs: DocumentationDrift[],
    tables: string[]           // Step 5: needed for row-count weighting
  ): number {
    // Base: 0. Each dimension contributes up to a capped amount. Max total = 10.
    let score = 0;
    // Dimension 1 — Schema (max 5): breaking changes worth 2 each (cap 4), cascades 0.5 each (cap 1)
    score += Math.min(schema.breakingChanges.length * 2, 4);
    score += Math.min(schema.cascadeEffects.length * 0.5, 1);
    // Dimension 2 — App deps (max 2): critical usages found in source files
    score += Math.min(deps.filter(d => d.severity === 'critical').length, 2);
    // Dimension 3 — Data integrity (max 3): critical=2pts, high=1pt
    score += Math.min(data.filter(r => r.severity === 'critical').length * 2, 2);
    score += Math.min(data.filter(r => r.severity === 'high').length, 1);
    // Dimension 4 — Docs drift (max 1): 0.25 per undocumented table
    score += Math.min(docs.length * 0.25, 1);

    // Step 5 — Row-count size multiplier: large tables amplify risk
    const sizeFactor = this.getTableSizeFactor(tables);
    score = score * sizeFactor;

    // Always at least 1 for any analyzed SQL
    return Math.min(Math.max(Math.round(score), 1), 10);
  }

  /** Returns a multiplier based on the largest rowCount of affected tables. */
  private getTableSizeFactor(tables: string[]): number {
    let maxRows = 0;
    for (const tableName of tables) {
      const table = this.schemaState.getTable(tableName);
      if (table?.rowCount && table.rowCount > maxRows) {
        maxRows = table.rowCount;
      }
    }
    if (maxRows > 1_000_000) { return 1.5; }
    if (maxRows > 100_000)   { return 1.25; }
    if (maxRows > 10_000)    { return 1.1; }
    return 1.0;
  }

  private scoreToLevel(score: number): RiskLevel {
    if (score >= 8) { return 'critical'; }
    if (score >= 6) { return 'high'; }
    if (score >= 4) { return 'medium'; }
    return 'low';
  }

  private buildSuggestions(
    schema: SchemaImpact,
    deps: AppDependency[],
    data: DataIntegrityRisk[],
    score: number
  ): string[] {
    const suggestions: string[] = [];
    if (schema.breakingChanges.some(c => c.includes('NOT NULL'))) {
      suggestions.push('Make the column NULLABLE first, backfill data, then add the NOT NULL constraint');
    }
    if (schema.breakingChanges.some(c => c.includes('DROP'))) {
      suggestions.push('Consider renaming the column/table first (soft-delete approach) instead of immediate DROP');
    }
    if (data.some(r => r.description.includes('without WHERE'))) {
      suggestions.push('Add a WHERE clause or use a transaction with a dry-run SELECT count first');
    }
    if (deps.length > 5) {
      suggestions.push(`Update ${deps.length} affected files before applying migration`);
    }
    if (score >= 7) {
      suggestions.push('This migration scores HIGH RISK — require DBA approval before deploying to production');
    }
    return suggestions;
  }

  // ──────────────────────────────────────────────
  // Step 2: Rollback SQL generator
  // ──────────────────────────────────────────────

  private buildRollbackSuggestions(parsed: ReturnType<typeof parseSql>): RollbackSuggestion[] {
    const rollbacks: RollbackSuggestion[] = [];
    const sql = parsed.rawSql;

    // DROP TABLE → reconstruct CREATE TABLE from schema state
    if (parsed.operation === 'DROP') {
      for (const tableName of parsed.tables) {
        const table = this.schemaState.getTable(tableName);
        if (table) {
          const cols = Object.values(table.columns)
            .map(c => {
              let def = `  ${c.name} ${c.type}`;
              if (!c.nullable) { def += ' NOT NULL'; }
              if (c.isPrimaryKey) { def += ' PRIMARY KEY'; }
              return def;
            })
            .join(',\n');
          rollbacks.push({
            description: `Recreate table "${tableName}" from last known schema snapshot`,
            sql: `CREATE TABLE IF NOT EXISTS ${tableName} (\n${cols}\n);`,
            safetyLevel: 'manual_review',
          });
        } else {
          rollbacks.push({
            description: `Cannot auto-generate rollback for "${tableName}" — no schema snapshot available`,
            sql: `-- Run "DB-Scope: Fetch Database Context" before the migration to enable auto-rollback`,
            safetyLevel: 'destructive',
          });
        }
      }
      return rollbacks;
    }

    // ALTER TABLE DROP COLUMN → ADD COLUMN back
    const dropColMatch = /ALTER\s+TABLE\s+(\w+)\s+DROP\s+COLUMN\s+(\w+)/i.exec(sql);
    if (dropColMatch) {
      const [, tbl, col] = dropColMatch;
      const colDef = this.schemaState.getTable(tbl)?.columns[col];
      const typePart = colDef ? `${colDef.type}${colDef.nullable ? '' : ' NOT NULL'}` : 'TEXT /* original type unknown */';
      rollbacks.push({
        description: `Re-add column "${col}" to "${tbl}"`,
        sql: `ALTER TABLE ${tbl} ADD COLUMN ${col} ${typePart};`,
        safetyLevel: colDef ? 'safe' : 'manual_review',
      });
    }

    // ALTER TABLE ADD COLUMN → DROP COLUMN
    const addColMatch = /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/i.exec(sql);
    if (addColMatch) {
      const [, tbl, col] = addColMatch;
      rollbacks.push({
        description: `Remove newly added column "${col}" from "${tbl}"`,
        sql: `ALTER TABLE ${tbl} DROP COLUMN ${col};`,
        safetyLevel: 'safe',
      });
    }

    // ALTER TABLE RENAME COLUMN a TO b → RENAME COLUMN b TO a
    const renameColMatch = /ALTER\s+TABLE\s+(\w+)\s+RENAME\s+COLUMN\s+(\w+)\s+TO\s+(\w+)/i.exec(sql);
    if (renameColMatch) {
      const [, tbl, from, to] = renameColMatch;
      rollbacks.push({
        description: `Rename column "${to}" back to "${from}" on table "${tbl}"`,
        sql: `ALTER TABLE ${tbl} RENAME COLUMN ${to} TO ${from};`,
        safetyLevel: 'safe',
      });
    }

    // ALTER TABLE RENAME TABLE a TO b → RENAME TABLE b TO a  (MySQL syntax)
    const renameTblMatch = /RENAME\s+TABLE\s+(\w+)\s+TO\s+(\w+)/i.exec(sql);
    if (renameTblMatch) {
      const [, from, to] = renameTblMatch;
      rollbacks.push({
        description: `Rename table "${to}" back to "${from}"`,
        sql: `RENAME TABLE ${to} TO ${from};`,
        safetyLevel: 'safe',
      });
    }

    // CREATE INDEX → DROP INDEX
    const createIdxMatch = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(\w+)/i.exec(sql);
    if (createIdxMatch) {
      const [, idxName] = createIdxMatch;
      rollbacks.push({
        description: `Drop the newly created index "${idxName}"`,
        sql: `DROP INDEX ${idxName};`,
        safetyLevel: 'safe',
      });
    }

    // DELETE / TRUNCATE — no auto-rollback possible
    if (parsed.operation === 'DELETE' || parsed.operation === 'TRUNCATE') {
      rollbacks.push({
        description: 'No automatic rollback available for data deletion',
        sql: '-- Take a point-in-time backup (pg_dump / mysqldump) BEFORE running this statement.',
        safetyLevel: 'destructive',
      });
    }

    return rollbacks;
  }

  // ──────────────────────────────────────────────
  // Step 8: Export analysis result to JSON file
  // ──────────────────────────────────────────────

  async exportResult(result: BlastRadiusResult, targetDir: string): Promise<string> {
    const tableSlug = (result.affectedTables[0] ?? 'unknown').replace(/[^a-z0-9]/gi, '-');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `blast-radius-${tableSlug}-${timestamp}.json`;
    const filePath = path.join(targetDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
    this.logger.info(`BlastRadius: exported analysis to ${filePath}`);
    return filePath;
  }
}
