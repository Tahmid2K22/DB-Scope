// src/core/dbAdapters.ts — Unified database adapter interface
// Supports PostgreSQL, MySQL, and Oracle through a common API.

import { DatabaseSchema, TableDefinition, ColumnDefinition } from './types';
import { Logger } from '../utils/logger';

export interface DbAdapter {
  testConnection(): Promise<boolean>;
  extractSchema(databaseName: string): Promise<DatabaseSchema>;
  disconnect(): Promise<void>;
}

export type DbConfig = {
  dbType: 'postgresql' | 'mysql' | 'oracle';
  connectionString: string;
};

/**
 * Factory function — returns the correct adapter based on dbType.
 * Actual DB drivers (pg, mysql2) are loaded lazily so the extension
 * doesn't crash when they're not installed.
 */
export function createAdapter(config: DbConfig): DbAdapter {
  switch (config.dbType) {
    case 'postgresql':
      return new PostgresAdapter(config.connectionString);
    case 'mysql':
      return new MySqlAdapter(config.connectionString);
    case 'oracle':
      return new OracleAdapter(config.connectionString);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// PostgreSQL Adapter
// ──────────────────────────────────────────────────────────────────────────────

class PostgresAdapter implements DbAdapter {
  private client: import('pg').Client | null = null;
  private readonly logger = Logger.getInstance();

  constructor(private readonly connectionString: string) {}

  async testConnection(): Promise<boolean> {
    try {
      const { Client } = await import('pg');
      const client = new Client({ connectionString: this.connectionString });
      await client.connect();
      await client.end();
      return true;
    } catch {
      return false;
    }
  }

  async extractSchema(databaseName: string): Promise<DatabaseSchema> {
    const { Client } = await import('pg');
    this.client = new Client({ connectionString: this.connectionString });
    await this.client.connect();
    this.logger.info('PostgresAdapter: connected, extracting schema...');

    try {
      const tables = await this.fetchTables();
      return {
        dbType: 'postgresql',
        databaseName,
        tables,
        extractedAt: Date.now(),
      };
    } finally {
      await this.client.end();
      this.client = null;
    }
  }

  private async fetchTables(): Promise<Record<string, TableDefinition>> {
    if (!this.client) { throw new Error('Not connected'); }
    const tables: Record<string, TableDefinition> = {};

    // Get table list
    const tableRes = await this.client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`
    );

    for (const row of tableRes.rows) {
      const tableName = row.table_name;
      const columns = await this.fetchColumns(tableName);
      tables[tableName] = { name: tableName, columns, indexes: [] };
    }

    return tables;
  }

  private async fetchColumns(tableName: string): Promise<Record<string, ColumnDefinition>> {
    if (!this.client) { throw new Error('Not connected'); }
    const columns: Record<string, ColumnDefinition> = {};

    const colRes = await this.client.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [tableName]
    );

    // Get primary key columns
    const pkRes = await this.client.query<{ column_name: string }>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
       WHERE tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'`,
      [tableName]
    );
    const pkCols = new Set(pkRes.rows.map(r => r.column_name));

    // Get foreign key columns
    const fkRes = await this.client.query<{
      column_name: string;
      foreign_table: string;
      foreign_column: string;
    }>(
      `SELECT kcu.column_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name
       WHERE tc.table_name = $1 AND tc.constraint_type = 'FOREIGN KEY'`,
      [tableName]
    );
    const fkMap = new Map(fkRes.rows.map(r => [r.column_name, r]));

    for (const col of colRes.rows) {
      const fk = fkMap.get(col.column_name);
      columns[col.column_name] = {
        name: col.column_name,
        type: col.data_type,
        nullable: col.is_nullable === 'YES',
        isPrimaryKey: pkCols.has(col.column_name),
        isForeignKey: !!fk,
        referencesTable: fk?.foreign_table,
        referencesColumn: fk?.foreign_column,
        defaultValue: col.column_default ?? undefined,
      };
    }

    return columns;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// MySQL Adapter
// ──────────────────────────────────────────────────────────────────────────────

class MySqlAdapter implements DbAdapter {
  private readonly logger = Logger.getInstance();

  constructor(private readonly connectionString: string) {}

  async testConnection(): Promise<boolean> {
    try {
      const mysql = await import('mysql2/promise');
      const conn = await mysql.createConnection(this.connectionString);
      await conn.end();
      return true;
    } catch {
      return false;
    }
  }

  async extractSchema(databaseName: string): Promise<DatabaseSchema> {
    const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection(this.connectionString);
    this.logger.info('MySqlAdapter: connected, extracting schema...');

    try {
      const tables: Record<string, TableDefinition> = {};
      const [tableRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
        `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`
      );

      for (const row of tableRows) {
        const tableName = row['TABLE_NAME'] as string;
        const [colRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
          `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
           ORDER BY ORDINAL_POSITION`,
          [tableName]
        );

        const columns: Record<string, ColumnDefinition> = {};
        for (const col of colRows) {
          columns[col['COLUMN_NAME']] = {
            name: col['COLUMN_NAME'],
            type: col['DATA_TYPE'],
            nullable: col['IS_NULLABLE'] === 'YES',
            isPrimaryKey: col['COLUMN_KEY'] === 'PRI',
            isForeignKey: col['COLUMN_KEY'] === 'MUL',
            defaultValue: col['COLUMN_DEFAULT'] ?? undefined,
          };
        }
        tables[tableName] = { name: tableName, columns, indexes: [] };
      }

      return { dbType: 'mysql', databaseName, tables, extractedAt: Date.now() };
    } finally {
      await conn.end();
    }
  }

  async disconnect(): Promise<void> {}
}

// ──────────────────────────────────────────────────────────────────────────────
// Oracle Adapter (stub — requires oracledb native driver)
// ──────────────────────────────────────────────────────────────────────────────

class OracleAdapter implements DbAdapter {
  private readonly logger = Logger.getInstance();

  constructor(private readonly connectionString: string) {}

  async testConnection(): Promise<boolean> {
    this.logger.warn('OracleAdapter: oracledb native driver required — see README for setup');
    return false;
  }

  async extractSchema(databaseName: string): Promise<DatabaseSchema> {
    // Oracle requires the native oracledb package which needs Oracle Instant Client.
    // Provide a schema skeleton; teams can extend with the oracledb package.
    this.logger.warn('OracleAdapter: extractSchema stub — install oracledb and implement fetchTables()');
    return {
      dbType: 'oracle',
      databaseName,
      tables: {},
      extractedAt: Date.now(),
    };
  }

  async disconnect(): Promise<void> {}
}
