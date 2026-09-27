"use strict";
// src/diagnostics/sqlDiagnosticProvider.ts
// Member 2 — Real-Time SQL Diagnostics
// Orchestrates the SQL tokenizer, schema-aware rules, and legacy pattern rules.
// Produces VS Code squiggles and (optionally) modal alerts for destructive ops.
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
const sqlTokenizer_1 = require("./sqlTokenizer");
const schemaDiagnostics_1 = require("./schemaDiagnostics");
// Codes that require a modal on save
const MODAL_CODES = new Set([
    'DBS-DESTRUCT-001',
    'DBS-DESTRUCT-002',
    'DBS-DESTRUCT-003',
]);
class SqlDiagnosticProvider {
    constructor(schemaState, contextManager) {
        this.schemaState = schemaState;
        this.contextManager = contextManager;
        this.logger = logger_1.Logger.getInstance();
        this.debounceTimer = null;
        this.DEBOUNCE_MS = 500;
        // Session-level set: `docUri:fingerprint` — prevents repeated modals for same statement
        this.sessionAlerts = new Set();
    }
    register(collection, context) {
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
    async promptDestructiveGate(document) {
        const config = vscode.workspace.getConfiguration('dbscope');
        if (!config.get('diagnosticsEnabled', true)) {
            return;
        }
        const text = document.getText();
        const statements = (0, sqlTokenizer_1.splitSqlStatements)(text);
        const schema = await this.schemaState.getCurrentSchema();
        for (const stmt of statements) {
            const patternDiags = (0, schemaDiagnostics_1.runPatternRules)(stmt.sql, stmt.clauseMask, stmt.startOffset);
            const schemaArr = (0, schemaDiagnostics_1.runSchemaRules)(stmt, schema);
            const all = [...patternDiags, ...schemaArr];
            await this.processModals(all, document, 'execute');
        }
    }
    // ──────────────────────────────────────────────
    // Core Analysis
    // ──────────────────────────────────────────────
    async analyze(document, collection, trigger) {
        const config = vscode.workspace.getConfiguration('dbscope');
        if (!config.get('diagnosticsEnabled', true)) {
            collection.delete(document.uri);
            return;
        }
        const text = document.getText();
        const statements = (0, sqlTokenizer_1.splitSqlStatements)(text);
        const schema = await this.schemaState.getCurrentSchema();
        const allRaw = [];
        for (const stmt of statements) {
            const patternDiags = (0, schemaDiagnostics_1.runPatternRules)(stmt.sql, stmt.clauseMask, stmt.startOffset);
            const schemaArr = (0, schemaDiagnostics_1.runSchemaRules)(stmt, schema);
            allRaw.push(...patternDiags, ...schemaArr);
        }
        // Deduplicate by offset+code
        const seen = new Set();
        const deduped = allRaw.filter(d => {
            const key = `${d.startOffset}:${d.code ?? d.message}`;
            if (seen.has(key)) {
                return false;
            }
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
    async processModals(diagnostics, document, trigger) {
        const docKey = document.uri.toString();
        for (const diag of diagnostics) {
            if (!diag.code || !MODAL_CODES.has(diag.code)) {
                continue;
            }
            // Simple djb2 fingerprint over lowercased message + offset
            const fingerprint = `${docKey}:${diag.code}:${diag.startOffset}`;
            if (this.sessionAlerts.has(fingerprint)) {
                continue;
            }
            this.sessionAlerts.add(fingerprint);
            await this.showModalWarning(diag, trigger);
        }
    }
    async showModalWarning(diag, _trigger) {
        const detail = diag.suggestion ? `\n💡 ${diag.suggestion}` : '';
        const choice = await vscode.window.showWarningMessage(`⚠ DB-Scope: ${diag.message}`, { modal: true, detail: detail || undefined }, 'Analyze Impact', 'Dismiss');
        if (choice === 'Analyze Impact') {
            vscode.commands.executeCommand('dbscope.analyzeBlastRadius');
        }
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
        if (diag.code) {
            vsDiag.code = diag.code;
        }
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