"use strict";
// src/duplicateDetector/duplicateDetector.ts
// Member 2 — Logical Duplicate Detector
// Identifies semantically similar columns across the schema
// (e.g., phone vs mobile, email vs email_address) to prevent schema rot.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DuplicateDetector = void 0;
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
class DuplicateDetector {
    constructor(schemaState) {
        this.schemaState = schemaState;
        this.logger = logger_1.Logger.getInstance();
    }
    /**
     * Detects semantically similar columns across all tables in the schema.
     * Returns grouped results sorted by number of duplicates descending.
     */
    detect(schema) {
        this.logger.info('DuplicateDetector: scanning schema for logical duplicates...');
        const groups = [];
        for (const [semanticKey, synonyms] of Object.entries(SEMANTIC_GROUPS)) {
            const matches = [];
            for (const table of Object.values(schema.tables)) {
                for (const col of Object.values(table.columns)) {
                    const normalizedName = col.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
                    if (synonyms.includes(normalizedName)) {
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
                // Multiple columns matching the same semantic concept — this is a duplicate!
                groups.push({
                    semanticMeaning: semanticKey,
                    columns: matches,
                    suggestion: this.buildSuggestion(semanticKey, matches),
                });
            }
        }
        // Also run edit-distance based detection for names not in the dictionary
        const extraGroups = this.detectByEditDistance(schema);
        groups.push(...extraGroups);
        this.logger.info(`DuplicateDetector: found ${groups.length} duplicate group(s)`);
        return groups.sort((a, b) => b.columns.length - a.columns.length);
    }
    // ──────────────────────────────────────────────
    // Edit-distance fuzzy matching (catch typos / abbreviations)
    // ──────────────────────────────────────────────
    detectByEditDistance(schema) {
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
                // Skip same table
                if (a.table === b.table) {
                    continue;
                }
                const key = [a.table, a.column, b.table, b.column].sort().join('|');
                if (visited.has(key)) {
                    continue;
                }
                const similarity = this.stringSimilarity(a.column.toLowerCase(), b.column.toLowerCase());
                // 0.75 threshold: high similarity but not identical
                if (similarity >= 0.75 && similarity < 1.0) {
                    visited.add(key);
                    const existing = groups.find(g => g.columns.some(c => c.table === a.table && c.column === a.column));
                    if (existing) {
                        existing.columns.push({ table: b.table, column: b.column, type: b.type, reason: `Similar to "${a.column}" (${Math.round(similarity * 100)}% match)` });
                    }
                    else {
                        groups.push({
                            semanticMeaning: `${a.column} ≈ ${b.column}`,
                            columns: [
                                { table: a.table, column: a.column, type: a.type, reason: `Similar to "${b.column}" (${Math.round(similarity * 100)}% match)` },
                                { table: b.table, column: b.column, type: b.type, reason: `Similar to "${a.column}" (${Math.round(similarity * 100)}% match)` },
                            ],
                            suggestion: `Standardize "${a.column}" and "${b.column}" to a single column name`,
                        });
                    }
                }
            }
        }
        return groups;
    }
    /** Normalized Levenshtein similarity in [0, 1] */
    stringSimilarity(a, b) {
        const maxLen = Math.max(a.length, b.length);
        if (maxLen === 0) {
            return 1.0;
        }
        return 1 - this.levenshtein(a, b) / maxLen;
    }
    levenshtein(a, b) {
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
    // ──────────────────────────────────────────────
    // Suggestion builder
    // ──────────────────────────────────────────────
    buildSuggestion(semanticKey, matches) {
        const canonical = CANONICAL_NAMES[semanticKey] ?? semanticKey;
        const tableList = matches.map(m => `${m.table}.${m.column}`).join(', ');
        return `Standardize all to "${canonical}": found duplicates in [${tableList}]. Run a migration to rename and consolidate.`;
    }
}
exports.DuplicateDetector = DuplicateDetector;
// Preferred canonical column name for each semantic group
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
//# sourceMappingURL=duplicateDetector.js.map