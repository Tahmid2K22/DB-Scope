import { DatabaseSchema } from './types';
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
export declare function createAdapter(config: DbConfig): DbAdapter;
//# sourceMappingURL=dbAdapters.d.ts.map