import { DatabaseSchema, DuplicateGroup } from '../core/types';
export declare class DuplicateDetector {
    private readonly schemaState;
    private readonly logger;
    constructor(schemaState: {
        getCurrentSchema: () => Promise<DatabaseSchema | null>;
    });
    /**
     * Detects semantically similar columns across all tables in the schema.
     * Returns grouped results sorted by number of duplicates descending.
     */
    detect(schema: DatabaseSchema): DuplicateGroup[];
    private detectByEditDistance;
    /** Normalized Levenshtein similarity in [0, 1] */
    private stringSimilarity;
    private levenshtein;
    private buildSuggestion;
}
//# sourceMappingURL=duplicateDetector.d.ts.map