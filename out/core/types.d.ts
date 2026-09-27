export interface ColumnDefinition {
    name: string;
    type: string;
    nullable: boolean;
    isPrimaryKey: boolean;
    isForeignKey: boolean;
    referencesTable?: string;
    referencesColumn?: string;
    defaultValue?: string;
}
export interface IndexDefinition {
    name: string;
    columns: string[];
    isUnique: boolean;
}
export interface TableConstraint {
    name?: string;
    type: 'primary_key' | 'foreign_key' | 'unique' | 'check';
    columns: string[];
    referencesTable?: string;
    referenceColumns?: string[];
    raw: string;
}
export interface TableDefinition {
    name: string;
    columns: Record<string, ColumnDefinition>;
    indexes: IndexDefinition[];
    constraints?: TableConstraint[];
    rowCount?: number;
}
export interface DatabaseSchema {
    dbType: 'postgresql' | 'mysql' | 'oracle';
    databaseName: string;
    tables: Record<string, TableDefinition>;
    extractedAt: number;
    source?: 'live' | 'codebase' | 'merged';
}
export interface SchemaSnapshot {
    timestamp: number;
    schema: DatabaseSchema;
    changeCount: number;
}
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
/**
 * How confident Granite was in one analysis dimension (0–100).
 * confidenceReason explains in plain English what context was missing.
 */
export interface DimensionConfidence {
    confidenceScore: number;
    confidenceReason: string;
}
/**
 * Per-dimension + overall AI confidence for a single blast radius analysis.
 */
export interface AnalysisConfidence {
    overall: DimensionConfidence;
    schemaImpact: DimensionConfidence;
    appDependencies: DimensionConfidence;
    dataIntegrityRisks: DimensionConfidence;
    documentationDrift: DimensionConfidence;
}
export interface BlastRadiusResult {
    sql: string;
    riskScore: number;
    riskLevel: RiskLevel;
    affectedTables: string[];
    schemaImpact: SchemaImpact;
    appDependencies: AppDependency[];
    dataIntegrityRisks: DataIntegrityRisk[];
    documentationDrift: DocumentationDrift[];
    suggestions: string[];
    rollbackSuggestions: RollbackSuggestion[];
    riskExplanation: string;
    confidence: AnalysisConfidence;
    generatedAt: number;
}
export interface SchemaImpact {
    breakingChanges: string[];
    nonBreakingChanges: string[];
    cascadeEffects: string[];
}
export interface AppDependency {
    filePath: string;
    lineNumber?: number;
    tableName: string;
    usage: string;
    severity: RiskLevel;
}
export interface DataIntegrityRisk {
    description: string;
    affectedRows?: number;
    severity: RiskLevel;
}
export interface DocumentationDrift {
    filePath: string;
    issue: string;
    suggestion: string;
}
export interface RollbackSuggestion {
    description: string;
    sql: string;
    safetyLevel: 'safe' | 'manual_review' | 'destructive';
}
export type DiagnosticSeverity = 'error' | 'warning' | 'info';
export interface SqlDiagnostic {
    message: string;
    severity: DiagnosticSeverity;
    startOffset: number;
    endOffset: number;
    suggestion?: string;
    riskScore?: number;
    code?: string;
}
export interface DuplicateGroup {
    semanticMeaning: string;
    columns: DuplicateColumn[];
    suggestion: string;
}
export interface DuplicateColumn {
    table: string;
    column: string;
    type: string;
    reason: string;
}
export interface DuplicateTableGroup {
    semanticMeaning: string;
    tables: {
        name: string;
        columnCount: number;
        similarity: number;
    }[];
    similarity: number;
    suggestion: string;
}
export type DuplicateSeverity = 'critical' | 'high' | 'medium' | 'low';
export interface MigrationScript {
    id: string;
    title: string;
    upSql: string;
    downSql: string;
    tables: string[];
    riskLevel: RiskLevel;
}
export interface ParsedAlterTable {
    operation: 'ADD_COLUMN' | 'DROP_COLUMN' | 'RENAME_COLUMN' | 'MODIFY_COLUMN' | 'RENAME_TABLE' | 'ADD_CONSTRAINT' | 'DROP_CONSTRAINT' | 'UNKNOWN';
    table: string;
    column?: string;
    newName?: string;
    definition?: string;
    newType?: string;
    nullable?: boolean;
    defaultValue?: string;
    constraintName?: string;
    dialect: 'postgresql' | 'mysql' | 'oracle' | 'ansi';
    rawSql: string;
}
export interface MergeConflict {
    table: string;
    column?: string;
    conflictType: 'type_mismatch' | 'name_conflict' | 'nullable_difference' | 'missing_table' | 'missing_column';
    sourceA: string;
    sourceB: string;
    suggestion: string;
    reconciliationSql: string;
}
export interface BobResolutionSummary {
    conflictId: string;
    resolution: string;
    confidence: number;
    reason: string;
    affectedFiles: {
        path: string;
        reason: string;
    }[];
    affectedSymbols: {
        name: string;
        kind: string;
        file: string;
    }[];
    migrationPlan: string[];
    applicationChanges: string[];
    testsToUpdate: string[];
    risks: string[];
}
export interface MergeAnalysisResult {
    schemaA: DatabaseSchema;
    schemaB: DatabaseSchema;
    conflicts: MergeConflict[];
    reconciledSql: string;
    unifiedSchema: DatabaseSchema;
    mergedAt: number;
    /** Present when IBM Bob Shell successfully enriched the analysis. */
    bobResolutions?: BobResolutionSummary[];
}
//# sourceMappingURL=types.d.ts.map