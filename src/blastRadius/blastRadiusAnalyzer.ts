// src/blastRadius/blastRadiusAnalyzer.ts
// Member 1 — 4-Dimension Blast Radius Analyzer
// Predicts the full impact of any migration across: schema, app dependencies,
// data integrity, and documentation drift.

import * as vscode from 'vscode';
import * as path from 'path';
import {
  BlastRadiusResult,
  AppDependency,
  DataIntegrityRisk,
  DocumentationDrift,
  SchemaImpact,
  RiskLevel,
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

    const riskScore = this.calculateRiskScore(schemaImpact, appDeps, dataRisks, docDrift);
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

    const sql = parsed.rawSql.toUpperCase();

    if (parsed.operation === 'DROP') {
      breaking.push(`DROP TABLE removes all data and invalidates all foreign key references`);
    }
    if (parsed.operation === 'ALTER') {
      if (/DROP\s+COLUMN/.test(sql)) {
        breaking.push(`DROP COLUMN destroys column data permanently`);
      }
      if (/RENAME\s+(?:COLUMN|TABLE)/.test(sql)) {
        breaking.push(`RENAME will break all existing queries and ORM mappings`);
      }
      if (/MODIFY|CHANGE/.test(sql)) {
        breaking.push(`Column type change may cause data truncation or conversion errors`);
      }
      if (/ADD\s+COLUMN/.test(sql)) {
        nonBreaking.push(`ADD COLUMN is backward-compatible if nullable or has a default`);
      }
      if (/ADD.*NOT NULL/.test(sql) && !/DEFAULT/.test(sql)) {
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
          // Match table names in SQL strings, ORM models, query builders
          const patterns = [
            new RegExp(`['"\`].*\\b${tableName}\\b.*['"\`]`, 'gi'),
            new RegExp(`\\b${tableName}\\b`, 'gi'),
          ];
          for (const pattern of patterns) {
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(text)) !== null) {
              const line = doc.positionAt(match.index).line;
              const lineText = doc.lineAt(line).text.trim();
              // Filter out comment lines and import/require lines
              if (lineText.startsWith('//') || lineText.startsWith('#') || lineText.startsWith('import')) { continue; }
              deps.push({
                filePath: vscode.workspace.asRelativePath(file),
                lineNumber: line + 1,
                tableName,
                usage: lineText.slice(0, 100),
                severity: this.classifyDepSeverity(lineText),
              });
              break; // one match per table per file
            }
          }
        }
      } catch {
        // skip unreadable files
      }
    }

    return deps.slice(0, 50); // cap results
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
    const sql = parsed.rawSql.toUpperCase();

    if (parsed.operation === 'DELETE' && !/WHERE/.test(sql)) {
      risks.push({
        description: 'DELETE without WHERE clause — will remove ALL rows in the table',
        severity: 'critical',
      });
    }
    if (parsed.operation === 'UPDATE' && !/WHERE/.test(sql)) {
      risks.push({
        description: 'UPDATE without WHERE clause — will update ALL rows in the table',
        severity: 'critical',
      });
    }
    if (/ALTER.*DROP\s+COLUMN/.test(sql)) {
      risks.push({
        description: 'DROP COLUMN is irreversible — ensure a backup exists before proceeding',
        severity: 'high',
      });
    }
    if (/NOT\s+NULL/.test(sql) && !/DEFAULT/.test(sql) && !/ADD\s+COLUMN/.test(sql)) {
      risks.push({
        description: 'Adding NOT NULL constraint without DEFAULT will fail if any existing row has NULL',
        severity: 'high',
      });
    }
    if (/CASCADE/.test(sql)) {
      risks.push({
        description: 'CASCADE operation will propagate to all child tables — audit foreign key references',
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
        const doc = await vscode.workspace.openTextDocument(file);
        const text = doc.getText();
        for (const tableName of tables) {
          if (!text.toLowerCase().includes(tableName.toLowerCase())) {
            const relPath = vscode.workspace.asRelativePath(file);
            if (relPath.toLowerCase().includes('readme') || relPath.toLowerCase().includes('api') || relPath.toLowerCase().includes('schema')) {
              drifts.push({
                filePath: relPath,
                issue: `Table "${tableName}" is not documented in ${path.basename(file.fsPath)}`,
                suggestion: `Add documentation for the ${tableName} table to ${relPath}`,
              });
            }
          }
        }
      } catch {
        // skip
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
    docs: DocumentationDrift[]
  ): number {
    let score = 1;
    score += Math.min(schema.breakingChanges.length * 2, 4);
    score += Math.min(schema.cascadeEffects.length * 0.5, 2);
    score += data.filter(r => r.severity === 'critical').length * 2;
    score += data.filter(r => r.severity === 'high').length * 1;
    score += Math.min(deps.filter(d => d.severity === 'critical').length * 0.5, 1.5);
    score += Math.min(docs.length * 0.2, 1);
    return Math.min(Math.round(score), 10);
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
}
