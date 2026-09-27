"use strict";
// src/contextManager/contextManager.ts
// Member 2 — Context Manager
// Fetches database schema from codebase (SQL migrations, Prisma, Django, TypeORM)
// and optionally from a live database connection. Merges both sources.
// Updates context automatically on file save and exposes a rich status bar.
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
exports.ContextManager = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const logger_1 = require("../utils/logger");
const dbAdapters_1 = require("../core/dbAdapters");
const schemaParsers_1 = require("./schemaParsers");
class ContextManager {
    constructor(schemaState, extensionContext, statusBarItem) {
        this.schemaState = schemaState;
        this.extensionContext = extensionContext;
        this.logger = logger_1.Logger.getInstance();
        this.isFetching = false;
        // Debounce timer for auto-update on document change
        this.debounceTimer = null;
        this.DEBOUNCE_MS = 500;
        // Timeouts for live DB fetch
        this.CONNECT_TIMEOUT_MS = 5000;
        this.EXTRACT_TIMEOUT_MS = 30000;
        // Injected status bar item (from extension.ts)
        this.statusBarItem = null;
        if (statusBarItem) {
            this.statusBarItem = statusBarItem;
        }
        this.registerListeners();
    }
    // ──────────────────────────────────────────────
    // Public API
    // ──────────────────────────────────────────────
    /**
     * Scans the entire workspace for schema definitions (migrations, ORM models,
     * SQL files, Prisma schemas) and optionally merges with a live DB schema.
     */
    async fetchFromCodebase() {
        if (this.isFetching) {
            this.logger.info('ContextManager: fetch already in progress, skipping.');
            return;
        }
        this.isFetching = true;
        this.setStatus('scanning');
        try {
            this.logger.info('ContextManager: starting codebase scan');
            const [codebase, liveResult] = await Promise.all([
                this.scanCodebase(),
                this.fetchLiveSchema(),
            ]);
            codebase.source = 'codebase';
            const finalSchema = liveResult.schema
                ? (0, schemaParsers_1.mergeSchemas)(liveResult.schema, codebase)
                : codebase;
            await this.schemaState.updateSchema(finalSchema);
            const count = Object.keys(finalSchema.tables).length;
            this.logger.info(`ContextManager: schema updated — ${count} tables`);
            if (liveResult.schema) {
                this.setStatus('ready', { count, source: 'live' });
            }
            else if (liveResult.error) {
                this.setStatus('degraded', { count, reason: liveResult.error });
            }
            else {
                this.setStatus('ready', { count, source: 'codebase' });
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error('ContextManager: fetch failed', err);
            this.setStatus('error', { message });
        }
        finally {
            this.isFetching = false;
        }
    }
    // ──────────────────────────────────────────────
    // Status Bar
    // ──────────────────────────────────────────────
    setStatus(state, detail) {
        if (!this.statusBarItem) {
            return;
        }
        const item = this.statusBarItem;
        try {
            switch (state) {
                case 'idle':
                    item.text = '$(database) DB-Scope';
                    item.tooltip = 'DB-Scope: Click to open dashboard';
                    item.command = 'dbscope.openDashboard';
                    item.backgroundColor = undefined;
                    break;
                case 'scanning':
                    item.text = '$(sync~spin) DB-Scope: Scanning…';
                    item.tooltip = 'DB-Scope: scanning workspace for schema context';
                    item.command = undefined;
                    item.backgroundColor = undefined;
                    break;
                case 'ready': {
                    const n = detail?.count ?? 0;
                    const src = detail?.source ?? 'codebase';
                    item.text = `$(database) DB-Scope: ${n} tables`;
                    item.tooltip = src === 'live'
                        ? `DB-Scope: ${n} tables from live database. Click to open dashboard`
                        : `DB-Scope: ${n} tables from codebase scan. Click to open dashboard`;
                    item.command = 'dbscope.openDashboard';
                    item.backgroundColor = undefined;
                    break;
                }
                case 'degraded': {
                    const n = detail?.count ?? 0;
                    const reason = detail?.reason ?? 'DB unreachable';
                    item.text = `$(warning) DB-Scope: ${n} tables (offline)`;
                    item.tooltip = `DB-Scope: database unreachable (${reason}) — using codebase scan. Click to retry`;
                    item.command = 'dbscope.fetchContext';
                    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                    break;
                }
                case 'error': {
                    const msg = detail?.message ?? 'Unknown error';
                    item.text = '$(error) DB-Scope: fetch failed';
                    item.tooltip = `DB-Scope: ${msg}. Click to retry`;
                    item.command = 'dbscope.fetchContext';
                    item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                    break;
                }
            }
        }
        catch {
            // Status bar may have been disposed
        }
    }
    // ──────────────────────────────────────────────
    // Live DB Fetch
    // ──────────────────────────────────────────────
    async fetchLiveSchema() {
        const cfg = vscode.workspace.getConfiguration('dbscope');
        const connectionString = (cfg.get('connectionString') ?? '').trim();
        const dbType = (cfg.get('dbType') ?? 'postgresql');
        if (!connectionString) {
            this.logger.info('ContextManager: no dbscope.connectionString — skipping live fetch');
            return { schema: null };
        }
        // Redact password in log messages
        const safeCs = connectionString.replace(/:\/\/[^@]*@/, '://***@');
        this.logger.info(`ContextManager: connecting to ${dbType} at ${safeCs}`);
        const adapter = (0, dbAdapters_1.createAdapter)({ dbType, connectionString });
        try {
            const ok = await this.withTimeout(adapter.testConnection(), this.CONNECT_TIMEOUT_MS, 'testConnection');
            if (!ok) {
                this.logger.warn(`ContextManager: ${dbType} connection test failed`);
                return { schema: null, error: `${dbType} unreachable` };
            }
            const schema = await this.withTimeout(adapter.extractSchema(vscode.workspace.name ?? 'unknown'), this.EXTRACT_TIMEOUT_MS, 'extractSchema');
            schema.source = 'live';
            return { schema };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(`ContextManager: live fetch failed — ${msg}`);
            return { schema: null, error: msg };
        }
        finally {
            await adapter.disconnect().catch(() => { });
        }
    }
    withTimeout(promise, ms, label) {
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }
    // ──────────────────────────────────────────────
    // Codebase Scanner
    // ──────────────────────────────────────────────
    async scanCodebase() {
        const tables = {};
        const config = vscode.workspace.getConfiguration('dbscope');
        // 1. Scan SQL migration files (sorted numerically so 0002 applies before 0010)
        const sqlFiles = (await vscode.workspace.findFiles('**/*.sql', '{**/node_modules/**,**/out/**,**/dist/**}', 300)).map(f => f.fsPath).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        for (const p of sqlFiles) {
            try {
                const text = await this.readSafe(p);
                if (text) {
                    (0, schemaParsers_1.mergeInto)(tables, (0, schemaParsers_1.parseSqlScript)(text));
                }
            }
            catch { /* skip unreadable files */ }
        }
        // 2. Scan Prisma schema files
        const prismaFiles = await vscode.workspace.findFiles('**/schema.prisma', '{**/node_modules/**,**/out/**}', 5);
        for (const file of prismaFiles) {
            try {
                const text = await this.readSafe(file.fsPath);
                if (text) {
                    (0, schemaParsers_1.mergeInto)(tables, (0, schemaParsers_1.parsePrismaSchema)(text));
                }
            }
            catch { /* skip */ }
        }
        // 3. Scan ORM model files
        const modelFileUris = await Promise.all([
            vscode.workspace.findFiles('**/{models,entities}/**/*.{ts,js,py}', '{**/node_modules/**,**/out/**}', 100),
            vscode.workspace.findFiles('**/*.entity.ts', '{**/node_modules/**,**/out/**}', 50),
            vscode.workspace.findFiles('**/models.py', '{**/node_modules/**,**/out/**}', 30),
        ]);
        const modelFiles = [...new Set(modelFileUris.flat().map(f => f.fsPath))];
        // Two-pass for FK resolution: pass 1 collect entity table maps
        const entityTables = {};
        const djangoModelMap = {};
        for (const p of modelFiles) {
            try {
                const text = await this.readSafe(p);
                if (!text || text.length > 512 * 1024) {
                    continue;
                }
                if (p.endsWith('.py') && /models\.Model|from django\.db import models/.test(text)) {
                    // Collect Django class → table map
                    const partial = (0, schemaParsers_1.parseDjangoModels)(text);
                    Object.assign(djangoModelMap, partial);
                }
                else if (/\.(ts|js)$/.test(p) && /@Entity\b/.test(text)) {
                    // Collect TypeORM entity → table map
                    const ENTITY_RE = /@Entity\s*(?:\(([\s\S]*?)\))?\s*\n?\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g;
                    let em;
                    while ((em = ENTITY_RE.exec(text)) !== null) {
                        const args = em[1] ?? '';
                        const cls = em[2];
                        const nameM = /^['"]([^'"]+)['"]/.exec(args.trim()) ?? /name\s*:\s*['"]([^'"]+)['"]/.exec(args);
                        // Lazy import of helpers to avoid circular dep
                        const { snakeCase, pluralize } = await Promise.resolve().then(() => __importStar(require('./schemaParsers')));
                        entityTables[cls] = nameM ? nameM[1] : pluralize(snakeCase(cls));
                    }
                }
            }
            catch { /* skip */ }
        }
        // Pass 2: full parse with entity maps
        for (const p of modelFiles) {
            try {
                const text = await this.readSafe(p);
                if (!text || text.length > 512 * 1024) {
                    continue;
                }
                if (p.endsWith('.py') && /models\.Model|from django\.db import models/.test(text)) {
                    (0, schemaParsers_1.mergeInto)(tables, (0, schemaParsers_1.parseDjangoModels)(text, djangoModelMap));
                }
                else if (/\.(ts|js)$/.test(p) && /@Entity\b/.test(text)) {
                    (0, schemaParsers_1.mergeInto)(tables, (0, schemaParsers_1.parseTypeOrmEntities)(text, entityTables));
                }
            }
            catch { /* skip */ }
        }
        return {
            dbType: (config.get('dbType') ?? 'postgresql'),
            databaseName: vscode.workspace.name ?? 'unknown',
            tables,
            extractedAt: Date.now(),
        };
    }
    async readSafe(fsPath) {
        try {
            const uri = vscode.Uri.file(fsPath);
            const doc = await vscode.workspace.openTextDocument(uri);
            return doc.getText();
        }
        catch {
            return null;
        }
    }
    // ──────────────────────────────────────────────
    // Auto-update listeners
    // ──────────────────────────────────────────────
    registerListeners() {
        // Refresh on save of any SQL/migration/prisma file
        vscode.workspace.onDidSaveTextDocument(doc => {
            const ext = path.extname(doc.fileName).toLowerCase();
            if (['.sql', '.prisma'].includes(ext) || doc.fileName.includes('migration')) {
                this.debounce();
            }
        }, null, this.extensionContext.subscriptions);
        // Debounced update when user writes SQL
        vscode.workspace.onDidChangeTextDocument(evt => {
            const lang = evt.document.languageId;
            if (lang === 'sql' || evt.document.fileName.endsWith('.sql')) {
                this.debounce();
            }
        }, null, this.extensionContext.subscriptions);
        // Re-fetch when connection config changes
        vscode.workspace.onDidChangeConfiguration(evt => {
            if (evt.affectsConfiguration('dbscope.connectionString') ||
                evt.affectsConfiguration('dbscope.dbType')) {
                this.debounce();
            }
        }, null, this.extensionContext.subscriptions);
    }
    debounce() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => this.fetchFromCodebase(), this.DEBOUNCE_MS);
    }
}
exports.ContextManager = ContextManager;
//# sourceMappingURL=contextManager.js.map