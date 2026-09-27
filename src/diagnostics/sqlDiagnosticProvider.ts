// src/diagnostics/sqlDiagnosticProvider.ts
// Member 2 — Real-Time SQL Diagnostics
// Orchestrates the SQL tokenizer, schema-aware rules, and legacy pattern rules.
// Produces VS Code squiggles and (optionally) modal alerts for destructive ops.

import * as vscode from 'vscode';
import { SchemaStateMap } from '../core/schemaStateMap';
import { ContextManager } from '../contextManager/contextManager';
import { SqlDiagnostic } from '../core/types';
import { Logger } from '../utils/logger';
import { splitSqlStatements } from './sqlTokenizer';
import { runSchemaRules, runPatternRules } from './schemaDiagnostics';

// Codes that require a modal on save
const MODAL_CODES = new Set([
  'DBS-DESTRUCT-001',
  'DBS-DESTRUCT-002',
  'DBS-DESTRUCT-003',
]);

export class SqlDiagnosticProvider {
  private readonly logger = Logger.getInstance();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 500;

  // Session-level set: `docUri:fingerprint` — prevents repeated modals for same statement
  private readonly sessionAlerts = new Set<string>();

  constructor(
    private readonly schemaState: SchemaStateMap,
    private readonly contextManager: ContextManager
  ) {}

  register(
    collection: vscode.DiagnosticCollection,
    context: vscode.ExtensionContext
  ): void {
    // Analyze on document change (debounced)
    vscode.workspace.onDidChangeTextDocument(evt => {
      const lang = evt.document.languageId;
      if (lang === 'sql' || evt.document.fileName.endsWith('.sql')) {
        this.debounce(() => this.analyze(evt.document, collection, 'edit'));
      }
    }, null, context.subscriptions);

    // Analyze when a SQL file is opened
    vscode.workspace.onDidOpenTextDocument(doc => {
      if (doc.languageId === 'sql' || doc.fileName.endsWith('.sql')) {
        this.analyze(doc, collection, 'open');
      }
    }, null, context.subscriptions);

    // Analyze on save — also triggers modals
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.languageId === 'sql' || doc.fileName.endsWith('.sql')) {
        this.analyze(doc, collection, 'save');
      }
    }, null, context.subscriptions);

    // Clear diagnostics when file is closed
    vscode.workspace.onDidCloseTextDocument(doc => {
      collection.delete(doc.uri);
    }, null, context.subscriptions);

    // Analyze all already-open SQL documents
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.languageId === 'sql' || doc.fileName.endsWith('.sql')) {
        this.analyze(doc, collection, 'open');
      }
    }
  }

  /**
   * Gate for "execute" flow: shows modal warnings before the user runs destructive SQL.
   * Called by extension.ts at the top of dbscope.analyzeBlastRadius command.
   */
  async promptDestructiveGate(document: vscode.TextDocument): Promise<void> {
    const config = vscode.workspace.getConfiguration('dbscope');
    if (!config.get<boolean>('diagnosticsEnabled', true)) { return; }
    const text = document.getText();
    const statements = splitSqlStatements(text);
    const schema = await this.schemaState.getCurrentSchema();
    for (const stmt of statements) {
      const patternDiags = runPatternRules(stmt.sql, stmt.clauseMask, stmt.startOffset);
      const schemaArr = runSchemaRules(stmt, schema);
      const all = [...patternDiags, ...schemaArr];
      await this.processModals(all, document, 'execute');
    }
  }

  // ──────────────────────────────────────────────
  // Core Analysis
  // ──────────────────────────────────────────────

  private async analyze(
    document: vscode.TextDocument,
    collection: vscode.DiagnosticCollection,
    trigger: 'edit' | 'open' | 'save' | 'execute'
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('dbscope');
    if (!config.get<boolean>('diagnosticsEnabled', true)) {
      collection.delete(document.uri);
      return;
    }

    const text = document.getText();
    const statements = splitSqlStatements(text);
    const schema = await this.schemaState.getCurrentSchema();
    const allRaw: SqlDiagnostic[] = [];

    for (const stmt of statements) {
      const patternDiags = runPatternRules(stmt.sql, stmt.clauseMask, stmt.startOffset);
      const schemaArr = runSchemaRules(stmt, schema);
      allRaw.push(...patternDiags, ...schemaArr);
    }

    // Deduplicate by offset+code
    const seen = new Set<string>();
    const deduped = allRaw.filter(d => {
      const key = `${d.startOffset}:${d.code ?? d.message}`;
      if (seen.has(key)) { return false; }
      seen.add(key);
      return true;
    });

    collection.set(document.uri, deduped.map(d => this.toVsDiagnostic(document, d)));

    // Show modals only on save or open (not every keystroke)
    if (trigger === 'save' || trigger === 'open' || trigger === 'execute') {
      await this.processModals(deduped, document, trigger);
    }
  }

  // ──────────────────────────────────────────────
  // Modal processing (once per fingerprint per session)
  // ──────────────────────────────────────────────

  private async processModals(
    diagnostics: SqlDiagnostic[],
    document: vscode.TextDocument,
    trigger: string
  ): Promise<void> {
    const docKey = document.uri.toString();
    for (const diag of diagnostics) {
      if (!diag.code || !MODAL_CODES.has(diag.code)) { continue; }
      // Simple djb2 fingerprint over lowercased message + offset
      const fingerprint = `${docKey}:${diag.code}:${diag.startOffset}`;
      if (this.sessionAlerts.has(fingerprint)) { continue; }
      this.sessionAlerts.add(fingerprint);
      await this.showModalWarning(diag, trigger);
    }
  }

  private async showModalWarning(diag: SqlDiagnostic, _trigger: string): Promise<void> {
    const detail = diag.suggestion ? `\n💡 ${diag.suggestion}` : '';
    const choice = await vscode.window.showWarningMessage(
      `⚠ DB-Scope: ${diag.message}`,
      { modal: true, detail: detail || undefined },
      'Analyze Impact',
      'Dismiss'
    );
    if (choice === 'Analyze Impact') {
      vscode.commands.executeCommand('dbscope.analyzeBlastRadius');
    }
  }

  // ──────────────────────────────────────────────
  // VS Code Diagnostic conversion
  // ──────────────────────────────────────────────

  private toVsDiagnostic(
    document: vscode.TextDocument,
    diag: SqlDiagnostic
  ): vscode.Diagnostic {
    const start = document.positionAt(diag.startOffset);
    const end = document.positionAt(diag.endOffset);
    const range = new vscode.Range(start, end);

    const message = diag.suggestion
      ? `${diag.message}\n💡 ${diag.suggestion}`
      : diag.message;

    const vsDiag = new vscode.Diagnostic(range, message, this.toVsSeverity(diag.severity));
    vsDiag.source = 'DB-Scope';
    if (diag.code) { vsDiag.code = diag.code; }
    return vsDiag;
  }

  private toVsSeverity(sev: SqlDiagnostic['severity']): vscode.DiagnosticSeverity {
    switch (sev) {
      case 'error': return vscode.DiagnosticSeverity.Error;
      case 'warning': return vscode.DiagnosticSeverity.Warning;
      case 'info': return vscode.DiagnosticSeverity.Information;
    }
  }

  // ──────────────────────────────────────────────
  // Debounce
  // ──────────────────────────────────────────────

  private debounce(fn: () => void): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
    this.debounceTimer = setTimeout(fn, this.DEBOUNCE_MS);
  }
}
