export type SqlOperation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALTER' | 'DROP' | 'CREATE' | 'TRUNCATE' | 'UNKNOWN';
export interface ParsedSql {
    operation: SqlOperation;
    tables: string[];
    columns: string[];
    isDestructive: boolean;
    rawSql: string;
}
export declare function parseSql(sql: string): ParsedSql;
//# sourceMappingURL=sqlParser.d.ts.map