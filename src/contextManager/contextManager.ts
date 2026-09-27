// src/contextManager/contextManager.ts
// Member 2 — Context Manager
// Fetches database schema from codebase (SQL migrations, Prisma, Django, TypeORM)
// and optionally from a live database connection. Merges both sources.
// Updates context automatically on file save and exposes a rich status bar.

import * as vscode from 'vscode';
import * as path from 'path';
import { SchemaStateMap } from '../core/schemaStateMap';
import { DatabaseSchema } from '../core/types';
import { Logger } from '../utils/logger';
import { createAdapter } from '../core/dbAdapters';
import {
  MutableSchema,
  parseSqlScript,
  parsePrismaSchema,
  parseDjangoModels,
  parseTypeOrmEntities,
  mergeInto,
  mergeSchemas,
} from './schemaParsers';

type StatusState = 'idle' | 'scanning' | 'ready' | 'degraded' | 'error';
interface StatusDetail {
  count?: number;
  source?: 'live' | 'codebase';
  reason?: string;
  message?: string;
}

export class ContextManager {
  private readonly logger = Logger.getInstance();
  private isFetching = false;

  // Debounce timer for auto-update on document change
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 500;

  // Timeouts for live DB fetch
  private readonly CONNECT_TIMEOUT_MS = 5_000;
  private readonly EXTRACT_TIMEOUT_MS = 30_000;

  // Injected status bar item (from extension.ts)
  private statusBarItem: vscode.StatusBarItem | null = null;

  constructor(
    private readonly schemaState: SchemaStateMap,
    private readonly extensionContext: vscode.ExtensionContext,
    statusBarItem?: vscode.StatusBarItem
  ) {
    if (statusBarItem) { this.statusBarItem = statusBarItem; }
    this.registerListeners();
  }

  // ──────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────

  /**
   * Scans the entire workspace for schema definitions (migrations, ORM models,
   * SQL files, Prisma schemas) and optionally merges with a live DB schema.
   */
  async fetchFromCodebase(): Promise<void> {
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
        ? mergeSchemas(liveResult.schema, codebase)
        : codebase;

      await this.schemaState.updateSchema(finalSchema);
      const count = Object.keys(finalSchema.tables).length;
      this.logger.info(`ContextManager: schema updated — ${count} tables`);

      if (liveResult.schema) {
        this.setStatus('ready', { count, source: 'live' });
      } else if (liveResult.error) {
        this.setStatus('degraded', { count, reason: liveResult.error });
      } else {
        this.setStatus('ready', { count, source: 'codebase' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('ContextManager: fetch failed', err);
      this.setStatus('error', { message });
    } finally {
      this.isFetching = false;
    }
  }

  // ──────────────────────────────────────────────
  // Status Bar
  // ──────────────────────────────────────────────

  private setStatus(state: StatusState, detail?: StatusDetail): void {
    if (!this.statusBarItem) { return; }
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
    } catch {
      // Status bar may have been disposed
    }
  }

  // ──────────────────────────────────────────────
  // Live DB Fetch
  // ──────────────────────────────────────────────

  private async fetchLiveSchema(): Promise<{ schema: DatabaseSchema | null; error?: string }> {
    const cfg = vscode.workspace.getConfiguration('dbscope');
    const connectionString = (cfg.get<string>('connectionString') ?? '').trim();
    const dbType = (cfg.get<string>('dbType') ?? 'postgresql') as DatabaseSchema['dbType'];
    if (!connectionString) {
      this.logger.info('ContextManager: no dbscope.connectionString — skipping live fetch');
      return { schema: null };
    }

    // Redact password in log messages
    const safeCs = connectionString.replace(/:\/\/[^@]*@/, '://***@');
    this.logger.info(`ContextManager: connecting to ${dbType} at ${safeCs}`);

    const adapter = createAdapter({ dbType, connectionString });
    try {
      const ok = await this.withTimeout(adapter.testConnection(), this.CONNECT_TIMEOUT_MS, 'testConnection');
      if (!ok) {
        this.logger.warn(`ContextManager: ${dbType} connection test failed`);
        return { schema: null, error: `${dbType} unreachable` };
      }
      const schema = await this.withTimeout(
        adapter.extractSchema(vscode.workspace.name ?? 'unknown'),
        this.EXTRACT_TIMEOUT_MS,
        'extractSchema'
      );
      schema.source = 'live';
      return { schema };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`ContextManager: live fetch failed — ${msg}`);
      return { schema: null, error: msg };
    } finally {
      await adapter.disconnect().catch(() => { /* disconnect failure is harmless */ });
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
  }

  // ──────────────────────────────────────────────
  // Codebase Scanner
  // ──────────────────────────────────────────────

  private async scanCodebase(): Promise<DatabaseSchema> {
    const tables: MutableSchema = {};
    const config = vscode.workspace.getConfiguration('dbscope');

    // 1. Scan SQL migration files (sorted numerically so 0002 applies before 0010)
    const sqlFiles = (await vscode.workspace.findFiles(
      '**/*.sql',
      '{**/node_modules/**,**/out/**,**/dist/**}',
      300
    )).map(f => f.fsPath).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    for (const p of sqlFiles) {
      try {
        const text = await this.readSafe(p);
        if (text) { mergeInto(tables, parseSqlScript(text)); }
      } catch { /* skip unreadable files */ }
    }

    // 2. Scan Prisma schema files
    const prismaFiles = await vscode.workspace.findFiles(
      '**/schema.prisma',
      '{**/node_modules/**,**/out/**}',
      5
    );
    for (const file of prismaFiles) {
      try {
        const text = await this.readSafe(file.fsPath);
        if (text) { mergeInto(tables, parsePrismaSchema(text)); }
      } catch { /* skip */ }
    }

    // 3. Scan ORM model files
    const modelFileUris = await Promise.all([
      vscode.workspace.findFiles('**/{models,entities}/**/*.{ts,js,py}', '{**/node_modules/**,**/out/**}', 100),
      vscode.workspace.findFiles('**/*.entity.ts', '{**/node_modules/**,**/out/**}', 50),
      vscode.workspace.findFiles('**/models.py', '{**/node_modules/**,**/out/**}', 30),
    ]);
    const modelFiles = [...new Set(modelFileUris.flat().map(f => f.fsPath))];

    // Two-pass for FK resolution: pass 1 collect entity table maps
    const entityTables: Record<string, string> = {};
    const djangoModelMap: Record<string, string> = {};

    for (const p of modelFiles) {
      try {
        const text = await this.readSafe(p);
        if (!text || text.length > 512 * 1024) { continue; }
        if (p.endsWith('.py') && /models\.Model|from django\.db import models/.test(text)) {
          // Collect Django class → table map
          const partial = parseDjangoModels(text);
          Object.assign(djangoModelMap, partial);
        } else if (/\.(ts|js)$/.test(p) && /@Entity\b/.test(text)) {
          // Collect TypeORM entity → table map
          const ENTITY_RE = /@Entity\s*(?:\(([\s\S]*?)\))?\s*\n?\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g;
          let em: RegExpExecArray | null;
          while ((em = ENTITY_RE.exec(text)) !== null) {
            const args = em[1] ?? '';
            const cls = em[2];
            const nameM = /^['"]([^'"]+)['"]/.exec(args.trim()) ?? /name\s*:\s*['"]([^'"]+)['"]/.exec(args);
            // Lazy import of helpers to avoid circular dep
            const { snakeCase, pluralize } = await import('./schemaParsers');
            entityTables[cls] = nameM ? nameM[1] : pluralize(snakeCase(cls));
          }
        }
      } catch { /* skip */ }
    }

    // Pass 2: full parse with entity maps
    for (const p of modelFiles) {
      try {
        const text = await this.readSafe(p);
        if (!text || text.length > 512 * 1024) { continue; }
        if (p.endsWith('.py') && /models\.Model|from django\.db import models/.test(text)) {
          mergeInto(tables, parseDjangoModels(text, djangoModelMap));
        } else if (/\.(ts|js)$/.test(p) && /@Entity\b/.test(text)) {
          mergeInto(tables, parseTypeOrmEntities(text, entityTables));
        }
      } catch { /* skip */ }
    }

    return {
      dbType: (config.get<string>('dbType') ?? 'postgresql') as DatabaseSchema['dbType'],
      databaseName: vscode.workspace.name ?? 'unknown',
      tables,
      extractedAt: Date.now(),
    };
  }

  private async readSafe(fsPath: string): Promise<string | null> {
    try {
      const uri = vscode.Uri.file(fsPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      return doc.getText();
    } catch {
      return null;
    }
  }

  // ──────────────────────────────────────────────
  // Auto-update listeners
  // ──────────────────────────────────────────────

  private registerListeners(): void {
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

  private debounce(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
    this.debounceTimer = setTimeout(() => this.fetchFromCodebase(), this.DEBOUNCE_MS);
  }
}
