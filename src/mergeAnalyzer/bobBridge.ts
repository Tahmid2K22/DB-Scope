// src/mergeAnalyzer/bobBridge.ts
// IBM Bob Shell CLI bridge for MergeAnalyzer.
// Invokes `bob run` via stdin (never via CLI args) so large prompts never hit
// OS command-line length limits.  Operates in analysis-only mode — Bob is
// instructed never to modify files.

import { spawn } from 'child_process';
import { MergeConflict, DatabaseSchema } from '../core/types';

// ──────────────────────────────────────────────
// Public output types
// ──────────────────────────────────────────────

export type BobResolution =
  | 'rename'
  | 'keep_a'
  | 'keep_b'
  | 'merge'
  | 'manual_review';

export interface BobAffectedFile {
  path: string;
  reason: string;
}

export interface BobAffectedSymbol {
  name: string;
  kind: string;
  file: string;
}

export interface BobConflictResolution {
  conflictId: string;
  resolution: BobResolution;
  confidence: number;
  reason: string;
  semanticEquivalent: boolean;
  oldReference: { table: string; column?: string };
  newReference: { table: string; column?: string };
  affectedFiles: BobAffectedFile[];
  affectedSymbols: BobAffectedSymbol[];
  migrationPlan: string[];
  applicationChanges: string[];
  testsToUpdate: string[];
  risks: string[];
}

export interface BobBridgeResult {
  available: boolean;
  resolutions: BobConflictResolution[];
  rawOutput?: string;
  error?: string;
}

// ──────────────────────────────────────────────
// Conflict filtering — only invoke Bob when
// repository-level reasoning genuinely adds value
// ──────────────────────────────────────────────

const SEMANTIC_CONFLICT_TYPES = new Set<MergeConflict['conflictType']>([
  'missing_column',
  'missing_table',
  'type_mismatch',
  'nullable_difference',
  'name_conflict',
]);

/** Returns the subset of conflicts worth sending to Bob. */
export function filterSemanticallyRelevant(conflicts: MergeConflict[]): MergeConflict[] {
  return conflicts.filter(c => SEMANTIC_CONFLICT_TYPES.has(c.conflictType));
}

// ──────────────────────────────────────────────
// Stable conflict ID derivation
// ──────────────────────────────────────────────

export function conflictId(c: MergeConflict): string {
  return c.column
    ? `${c.conflictType}::${c.table}::${c.column}`
    : `${c.conflictType}::${c.table}`;
}

// ──────────────────────────────────────────────
// Prompt builder
// ──────────────────────────────────────────────

export function buildBobPrompt(
  workspaceRoot: string,
  conflicts: MergeConflict[],
  schemaA: DatabaseSchema,
  schemaB: DatabaseSchema,
): string {
  const conflictLines = conflicts.map(c => {
    const id = conflictId(c);
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

  const tableListA = Object.keys(schemaA.tables).join(', ');
  const tableListB = Object.keys(schemaB.tables).join(', ');

  return `You are analyzing database schema merge conflicts inside the DB-Scope VS Code extension.

Repository root: ${workspaceRoot}
Schema A (database: ${schemaA.databaseName}) tables: ${tableListA}
Schema B (database: ${schemaB.databaseName}) tables: ${tableListB}

Conflicts to analyze:
${conflictLines}

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
- Return ONLY valid JSON — no markdown, no prose, no code fences.
- The JSON must be an array where each element corresponds to exactly one conflictId above.

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

// ──────────────────────────────────────────────
// JSON extraction
// Handles: raw JSON, ```json fences, CLI preamble
// ──────────────────────────────────────────────

export function extractJson(raw: string): BobConflictResolution[] | null {
  if (!raw || raw.trim().length === 0) { return null; }

  // Check if raw is a Bob CLI result wrapper {"type":"result", "last_message":"..."}
  try {
    const wrapped = JSON.parse(raw.trim());
    if (wrapped && typeof wrapped === 'object' && typeof wrapped.last_message === 'string') {
      raw = wrapped.last_message;
    }
  } catch {
    // proceed with raw text
  }

  // Strip markdown code fences if present
  const text = raw.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '');

  // Find the outermost JSON array: first '[' to last ']'
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) { return null; }

  const candidate = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate);
    if (!Array.isArray(parsed)) { return null; }
    return parsed as BobConflictResolution[];
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────
// Bob executable detection
// ──────────────────────────────────────────────

/** Returns true if `bob` is on PATH without throwing. */
export async function isBobAvailable(): Promise<boolean> {
  return new Promise(resolve => {
    const isWin = process.platform === 'win32';
    const probe = isWin
      ? spawn('cmd.exe', ['/c', 'bob', '--version'], { stdio: 'ignore', shell: false })
      : spawn('bob', ['--version'], { stdio: 'ignore', shell: false });
    probe.on('error', () => resolve(false));
    probe.on('close', code => resolve(code === 0));
  });
}

// ──────────────────────────────────────────────
// Core invocation
// Writes prompt to stdin; never passes it as an arg.
// ──────────────────────────────────────────────

const BOB_TIMEOUT_MS = 120_000; // 2 min — give Bob enough time to scan files

export async function invokeBobForMergeAnalysis(
  prompt: string,
  workspaceRoot: string,
): Promise<BobBridgeResult> {
  const available = await isBobAvailable();
  if (!available) {
    return {
      available: false,
      resolutions: [],
      error: 'IBM Bob Shell (`bob`) was not found on PATH.',
    };
  }

  return new Promise<BobBridgeResult>(resolve => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'cmd.exe' : 'bob';
    const args = isWin
      ? ['/c', 'bob', 'run', '--accept-license', '--trust', '-f', 'json', '--max-turns', '10', '--max-cost', '0.50']
      : ['run', '--accept-license', '--trust', '-f', 'json', '--max-turns', '10', '--max-cost', '0.50'];

    // Spawn bob with safety limits; prompt comes via stdin only
    const child = spawn(
      cmd,
      args,
      {
        cwd: workspaceRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        env: { ...process.env },
      },
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    // Write prompt to stdin and close the stream
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();

    // Hard timeout — resolve with whatever we have so far
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        available: true,
        resolutions: [],
        rawOutput: stdout,
        error: `Bob process timed out after ${BOB_TIMEOUT_MS / 1000}s.`,
      });
    }, BOB_TIMEOUT_MS);

    child.on('close', (code: number | null) => {
      clearTimeout(timer);

      if (code !== 0 && stdout.trim().length === 0) {
        resolve({
          available: true,
          resolutions: [],
          rawOutput: stdout,
          error: `Bob exited with code ${code}. stderr: ${stderr.slice(0, 500)}`,
        });
        return;
      }

      const resolutions = extractJson(stdout);
      if (!resolutions) {
        resolve({
          available: true,
          resolutions: [],
          rawOutput: stdout,
          error: 'Bob returned output that could not be parsed as JSON. Deterministic analysis preserved.',
        });
        return;
      }

      resolve({ available: true, resolutions, rawOutput: stdout });
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({
        available: false,
        resolutions: [],
        error: `Failed to spawn bob process: ${err.message}`,
      });
    });
  });
}
