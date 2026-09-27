"use strict";
// src/diagnostics/sqlDiagnosticProvider.ts
// Member 2 — Real-Time SQL Diagnostics
// Detects logical errors as you type: red squiggles, interruption warnings,
// and risk-based diagnostics for destructive SQL patterns.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqlDiagnosticProvider = void 0;
const vscode = __importStar(require("vscode"));
const logger_1 = require("../utils/logger");
const DIAGNOSTIC_RULES = [
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
        severity: 'information',
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
class SqlDiagnosticProvider {
    constructor(schemaState, contextManager) {
        this.schemaState = schemaState;
        this.contextManager = contextManager;
        this.logger = logger_1.Logger.getInstance();
        this.debounceTimer = null;
        this.DEBOUNCE_MS = 500;
        this.interruptShown = new Set(); // Track shown interrupts per document
    }
    register(collection, context) {
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
    async analyze(document, collection) {
        const config = vscode.workspace.getConfiguration('dbscope');
        if (!config.get('diagnosticsEnabled', true)) {
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
    runRules(text) {
        const diagnostics = [];
        for (const rule of DIAGNOSTIC_RULES) {
            const regex = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', '') + 'g');
            let match;
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
    toVsDiagnostic(document, diag) {
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
    toVsSeverity(sev) {
        switch (sev) {
            case 'error': return vscode.DiagnosticSeverity.Error;
            case 'warning': return vscode.DiagnosticSeverity.Warning;
            case 'info': return vscode.DiagnosticSeverity.Information;
        }
    }
    // ──────────────────────────────────────────────
    // Interrupt Warning Modal
    // ──────────────────────────────────────────────
    showInterruptWarning(message, suggestion) {
        const detail = suggestion ? `\n\n💡 Suggestion: ${suggestion}` : '';
        vscode.window.showWarningMessage(`⚠ DB-Scope Warning: ${message}${detail}`, { modal: false }, 'View Analysis').then(selection => {
            if (selection === 'View Analysis') {
                vscode.commands.executeCommand('dbscope.analyzeBlastRadius');
            }
        });
    }
    // ──────────────────────────────────────────────
    // Debounce
    // ──────────────────────────────────────────────
    debounce(fn) {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(fn, this.DEBOUNCE_MS);
    }
}
exports.SqlDiagnosticProvider = SqlDiagnosticProvider;
//# sourceMappingURL=sqlDiagnosticProvider.js.map