export type SqlOperation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALTER' | 'DROP' | 'CREATE' | 'TRUNCATE' | 'UNKNOWN';
export interface ParsedSql {
    operation: SqlOperation;
    tables: string[];
    columns: string[];
    isDestructive: boolean;
    rawSql: string;
}
/**
 * AI-powered SQL parser — uses Granite to handle CTEs, MERGE, stored procedures,
 * and any dialect. Falls back to the regex parser if the AI call fails.
 */
export declare function parseSqlAI(sql: string, watsonxClient?: {
    ask(s: string, u: string, t?: number): Promise<string>;
}): Promise<ParsedSql>;
export declare function parseSql(sql: string): ParsedSql;
//# sourceMappingURL=sqlParser.d.ts.map