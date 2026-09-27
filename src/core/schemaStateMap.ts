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

  getRelevantSchema(tableNames: string[]): DatabaseSchema | null {
    if (!this.currentSchema) return null;
    const relevantTables = new Set(tableNames);
    const addedTables = new Set<string>();

    for (const tableName of tableNames) {
      const table = this.currentSchema.tables[tableName];
      if (table) {
        for (const col of Object.values(table.columns)) {
          if (col.isForeignKey && col.referencesTable) {
            addedTables.add(col.referencesTable);
          }
        }
      }
    }

    const allRelevant = new Set([...relevantTables, ...addedTables]);
    const newSchema: DatabaseSchema = { ...this.currentSchema, tables: {} };

    for (const tableName of allRelevant) {
      if (this.currentSchema.tables[tableName]) {
        newSchema.tables[tableName] = this.currentSchema.tables[tableName];
      }
    }

    return newSchema;
  }

  getSchemaSummary(): { tableCount: number; columnCount: number; lastUpdated: number | null } {
    if (!this.currentSchema) {
      return { tableCount: 0, columnCount: 0, lastUpdated: null };
    }
    
    let columnCount = 0;
    const tableNames = Object.keys(this.currentSchema.tables);
    for (const name of tableNames) {
      columnCount += Object.keys(this.currentSchema.tables[name].columns).length;
    }
    
    const lastUpdated = this.history.length > 0 ? this.history[this.history.length - 1].timestamp : null;
    
    return {
      tableCount: tableNames.length,
      columnCount,
      lastUpdated
    };
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
