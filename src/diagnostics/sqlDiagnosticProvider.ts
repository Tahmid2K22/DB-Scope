// src/diagnostics/sqlDiagnosticProvider.ts
// Member 2 — Real-Time SQL Diagnostics
// Detects logical errors as you type: red squiggles, interruption warnings,
// and risk-based diagnostics for destructive SQL patterns.

import * as vscode from 'vscode';
import { SchemaStateMap } from '../core/schemaStateMap';
import { ContextManager } from '../contextManager/contextManager';
import { parseSql } from '../utils/sqlParser';
import { SqlDiagnostic, DiagnosticSeverity } from '../core/types';
import { Logger } from '../utils/logger';

interface DiagnosticRule {
  pattern: RegExp;
  message: string;
  severity: DiagnosticSeverity;
  suggestion?: string;
  showInterrupt?: boolean; // Show a modal warning popup
}

const DIAGNOSTIC_RULES: DiagnosticRule[] = [
  {
    pattern: /\bDROP\s+(?:TABLE|COLUMN|DATABASE)\b/i,
    message: 'Destructive operation: This will permanently remove data.',
    severity: 'error',
    suggestion: 'Consider using a soft-delete or rename approach first.',
    showInterrupt: true,
  },
  {
    pattern: /\bTRUNCATE\b/i,
    message: 'TRUNCATE removes ALL rows — this is irreversible without a backup.',
    severity: 'error',
    suggestion: 'Use a DELETE with WHERE clause if you only need to remove some rows.',
    showInterrupt: true,
  },
  {
    pattern: /\bDELETE\s+FROM\b(?![^;]*WHERE)/i,
    message: 'DELETE without WHERE will remove ALL rows in the table.',
    severity: 'error',
    suggestion: 'Add a WHERE clause to target specific rows.',
    showInterrupt: true,
  },
  {
    pattern: /\bUPDATE\s+\w+\s+SET\b(?![^;]*WHERE)/i,
    message: 'UPDATE without WHERE will modify ALL rows in the table.',
    severity: 'error',
    suggestion: 'Add a WHERE clause to target specific rows.',
    showInterrupt: true,
  },
  {
    pattern: /ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\s+\w+\s+\w+\s+NOT\s+NULL(?!\s+DEFAULT)/i,
    message: 'NOT NULL column without DEFAULT will fail on existing rows.',
    severity: 'warning',
    suggestion: 'Add a DEFAULT value or make the column NULLABLE first, then backfill.',
  },
  {
    pattern: /\bDROP\s+INDEX\b/i,
    message: 'Dropping an index may slow down queries that rely on it.',
    severity: 'warning',
    suggestion: 'Check query performance before removing this index.',
  },
  {
    pattern: /\bSELECT\s+\*/i,
    message: 'SELECT * fetches all columns — can be slow and fragile.',
    severity: 'info',
    suggestion: 'Specify only the columns you need for better performance and clarity.',
  },
  {
    pattern: /ALTER\s+TABLE\s+\w+\s+RENAME\b/i,
    message: 'Renaming a table/column breaks all queries and ORM mappings that reference it.',
    severity: 'warning',
    suggestion: 'Add an alias or view layer before renaming to maintain backward compatibility.',
    showInterrupt: true,
  },
];

export class SqlDiagnosticProvider {
  private readonly logger = Logger.getInstance();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 500;
  private interruptShown = new Set<string>(); // Track shown interrupts per document

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
        this.debounce(() => this.analyze(evt.document, collection));
      }
    }, null, context.subscriptions);

    // Analyze when a SQL file is opened
    vscode.workspace.onDidOpenTextDocument(doc => {
      if (doc.languageId === 'sql' || doc.fileName.endsWith('.sql')) {
        this.analyze(doc, collection);
      }
    }, null, context.subscriptions);

    // Clear diagnostics when file is closed
    vscode.workspace.onDidCloseTextDocument(doc => {
      collection.delete(doc.uri);
      this.interruptShown.delete(doc.uri.toString());
    }, null, context.subscriptions);

    // Analyze all already-open SQL documents
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.languageId === 'sql') {
        this.analyze(doc, collection);
      }
    }
  }

  // ──────────────────────────────────────────────
  // Core Analysis
  // ──────────────────────────────────────────────

  private async analyze(
    document: vscode.TextDocument,
    collection: vscode.DiagnosticCollection
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('dbscope');
    if (!config.get<boolean>('diagnosticsEnabled', true)) {
      collection.delete(document.uri);
      return;
    }

    const text = document.getText();
    const rawDiagnostics = this.runRules(text);
    const vsDiagnostics = rawDiagnostics.map(d => this.toVsDiagnostic(document, d));

    collection.set(document.uri, vsDiagnostics);

    // Show interruption modal for critical operations (once per document per session)
    const criticalRules = rawDiagnostics.filter(d => d.severity === 'error');
    const docKey = document.uri.toString();
    for (const diag of criticalRules) {
      const interruptKey = `${docKey}:${diag.startOffset}`;
      if (!this.interruptShown.has(interruptKey)) {
        this.interruptShown.add(interruptKey);
        this.showInterruptWarning(diag.message, diag.suggestion);
      }
    }
  }

  // ──────────────────────────────────────────────
  // Rule Engine
  // ──────────────────────────────────────────────

  private runRules(text: string): SqlDiagnostic[] {
    const diagnostics: SqlDiagnostic[] = [];

    for (const rule of DIAGNOSTIC_RULES) {
      const regex = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', '') + 'g');
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        diagnostics.push({
          message: rule.message,
          severity: rule.severity,
          startOffset: match.index,
          endOffset: match.index + match[0].length,
          suggestion: rule.suggestion,
        });
      }
    }

    return diagnostics;
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
    vsDiag.code = 'db-scope-diagnostic';
    return vsDiag;
  }

  private toVsSeverity(sev: DiagnosticSeverity): vscode.DiagnosticSeverity {
    switch (sev) {
      case 'error': return vscode.DiagnosticSeverity.Error;
      case 'warning': return vscode.DiagnosticSeverity.Warning;
      case 'info': return vscode.DiagnosticSeverity.Information;
    }
  }

  // ──────────────────────────────────────────────
  // Interrupt Warning Modal
  // ──────────────────────────────────────────────

  private showInterruptWarning(message: string, suggestion?: string): void {
    const detail = suggestion ? `\n\n💡 Suggestion: ${suggestion}` : '';
    vscode.window.showWarningMessage(
      `⚠ DB-Scope Warning: ${message}${detail}`,
      { modal: false },
      'View Analysis'
    ).then(selection => {
      if (selection === 'View Analysis') {
        vscode.commands.executeCommand('dbscope.analyzeBlastRadius');
      }
    });
  }

  // ──────────────────────────────────────────────
  // Debounce
  // ──────────────────────────────────────────────

  private debounce(fn: () => void): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
    this.debounceTimer = setTimeout(fn, this.DEBOUNCE_MS);
  }
}
