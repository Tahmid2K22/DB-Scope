/**
 * src/test/member1.comprehensive.test.ts
 * ════════════════════════════════════════════════════════════════════════════
 * COMPREHENSIVE TEST SUITE — Member 1 (BlastRadiusAnalyzer + SqlHoverProvider)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Covers every method, branch, edge-case, and boundary in:
 *   • src/utils/sqlParser.ts         — parseSql, detectOperation, extractTables, extractColumns
 *   • src/blastRadius/blastRadiusAnalyzer.ts
 *       – analyzeSchemaImpact        (all 8 SQL-pattern branches + cascade FK lookup)
 *       – findAppDependencies        (empty tables, no workspace, ORM model name)
 *       – deriveModelName            (6 pluralisation cases)
 *       – classifyDepSeverity        (4 severity bands)
 *       – assessDataIntegrityRisks   (9 rules: DELETE, UPDATE, DROP COL, NOT NULL, CASCADE,
 *                                     DROP FK, DROP PK, UNIQUE INDEX, ENGINE=)
 *       – calculateRiskScore         (dimension caps, size multiplier, min/max clamp)
 *       – getTableSizeFactor         (4 thresholds)
 *       – scoreToLevel               (4 bands)
 *       – buildSuggestions           (5 suggestion conditions)
 *       – buildRollbackSuggestions   (DROP TABLE with/without snapshot, DROP COLUMN,
 *                                     ADD COLUMN, RENAME COLUMN, RENAME TABLE,
 *                                     CREATE INDEX, DELETE, TRUNCATE, unknown SQL)
 *       – exportResult               (filename format, file content)
 *   • src/hoverProvider/sqlHoverProvider.ts
 *       – extractSqlFromString       (backtick multi-line, double-quoted, single-quoted,
 *                                     template literal with ${}, no match)
 *       – extractStatementAt         (single stmt, multiple stmts, cursor at boundary,
 *                                     empty stmt, no semicolons)
 *       – riskEmoji                  (all 4 levels)
 *       – buildHover                 (sections present/absent, rollback section, range)
 *
 * Run with:
 *   npx ts-node src/test/member1.comprehensive.test.ts
 *
 * Uses only Node's built-in `assert` — no test framework required.
 * ════════════════════════════════════════════════════════════════════════════
 */
export {};
//# sourceMappingURL=member1.comprehensive.test.d.ts.map