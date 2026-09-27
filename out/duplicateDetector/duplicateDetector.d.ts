import { DatabaseSchema, DuplicateGroup, DuplicateTableGroup, MigrationScript } from '../core/types';
export declare class DuplicateDetector {
    private readonly schemaState;
    private readonly logger;
    constructor(schemaState: {
        getCurrentSchema: () => Promise<DatabaseSchema | null>;
    });
    /**
     * Detects semantically similar columns across AND within tables.
     * Returns grouped results sorted by number of duplicates descending.
     */
    detect(schema: DatabaseSchema): DuplicateGroup[];
    /**
     * Detects entity-level (table-level) duplicates using Jaccard column-set similarity
     * and fuzzy table name matching.
     */
    detectTableDuplicates(schema: DatabaseSchema): DuplicateTableGroup[];
    /**
     * Generate migration SQL for a duplicate column group.
     * Picks a canonical column per table and generates RENAME + COALESCE backfill + DROP.
     */
    generateMigration(group: DuplicateGroup, canonicalName?: string): MigrationScript;
    private detectByEditDistance;
    private buildSuggestion;
}
/** Normalize a column name: lowercase, non-alnum → _, collapse, trim */
export declare function normalizeColumnName(name: string): string;
/** Jaccard similarity between two sets */
export declare function jaccardSimilarity(a: Set<string>, b: Set<string>): number;
/** Normalized Levenshtein similarity in [0, 1] */
export declare function stringSimilarity(a: string, b: string): number;
type TypeFamily = 'integer' | 'float' | 'text' | 'boolean' | 'datetime' | 'binary' | 'json' | 'uuid' | 'unknown';
export declare function getTypeFamily(type: string): TypeFamily;
export type TypeCompatibilityLevel = 'compatible' | 'castable' | 'incompatible';
export declare function assessTypeCompatibility(typeA: string, typeB: string): TypeCompatibilityLevel;
export {};
//# sourceMappingURL=duplicateDetector.d.ts.map