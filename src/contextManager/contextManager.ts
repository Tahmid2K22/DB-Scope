// src/contextManager/contextManager.ts
// Member 2 — Context Manager
// Automatically fetches database schema context from the codebase.
// Updates context whenever a SQL query is written or a file is saved.
// No manual refresh needed.

import * as vscode from 'vscode';
import * as path from 'path';
import { SchemaStateMap } from '../core/schemaStateMap';
import { DatabaseSchema, TableDefinition, ColumnDefinition } from '../core/types';
import { Logger } from '../utils/logger';

export class ContextManager {
  private readonly logger = Logger.getInstance();
  private isFetching = false;

  // Debounce timer for auto-update on document change
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 500;

  constructor(
    private readonly schemaState: SchemaStateMap,
    private readonly extensionContext: vscode.ExtensionContext
  ) {
    this.registerListeners();
  }

  // ──────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────

  /**
   * Scans the entire workspace for schema definitions (migrations, ORM models,
   * SQL files, Prisma schemas) and builds/updates the SchemaStateMap.
   */
  async fetchFromCodebase(): Promise<void> {
    if (this.isFetching) {
      this.logger.info('ContextManager: fetch already in progress, skipping.');
      return;
    }
    this.isFetching = true;
    this.updateStatusBar('$(sync~spin) DB-Scope: Fetching context...');

    try {
      this.logger.info('ContextManager: starting codebase scan');
      const schema = await this.scanCodebase();
      await this.schemaState.updateSchema(schema);
      this.logger.info(`ContextManager: schema updated — ${Object.keys(schema.tables).length} tables found`);
      this.updateStatusBar('$(database) DB-Scope: Ready');
    } catch (err) {
      this.logger.error('ContextManager: fetch failed', err);
      this.updateStatusBar('$(warning) DB-Scope: Context fetch failed');
    } finally {
      this.isFetching = false;
    }
  }

  // ──────────────────────────────────────────────
  // Codebase Scanner
  // ──────────────────────────────────────────────

  private async scanCodebase(): Promise<DatabaseSchema> {
    const tables: Record<string, TableDefinition> = {};

    // 1. Scan SQL migration files
    const sqlFiles = await vscode.workspace.findFiles('**/*.sql', '**/node_modules/**', 100);
    for (const file of sqlFiles) {
      const text = (await vscode.workspace.openTextDocument(file)).getText();
      Object.assign(tables, this.parseSqlFile(text));
    }

    // 2. Scan Prisma schema files
    const prismaFiles = await vscode.workspace.findFiles('**/schema.prisma', '**/node_modules/**', 5);
    for (const file of prismaFiles) {
      const text = (await vscode.workspace.openTextDocument(file)).getText();
      Object.assign(tables, this.parsePrismaSchema(text));
    }

    // 3. Scan TypeORM / Sequelize / Django model files
    const modelFiles = await vscode.workspace.findFiles(
      '**/{models,entities,migrations}/**/*.{ts,js,py}',
      '**/node_modules/**',
      100
    );
    for (const file of modelFiles) {
      const text = (await vscode.workspace.openTextDocument(file)).getText();
      const lang = file.fsPath.endsWith('.py') ? 'python' : 'typescript';
      Object.assign(tables, this.parseModelFile(text, lang));
    }

    const config = vscode.workspace.getConfiguration('dbscope');
    return {
      dbType: (config.get<string>('dbType') ?? 'postgresql') as DatabaseSchema['dbType'],
      databaseName: vscode.workspace.name ?? 'unknown',
      tables,
      extractedAt: Date.now(),
    };
  }

  // ──────────────────────────────────────────────
  // Parsers
  // ──────────────────────────────────────────────

  private parseSqlFile(sql: string): Record<string, TableDefinition> {
    const tables: Record<string, TableDefinition> = {};
    // Match CREATE TABLE statements
    const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(([^;]+)\)/gis;
    let match: RegExpExecArray | null;

    while ((match = createTableRegex.exec(sql)) !== null) {
      const tableName = match[1];
      const columnDefs = match[2];
      const columns = this.parseColumnDefinitions(columnDefs);
      tables[tableName] = { name: tableName, columns, indexes: [] };
    }

    return tables;
  }

  private parseColumnDefinitions(defs: string): Record<string, ColumnDefinition> {
    const columns: Record<string, ColumnDefinition> = {};
    // Split by comma (avoiding commas inside parentheses)
    const lines = this.splitColumnDefs(defs);

    for (const line of lines) {
      const trimmed = line.trim();
      // Skip constraint lines (PRIMARY KEY, FOREIGN KEY, UNIQUE, CHECK, INDEX)
      if (/^\s*(PRIMARY|FOREIGN|UNIQUE|CHECK|INDEX|CONSTRAINT|KEY)/i.test(trimmed)) {
        continue;
      }
      const colMatch = /["`]?(\w+)["`]?\s+(\w+(?:\([^)]+\))?)/i.exec(trimmed);
      if (!colMatch) { continue; }

      const colName = colMatch[1];
      const colType = colMatch[2];
      const upper = trimmed.toUpperCase();

      columns[colName] = {
        name: colName,
        type: colType,
        nullable: !upper.includes('NOT NULL'),
        isPrimaryKey: upper.includes('PRIMARY KEY'),
        isForeignKey: upper.includes('REFERENCES'),
        referencesTable: this.extractReferences(trimmed)?.table,
        referencesColumn: this.extractReferences(trimmed)?.column,
      };
    }

    return columns;
  }

  private splitColumnDefs(defs: string): string[] {
    const result: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of defs) {
      if (ch === '(') { depth++; current += ch; }
      else if (ch === ')') { depth--; current += ch; }
      else if (ch === ',' && depth === 0) { result.push(current); current = ''; }
      else { current += ch; }
    }
    if (current.trim()) { result.push(current); }
    return result;
  }

  private extractReferences(def: string): { table: string; column: string } | null {
    const m = /REFERENCES\s+["`]?(\w+)["`]?\s*\(["`]?(\w+)["`]?\)/i.exec(def);
    return m ? { table: m[1], column: m[2] } : null;
  }

  private parsePrismaSchema(content: string): Record<string, TableDefinition> {
    const tables: Record<string, TableDefinition> = {};
    const modelRegex = /model\s+(\w+)\s*\{([^}]+)\}/gs;
    let match: RegExpExecArray | null;

    while ((match = modelRegex.exec(content)) !== null) {
      const modelName = match[1].toLowerCase() + 's'; // Prisma model → table name convention
      const body = match[2];
      const columns: Record<string, ColumnDefinition> = {};

      for (const line of body.split('\n')) {
        const fieldMatch = /^\s+(\w+)\s+(\w+)(\?)?\s*/.exec(line);
        if (!fieldMatch) { continue; }
        columns[fieldMatch[1]] = {
          name: fieldMatch[1],
          type: fieldMatch[2],
          nullable: !!fieldMatch[3],
          isPrimaryKey: line.includes('@id'),
          isForeignKey: false,
        };
      }
      tables[modelName] = { name: modelName, columns, indexes: [] };
    }

    return tables;
  }

  private parseModelFile(content: string, lang: 'typescript' | 'python'): Record<string, TableDefinition> {
    const tables: Record<string, TableDefinition> = {};

    if (lang === 'typescript') {
      // TypeORM: @Entity('table_name') or @Entity()
      const entityMatch = /@Entity\(['"]?(\w+)?['"]?\)/.exec(content);
      if (entityMatch) {
        const name = entityMatch[1] ?? 'unknown';
        const columns: Record<string, ColumnDefinition> = {};
        // @Column() fields
        const colRegex = /@Column[^)]*\)\s+(\w+):\s+(\w+)/g;
        let m: RegExpExecArray | null;
        while ((m = colRegex.exec(content)) !== null) {
          columns[m[1]] = { name: m[1], type: m[2], nullable: false, isPrimaryKey: false, isForeignKey: false };
        }
        tables[name] = { name, columns, indexes: [] };
      }
    }

    if (lang === 'python') {
      // Django models: class ModelName(models.Model)
      const classRegex = /class\s+(\w+)\s*\(\s*models\.Model\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = classRegex.exec(content)) !== null) {
        const name = m[1].toLowerCase() + 's';
        tables[name] = { name, columns: {}, indexes: [] };
      }
    }

    return tables;
  }

  // ──────────────────────────────────────────────
  // Auto-update listeners
  // ──────────────────────────────────────────────

  private registerListeners(): void {
    // Refresh on save of any SQL/migration file
    vscode.workspace.onDidSaveTextDocument(doc => {
      const ext = path.extname(doc.fileName).toLowerCase();
      if (['.sql', '.prisma'].includes(ext) || doc.fileName.includes('migration')) {
        this.debounce();
      }
    }, null, this.extensionContext.subscriptions);

    // Debounced update when user writes SQL in any file
    vscode.workspace.onDidChangeTextDocument(evt => {
      const lang = evt.document.languageId;
      if (lang === 'sql' || evt.document.fileName.endsWith('.sql')) {
        this.debounce();
      }
    }, null, this.extensionContext.subscriptions);
  }

  private debounce(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
    this.debounceTimer = setTimeout(() => this.fetchFromCodebase(), this.DEBOUNCE_MS);
  }

  private statusBarItem: vscode.StatusBarItem | null = null;

  private updateStatusBar(text: string): void {
    // The extension.ts status bar will reflect this via the command tooltip.
    // Emit to output channel for now; a shared status bar can be injected later.
    this.logger.info(text);
  }
}
