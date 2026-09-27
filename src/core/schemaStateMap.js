"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchemaStateMap = void 0;
const logger_1 = require("../utils/logger");
const SCHEMA_STORAGE_KEY = 'dbscope.schemaHistory';
class SchemaStateMap {
    constructor(context) {
        this.context = context;
        this.currentSchema = null;
        this.history = [];
        this.logger = logger_1.Logger.getInstance();
        this.loadFromStorage();
    }
    // ──────────────────────────────────────────────
    // Public API
    // ──────────────────────────────────────────────
    async getCurrentSchema() {
        return this.currentSchema;
    }
    async updateSchema(schema) {
        if (this.currentSchema) {
            // Snapshot old state before replacing
            const snapshot = {
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
    async getHistory() {
        return [...this.history];
    }
    getTable(tableName) {
        return this.currentSchema?.tables[tableName] ?? null;
    }
    getAllTableNames() {
        return this.currentSchema ? Object.keys(this.currentSchema.tables) : [];
    }
    // ──────────────────────────────────────────────
    // Storage
    // ──────────────────────────────────────────────
    loadFromStorage() {
        try {
            const stored = this.context.workspaceState.get(SCHEMA_STORAGE_KEY);
            if (stored) {
                this.currentSchema = stored.current;
                this.history = stored.history ?? [];
                this.logger.info(`Loaded schema from storage: ${Object.keys(stored.current?.tables ?? {}).length} tables`);
            }
        }
        catch (err) {
            this.logger.warn('Failed to load schema from storage, starting fresh.');
        }
    }
    async persistToStorage() {
        await this.context.workspaceState.update(SCHEMA_STORAGE_KEY, {
            current: this.currentSchema,
            history: this.history,
        });
    }
    diffCount(old, next) {
        let count = 0;
        const allTables = new Set([...Object.keys(old.tables), ...Object.keys(next.tables)]);
        for (const table of allTables) {
            if (!old.tables[table]) {
                count++;
                continue;
            }
            if (!next.tables[table]) {
                count++;
                continue;
            }
            const oldCols = Object.keys(old.tables[table].columns).length;
            const newCols = Object.keys(next.tables[table].columns).length;
            if (oldCols !== newCols)
                count += Math.abs(oldCols - newCols);
        }
        return count;
    }
}
exports.SchemaStateMap = SchemaStateMap;
