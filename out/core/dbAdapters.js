"use strict";
// src/core/dbAdapters.ts — Unified database adapter interface
// Supports PostgreSQL, MySQL, and Oracle through a common API.
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
exports.createAdapter = createAdapter;
const logger_1 = require("../utils/logger");
/**
 * Factory function — returns the correct adapter based on dbType.
 * Actual DB drivers (pg, mysql2) are loaded lazily so the extension
 * doesn't crash when they're not installed.
 */
function createAdapter(config) {
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
class PostgresAdapter {
    constructor(connectionString) {
        this.connectionString = connectionString;
        this.client = null;
        this.logger = logger_1.Logger.getInstance();
    }
    async testConnection() {
        try {
            const { Client } = await Promise.resolve().then(() => __importStar(require('pg')));
            const client = new Client({ connectionString: this.connectionString });
            await client.connect();
            await client.end();
            return true;
        }
        catch {
            return false;
        }
    }
    async extractSchema(databaseName) {
        const { Client } = await Promise.resolve().then(() => __importStar(require('pg')));
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
        }
        finally {
            await this.client.end();
            this.client = null;
        }
    }
    async extractTablesSchema(tableNames) {
        if (tableNames.length === 0) {
            return {};
        }
        const { Client } = await Promise.resolve().then(() => __importStar(require('pg')));
        const client = new Client({ connectionString: this.connectionString });
        await client.connect();
        try {
            const tables = {};
            // Fetch row counts
            const countRes = await client.query(`SELECT relname, reltuples::bigint AS row_count FROM pg_class WHERE relname = ANY($1)`, [tableNames]);
            const rowCounts = new Map(countRes.rows.map(r => [r.relname, Number(r.row_count)]));
            for (const tableName of tableNames) {
                const columns = await this.fetchColumns(tableName, client);
                tables[tableName] = {
                    name: tableName,
                    columns,
                    indexes: [],
                    rowCount: rowCounts.get(tableName)
                };
            }
            return tables;
        }
        finally {
            await client.end();
        }
    }
    async fetchTables() {
        if (!this.client) {
            throw new Error('Not connected');
        }
        const tables = {};
        // Get table list
        const tableRes = await this.client.query(`SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`);
        for (const row of tableRes.rows) {
            const tableName = row.table_name;
            const columns = await this.fetchColumns(tableName);
            tables[tableName] = { name: tableName, columns, indexes: [] };
        }
        return tables;
    }
    async fetchColumns(tableName, client) {
        const c = client ?? this.client;
        if (!c) {
            throw new Error('Not connected');
        }
        const columns = {};
        const colRes = await c.query(`SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`, [tableName]);
        // Get primary key columns
        const pkRes = await c.query(`SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
       WHERE tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'`, [tableName]);
        const pkCols = new Set(pkRes.rows.map(r => r.column_name));
        // Get foreign key columns
        const fkRes = await c.query(`SELECT kcu.column_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name
       WHERE tc.table_name = $1 AND tc.constraint_type = 'FOREIGN KEY'`, [tableName]);
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
    async disconnect() {
        if (this.client) {
            await this.client.end();
            this.client = null;
        }
    }
}
// ──────────────────────────────────────────────────────────────────────────────
// MySQL Adapter
// ──────────────────────────────────────────────────────────────────────────────
class MySqlAdapter {
    constructor(connectionString) {
        this.connectionString = connectionString;
        this.logger = logger_1.Logger.getInstance();
    }
    async testConnection() {
        try {
            const mysql = await Promise.resolve().then(() => __importStar(require('mysql2/promise')));
            const conn = await mysql.createConnection(this.connectionString);
            await conn.end();
            return true;
        }
        catch {
            return false;
        }
    }
    async extractSchema(databaseName) {
        const mysql = await Promise.resolve().then(() => __importStar(require('mysql2/promise')));
        const conn = await mysql.createConnection(this.connectionString);
        this.logger.info('MySqlAdapter: connected, extracting schema...');
        try {
            const tables = {};
            const [tableRows] = await conn.execute(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`);
            for (const row of tableRows) {
                const tableName = row['TABLE_NAME'];
                const [colRows] = await conn.execute(`SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
           ORDER BY ORDINAL_POSITION`, [tableName]);
                const columns = {};
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
        }
        finally {
            await conn.end();
        }
    }
    async extractTablesSchema(tableNames) {
        if (tableNames.length === 0) {
            return {};
        }
        const mysql = await Promise.resolve().then(() => __importStar(require('mysql2/promise')));
        const conn = await mysql.createConnection(this.connectionString);
        try {
            const tables = {};
            for (const tableName of tableNames) {
                // Fetch row count
                const [tableStats] = await conn.execute(`SELECT TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [tableName]);
                const rowCount = tableStats.length > 0 ? Number(tableStats[0]['TABLE_ROWS']) : undefined;
                // Fetch columns
                const [colRows] = await conn.execute(`SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
           ORDER BY ORDINAL_POSITION`, [tableName]);
                const columns = {};
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
                tables[tableName] = { name: tableName, columns, indexes: [], rowCount };
            }
            return tables;
        }
        finally {
            await conn.end();
        }
    }
    async disconnect() { }
}
// ──────────────────────────────────────────────────────────────────────────────
// Oracle Adapter (stub — requires oracledb native driver)
// ──────────────────────────────────────────────────────────────────────────────
class OracleAdapter {
    constructor(connectionString) {
        this.connectionString = connectionString;
        this.logger = logger_1.Logger.getInstance();
    }
    async testConnection() {
        this.logger.warn('OracleAdapter: oracledb native driver required — see README for setup');
        return false;
    }
    async extractSchema(databaseName) {
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
    async extractTablesSchema(tableNames) {
        this.logger.warn('OracleAdapter: extractTablesSchema stub');
        return {};
    }
    async disconnect() { }
}
//# sourceMappingURL=dbAdapters.js.map