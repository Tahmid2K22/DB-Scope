// src/ai/promptBuilder.ts
import { DatabaseSchema, MergeConflict } from '../core/types';

export class PromptBuilder {
  static buildRelevantSchemaContext(schema: DatabaseSchema, relevantTables: string[]): string {
    if (!schema || !schema.tables) return 'No relevant tables found.';
    
    const parts: string[] = [];
    const relevantSet = new Set(relevantTables);
    
    for (const [tableName, table] of Object.entries(schema.tables)) {
      if (!relevantSet.has(tableName)) continue;
      
      const cols = Object.values(table.columns).map(c => {
        const p = [c.name, c.type];
        if (!c.nullable) p.push('NOT NULL');
        if (c.isPrimaryKey) p.push('PK');
        if (c.isForeignKey) p.push(`FK -> ${c.referencesTable}.${c.referencesColumn}`);
        if (c.defaultValue) p.push(`DEFAULT ${c.defaultValue}`);
        return p.join(', ');
      }).join('\n    ');
      
      const rowInfo = table.rowCount !== undefined ? ` (${table.rowCount} rows)` : '';
      parts.push(`TABLE ${tableName}${rowInfo}:\n    ${cols}`);
    }
    
    return parts.length > 0 ? parts.join('\n\n') : 'No relevant tables found.';
  }

  static buildCompactSchemaOverview(schema: DatabaseSchema): string {
    if (!schema || !schema.tables) return 'No other tables.';
    const parts: string[] = [];
    for (const [tableName, table] of Object.entries(schema.tables)) {
      const colCount = Object.keys(table.columns).length;
      parts.push(`${tableName} (${colCount} cols)`);
    }
    return parts.length > 0 ? `OTHER TABLES: ${parts.join(', ')}` : 'No other tables.';
  }

  static estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  static blastRadiusSystemPrompt(): string {
    return `You are a senior DBA, migration risk expert, and database reliability engineer.
Analyze this SQL migration holistically and return a consolidated JSON payload.
Consider schema impact (breaking vs non-breaking), data integrity risks, and rollback generation.
For rollbacks, use safetyLevel: "safe", "manual_review", or "destructive".
Score risk from 1 (trivial) to 10 (catastrophic).
Score confidence from 0 (no context) to 100 (full context).
Return ONLY valid JSON with no extra text or markdown fences:
{
  "schemaImpact": {
    "breakingChanges": ["..."],
    "nonBreakingChanges": ["..."],
    "cascadeEffects": ["..."]
  },
  "dataRisks": [
    { "description": "...", "severity": "critical|high|medium|low" }
  ],
  "rollbacks": [
    { "description": "...", "sql": "...", "safetyLevel": "safe|manual_review|destructive" }
  ],
  "score": 7,
  "explanation": "<2-3 sentences explaining the score>",
  "suggestions": ["<actionable suggestion>"],
  "confidence": {
    "overall": { "confidenceScore": 62, "confidenceReason": "..." },
    "schemaImpact": { "confidenceScore": 90, "confidenceReason": "..." },
    "appDependencies": { "confidenceScore": 55, "confidenceReason": "..." },
    "dataIntegrityRisks": { "confidenceScore": 40, "confidenceReason": "..." },
    "documentationDrift": { "confidenceScore": 70, "confidenceReason": "..." }
  }
}`;
  }

  static mergeAnalysisSystemPrompt(): string {
    return `You are analyzing database schema merge conflicts inside the DB-Scope VS Code extension.
Your task is repository-level analysis. Inspect the repository and for EACH conflictId determine:
1. Is this a semantic rename (e.g. name -> full_name)?
2. All source files that reference the old and new field names.
3. Affected ORM models, repositories, services, controllers, API endpoints, DTOs.
4. Affected tests and documentation files.
5. A safe migration strategy.
6. Required application code changes.
7. Backward-compatibility risks.

IMPORTANT RULES:
- DO NOT modify any files.
- Return ONLY valid JSON - no markdown, no prose, no code fences.
- The JSON must be an array where each element corresponds to exactly one conflictId.

Required JSON schema per element:
{
  "conflictId": "<string matching one of the conflictIds above>",
  "resolution": "<rename | keep_a | keep_b | merge | manual_review>",
  "confidence": <0.0 to 1.0>,
  "reason": "<brief explanation>",
  "semanticEquivalent": <true|false>,
  "oldReference": { "table": "<table>", "column": "<column or omit>" },
  "newReference": { "table": "<table>", "column": "<column or omit>" },
  "affectedFiles": [ { "path": "<relative path>", "reason": "<why affected>" } ],
  "affectedSymbols": [ { "name": "<symbol>", "kind": "<class|function|variable>", "file": "<path>" } ],
  "migrationPlan": [ "<step 1>", "<step 2>" ],
  "applicationChanges": [ "<change description>" ],
  "testsToUpdate": [ "<test file or description>" ],
  "risks": [ "<risk description>" ]
}`;
  }

  static blastRadiusUserPrompt(sql: string, schemaContext: string, appDeps: string[], rowCounts: Record<string, number>): string {
    const depsStr = appDeps.length > 0 ? appDeps.join('\n') : 'None found';
    const rowInfo = Object.entries(rowCounts).map(([t, count]) => `${t}: ${count.toLocaleString()} rows`).join('; ');
    return `SQL: ${sql}
Schema Context:
${schemaContext}

App dependencies found:
${depsStr}

Table sizes: ${rowInfo || 'none available'}`;
  }

  static mergeConflictUserPrompt(conflicts: MergeConflict[], schemaAContext: string, schemaBContext: string): string {
    const conflictLines = conflicts.map(c => {
      const id = c.column ? `${c.conflictType}::${c.table}::${c.column}` : `${c.conflictType}::${c.table}`;
      const location = c.column ? `${c.table}.${c.column}` : c.table;
      return [
        `  conflictId: "${id}"`,
        `  type: ${c.conflictType}`,
        `  location: ${location}`,
        `  sourceA: ${c.sourceA}`,
        `  sourceB: ${c.sourceB}`,
        `  deterministicSuggestion: ${c.suggestion}`,
      ].join('\n');
    }).join('\n\n');

    return `Schema A Context:
${schemaAContext}

Schema B Context:
${schemaBContext}

Conflicts to analyze:
${conflictLines}`;
  }
}
