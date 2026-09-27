"use strict";
// src/duplicateDetector/duplicateDetector.ts
// Member 2 — Logical Duplicate Detector
// Detects semantically similar columns (across AND within tables),
// entity-level table duplicates via Jaccard similarity,
// and generates actionable migration SQL.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DuplicateDetector = void 0;
exports.normalizeColumnName = normalizeColumnName;
exports.jaccardSimilarity = jaccardSimilarity;
exports.stringSimilarity = stringSimilarity;
exports.getTypeFamily = getTypeFamily;
exports.assessTypeCompatibility = assessTypeCompatibility;
const logger_1 = require("../utils/logger");
// Semantic synonym groups — columns in the same group are considered logical duplicates
const SEMANTIC_GROUPS = {
    phone: ['phone', 'mobile', 'cell', 'telephone', 'phone_number', 'mobile_number', 'cell_number', 'tel', 'contact_number'],
    email: ['email', 'email_address', 'mail', 'e_mail', 'user_email', 'contact_email'],
    name: ['name', 'full_name', 'fullname', 'display_name', 'user_name', 'username'],
    first_name: ['first_name', 'firstname', 'fname', 'given_name'],
    last_name: ['last_name', 'lastname', 'lname', 'surname', 'family_name'],
    address: ['address', 'street', 'street_address', 'addr', 'location'],
    city: ['city', 'city_name', 'town'],
    zip: ['zip', 'zipcode', 'zip_code', 'postal_code', 'postcode'],
    country: ['country', 'country_code', 'nation'],
    date_of_birth: ['date_of_birth', 'dob', 'birth_date', 'birthdate', 'born_on'],
    created_at: ['created_at', 'created_date', 'creation_date', 'date_created', 'insert_date'],
    updated_at: ['updated_at', 'updated_date', 'modified_at', 'modified_date', 'last_modified', 'last_updated'],
    deleted_at: ['deleted_at', 'deleted_date', 'removed_at', 'soft_delete'],
    status: ['status', 'state', 'is_active', 'active', 'enabled', 'flag'],
    description: ['description', 'desc', 'details', 'info', 'notes', 'comment', 'remarks'],
    amount: ['amount', 'price', 'cost', 'value', 'total', 'sum'],
    quantity: ['quantity', 'qty', 'count', 'num', 'number'],
    image: ['image', 'image_url', 'photo', 'photo_url', 'avatar', 'avatar_url', 'picture', 'thumbnail'],
    token: ['token', 'access_token', 'auth_token', 'api_key', 'secret_key', 'api_token'],
};
// Canonical column names for semantic groups
const CANONICAL_NAMES = {
    phone: 'phone_number',
    email: 'email',
    name: 'full_name',
    first_name: 'first_name',
    last_name: 'last_name',
    address: 'street_address',
    city: 'city',
    zip: 'postal_code',
    country: 'country_code',
    date_of_birth: 'date_of_birth',
    created_at: 'created_at',
    updated_at: 'updated_at',
    deleted_at: 'deleted_at',
    status: 'status',
    description: 'description',
    amount: 'amount',
    quantity: 'quantity',
    image: 'image_url',
    token: 'access_token',
};
// Table-level similarity thresholds
const JACCARD_STRONG_THRESHOLD = 0.6; // 60% column overlap → strong duplicate
const TABLE_NAME_WEIGHT = 0.3; // weight for name similarity in combined score
class DuplicateDetector {
    constructor(schemaState) {
        this.schemaState = schemaState;
        this.logger = logger_1.Logger.getInstance();
    }
    /**
     * Detects semantically similar columns across AND within tables.
     * Returns grouped results sorted by number of duplicates descending.
     */
    detect(schema) {
        this.logger.info('DuplicateDetector: scanning schema for logical duplicates...');
        const groups = [];
        // 1. Synonym-group detection (cross-table AND intra-table)
        for (const [semanticKey, synonyms] of Object.entries(SEMANTIC_GROUPS)) {
            const matches = [];
            for (const table of Object.values(schema.tables)) {
                for (const col of Object.values(table.columns)) {
                    const normalized = normalizeColumnName(col.name);
                    if (synonyms.includes(normalized)) {
                        matches.push({
                            table: table.name,
                            column: col.name,
                            type: col.type,
                            reason: `"${col.name}" is a synonym for "${semanticKey}"`,
                        });
                    }
                }
            }
            if (matches.length >= 2) {
                groups.push({
                    semanticMeaning: semanticKey,
                    columns: matches,
                    suggestion: this.buildSuggestion(semanticKey, matches),
                });
            }
        }
        // 2. Edit-distance fuzzy matching (cross-table AND intra-table)
        const extraGroups = this.detectByEditDistance(schema, false); // false = include intra-table
        groups.push(...extraGroups);
        this.logger.info(`DuplicateDetector: found ${groups.length} duplicate group(s)`);
        return groups.sort((a, b) => b.columns.length - a.columns.length);
    }
    /**
     * Detects entity-level (table-level) duplicates using Jaccard column-set similarity
     * and fuzzy table name matching.
     */
    detectTableDuplicates(schema) {
        const tables = Object.values(schema.tables);
        if (tables.length < 2) {
            return [];
        }
        const groups = [];
        const visited = new Set();
        for (let i = 0; i < tables.length; i++) {
            for (let j = i + 1; j < tables.length; j++) {
                const a = tables[i];
                const b = tables[j];
                const key = [a.name, b.name].sort().join('||');
                if (visited.has(key)) {
                    continue;
                }
                const jaccard = jaccardSimilarity(new Set(Object.keys(a.columns).map(normalizeColumnName)), new Set(Object.keys(b.columns).map(normalizeColumnName)));
                const nameSim = stringSimilarity(normalizeColumnName(a.name), normalizeColumnName(b.name));
                const combined = jaccard * (1 - TABLE_NAME_WEIGHT) + nameSim * TABLE_NAME_WEIGHT;
                if (combined >= JACCARD_STRONG_THRESHOLD) {
                    visited.add(key);
                    groups.push({
                        semanticMeaning: `${a.name} ≈ ${b.name}`,
                        tables: [
                            { name: a.name, columnCount: Object.keys(a.columns).length, similarity: combined },
                            { name: b.name, columnCount: Object.keys(b.columns).length, similarity: combined },
                        ],
                        similarity: combined,
                        suggestion: `Tables "${a.name}" and "${b.name}" share ${Math.round(combined * 100)}% structural similarity. Consider merging or establishing a clear separation of concerns.`,
                    });
                }
            }
        }
        return groups.sort((a, b) => b.similarity - a.similarity);
    }
    /**
     * Generate migration SQL for a duplicate column group.
     * Picks a canonical column per table and generates RENAME + COALESCE backfill + DROP.
     */
    generateMigration(group, canonicalName) {
        const canonical = canonicalName ?? CANONICAL_NAMES[group.semanticMeaning] ?? group.semanticMeaning;
        // Group columns by table
        const byTable = {};
        for (const col of group.columns) {
            if (!byTable[col.table]) {
                byTable[col.table] = [];
            }
            byTable[col.table].push(col);
        }
        const upStatements = ['-- DB-Scope generated migration'];
        const downStatements = ['-- DB-Scope rollback migration'];
        for (const [table, cols] of Object.entries(byTable)) {
            // Find winner (column already named canonical, else first alphabetically)
            const winner = cols.find(c => c.column === canonical) ?? cols.sort((a, b) => a.column.localeCompare(b.column))[0];
            const others = cols.filter(c => c.column !== winner.column);
            // Rename winner to canonical if needed
            if (winner.column !== canonical) {
                upStatements.push(`ALTER TABLE ${quoteId(table)} RENAME COLUMN ${quoteId(winner.column)} TO ${quoteId(canonical)};`);
                downStatements.unshift(`ALTER TABLE ${quoteId(table)} RENAME COLUMN ${quoteId(canonical)} TO ${quoteId(winner.column)};`);
            }
            // For each other column: backfill + drop
            for (const col of others) {
                const tmp = `${col.column}_legacy`;
                upStatements.push(`-- Merge "${col.column}" into "${canonical}" (table: ${table})`);
                upStatements.push(`UPDATE ${quoteId(table)} SET ${quoteId(canonical)} = COALESCE(${quoteId(canonical)}, ${quoteId(col.column)});`);
                upStatements.push(`ALTER TABLE ${quoteId(table)} DROP COLUMN ${quoteId(col.column)};`);
                downStatements.unshift(`ALTER TABLE ${quoteId(table)} ADD COLUMN ${quoteId(col.column)} ${col.type};`);
                void tmp;
            }
        }
        const tables = Object.keys(byTable);
        const id = `migration_${group.semanticMeaning.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}`;
        return {
            id,
            title: `Consolidate "${group.semanticMeaning}" duplicates to "${canonical}"`,
            upSql: upStatements.join('\n'),
            downSql: downStatements.join('\n'),
            tables,
            riskLevel: tables.length > 1 ? 'high' : 'medium',
        };
    }
    // ──────────────────────────────────────────────
    // Edit-distance fuzzy matching
    // ──────────────────────────────────────────────
    detectByEditDistance(schema, crossTableOnly) {
        const allColumns = [];
        for (const table of Object.values(schema.tables)) {
            for (const col of Object.values(table.columns)) {
                allColumns.push({ table: table.name, column: col.name, type: col.type });
            }
        }
        const visited = new Set();
        const groups = [];
        for (let i = 0; i < allColumns.length; i++) {
            for (let j = i + 1; j < allColumns.length; j++) {
                const a = allColumns[i];
                const b = allColumns[j];
                // Skip same table if cross-table only mode (removed guard for intra-table support)
                if (crossTableOnly && a.table === b.table) {
                    continue;
                }
                const key = [a.table, a.column, b.table, b.column].sort().join('|');
                if (visited.has(key)) {
                    continue;
                }
                const similarity = stringSimilarity(a.column.toLowerCase(), b.column.toLowerCase());
                if (similarity >= 0.75 && similarity < 1.0) {
                    visited.add(key);
                    const existing = groups.find(g => g.columns.some(c => c.table === a.table && c.column === a.column));
                    const reason = `Similar to "${a.table}.${a.column}" (${Math.round(similarity * 100)}% match)`;
                    if (existing) {
                        existing.columns.push({ table: b.table, column: b.column, type: b.type, reason });
                    }
                    else {
                        groups.push({
                            semanticMeaning: `${a.column} ≈ ${b.column}`,
                            columns: [
                                { table: a.table, column: a.column, type: a.type, reason: `Similar to "${b.table}.${b.column}" (${Math.round(similarity * 100)}% match)` },
                                { table: b.table, column: b.column, type: b.type, reason },
                            ],
                            suggestion: `Standardize "${a.column}" and "${b.column}" to a single column name`,
                        });
                    }
                }
            }
        }
        return groups;
    }
    buildSuggestion(semanticKey, matches) {
        const canonical = CANONICAL_NAMES[semanticKey] ?? semanticKey;
        const tableList = matches.map(m => `${m.table}.${m.column}`).join(', ');
        return `Standardize all to "${canonical}": found duplicates in [${tableList}]. Run a migration to rename and consolidate.`;
    }
}
exports.DuplicateDetector = DuplicateDetector;
// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for testing)
// ─────────────────────────────────────────────────────────────────────────────
/** Normalize a column name: lowercase, non-alnum → _, collapse, trim */
function normalizeColumnName(name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}
/** Jaccard similarity between two sets */
function jaccardSimilarity(a, b) {
    if (a.size === 0 && b.size === 0) {
        return 1.0;
    }
    let intersection = 0;
    for (const item of a) {
        if (b.has(item)) {
            intersection++;
        }
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}
/** Normalized Levenshtein similarity in [0, 1] */
function stringSimilarity(a, b) {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) {
        return 1.0;
    }
    return 1 - levenshtein(a, b) / maxLen;
}
function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) {
        dp[0][j] = j;
    }
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}
/** Quote an identifier for safe SQL output */
function quoteId(name) {
    return `"${name.replace(/"/g, '""')}"`;
}
const TYPE_FAMILY_MAP = {
    int: 'integer', integer: 'integer', bigint: 'integer', smallint: 'integer',
    tinyint: 'integer', mediumint: 'integer', serial: 'integer', bigserial: 'integer',
    float: 'float', double: 'float', real: 'float', numeric: 'float', decimal: 'float',
    'double precision': 'float',
    varchar: 'text', char: 'text', text: 'text', nvarchar: 'text', nchar: 'text',
    tinytext: 'text', mediumtext: 'text', longtext: 'text', 'character varying': 'text',
    bool: 'boolean', boolean: 'boolean',
    date: 'datetime', time: 'datetime', datetime: 'datetime', timestamp: 'datetime',
    timestamptz: 'datetime', timetz: 'datetime',
    blob: 'binary', bytea: 'binary', binary: 'binary', varbinary: 'binary',
    json: 'json', jsonb: 'json',
    uuid: 'uuid',
};
function getTypeFamily(type) {
    const base = type.toLowerCase().replace(/\([^)]*\)/, '').trim();
    return TYPE_FAMILY_MAP[base] ?? 'unknown';
}
function assessTypeCompatibility(typeA, typeB) {
    if (typeA.toLowerCase() === typeB.toLowerCase()) {
        return 'compatible';
    }
    const famA = getTypeFamily(typeA);
    const famB = getTypeFamily(typeB);
    if (famA === famB) {
        return 'compatible';
    }
    // Castable pairs
    const castable = [
        ['integer', 'float'], ['float', 'integer'],
        ['integer', 'text'], ['float', 'text'], ['boolean', 'integer'],
        ['datetime', 'text'], ['uuid', 'text'],
    ];
    if (castable.some(([a, b]) => a === famA && b === famB)) {
        return 'castable';
    }
    return 'incompatible';
}
//# sourceMappingURL=duplicateDetector.js.map