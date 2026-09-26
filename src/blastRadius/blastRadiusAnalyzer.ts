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
          // Single pattern with word boundaries — avoids duplicate matches per file.
          // A new RegExp per table resets lastIndex automatically.
          const pattern = new RegExp(`\\b${tableName}\\b`, 'gi');
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
            break; // one match per table per file — stop after first valid hit
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
    docs: DocumentationDrift[]
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
    // Always at least 1 for any analyzed SQL
    return Math.min(Math.max(Math.round(score), 1), 10);
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
