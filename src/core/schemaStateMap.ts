// src/core/schemaStateMap.ts — Living JSON snapshot of database schema across time
import * as vscode from 'vscode';
import { DatabaseSchema, SchemaSnapshot, TableDefinition } from './types';
import { Logger } from '../utils/logger';

const SCHEMA_STORAGE_KEY = 'dbscope.schemaHistory';

export class SchemaStateMap {
  private currentSchema: DatabaseSchema | null = null;
  private history: SchemaSnapshot[] = [];
  private readonly logger = Logger.getInstance();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.loadFromStorage();
  }

  // ──────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────

  async getCurrentSchema(): Promise<DatabaseSchema | null> {
    return this.currentSchema;
  }

  async updateSchema(schema: DatabaseSchema): Promise<void> {
    if (this.currentSchema) {
      // Snapshot old state before replacing
      const snapshot: SchemaSnapshot = {
        timestamp: Date.now(),
        schema: this.currentSchema,
        changeCount: this.diffCount(this.currentSchema, schema),
      };
      this.history.push(snapshot);
      // Keep last 50 snapshots
      if (this.history.length > 50) {
        this.history.shift();
      }
    }
    this.currentSchema = schema;
    await this.persistToStorage();
    this.logger.info(`Schema updated: ${Object.keys(schema.tables).length} tables`);
  }

  async getHistory(): Promise<SchemaSnapshot[]> {
    return [...this.history];
  }

  getTable(tableName: string): TableDefinition | null {
    return this.currentSchema?.tables[tableName] ?? null;
  }

  getAllTableNames(): string[] {
    return this.currentSchema ? Object.keys(this.currentSchema.tables) : [];
  }

  // ──────────────────────────────────────────────
  // Storage
  // ──────────────────────────────────────────────

  private loadFromStorage(): void {
    try {
      const stored = this.context.workspaceState.get<{ current: DatabaseSchema; history: SchemaSnapshot[] }>(SCHEMA_STORAGE_KEY);
      if (stored) {
        this.currentSchema = stored.current;
        this.history = stored.history ?? [];
        this.logger.info(`Loaded schema from storage: ${Object.keys(stored.current?.tables ?? {}).length} tables`);
      }
    } catch (err) {
      this.logger.warn('Failed to load schema from storage, starting fresh.');
    }
  }

  private async persistToStorage(): Promise<void> {
    await this.context.workspaceState.update(SCHEMA_STORAGE_KEY, {
      current: this.currentSchema,
      history: this.history,
    });
  }

  private diffCount(old: DatabaseSchema, next: DatabaseSchema): number {
    let count = 0;
    const allTables = new Set([...Object.keys(old.tables), ...Object.keys(next.tables)]);
    for (const table of allTables) {
      if (!old.tables[table]) { count++; continue; }
      if (!next.tables[table]) { count++; continue; }
      const oldCols = Object.keys(old.tables[table].columns).length;
      const newCols = Object.keys(next.tables[table].columns).length;
      if (oldCols !== newCols) count += Math.abs(oldCols - newCols);
    }
    return count;
  }
}
