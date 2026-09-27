// src/diagnostics/sqlCodeActionProvider.ts
// Member 2 — SQL Quick Fix Code Actions
// Provides VS Code light-bulb quick fixes for DB-Scope diagnostics.

import * as vscode from 'vscode';
import { SchemaStateMap } from '../core/schemaStateMap';
import { splitSqlStatements, extractTablesFromStatement } from './sqlTokenizer';

const QUICK_FIX_CODES = new Set([
  'DBS-DESTRUCT-003', // DELETE without WHERE → add WHERE 1=0
  'DBS-DESTRUCT-004', // UPDATE without WHERE → add WHERE 1=0
  'DBS-DESTRUCT-001', // DROP TABLE → convert to soft-delete
  'DBS-SCHEMA-005',   // NOT NULL without DEFAULT → add DEFAULT / make nullable
  'DBS-PERF-002',     // SELECT * → expand column list
]);

export class SqlCodeActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  constructor(private readonly schemaState: SchemaStateMap) {}

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    _token: vscode.CancellationToken
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const text = document.getText();
    const statements = splitSqlStatements(text);

    for (const diag of context.diagnostics) {
      if (diag.source !== 'DB-Scope') { continue; }
      const code = String(diag.code ?? '');
      if (!QUICK_FIX_CODES.has(code)) { continue; }

      // Find the statement containing this diagnostic
      const diagOffset = document.offsetAt(diag.range.start);
      const stmt = statements.find(s => s.startOffset <= diagOffset && diagOffset <= s.endOffset);
      if (!stmt) { continue; }

      switch (code) {
        case 'DBS-DESTRUCT-003': {
          // DELETE without WHERE → add WHERE 1 = 0
          const action = new vscode.CodeAction(
            'Add WHERE 1 = 0 (safe placeholder — matches no rows)',
            vscode.CodeActionKind.QuickFix
          );
          const edit = new vscode.WorkspaceEdit();
          const insertPos = document.positionAt(stmt.endOffset);
          edit.insert(document.uri, insertPos, ' WHERE 1 = 0 /* TODO: add real predicate */');
          action.edit = edit;
          action.diagnostics = [diag];
          action.isPreferred = true;
          actions.push(action);
          break;
        }
        case 'DBS-DESTRUCT-004': {
          // UPDATE without WHERE → add WHERE 1 = 0
          const action = new vscode.CodeAction(
            'Add WHERE 1 = 0 (safe placeholder — matches no rows)',
            vscode.CodeActionKind.QuickFix
          );
          const edit = new vscode.WorkspaceEdit();
          // Insert before trailing semicolon if present, else at end of statement
          const stmtEnd = document.positionAt(stmt.endOffset);
          edit.insert(document.uri, stmtEnd, ' WHERE 1 = 0 /* TODO: add real predicate */');
          action.edit = edit;
          action.diagnostics = [diag];
          action.isPreferred = true;
          actions.push(action);
          break;
        }
        case 'DBS-DESTRUCT-001': {
          // DROP TABLE → soft-delete conversion
          const dropM = /\bDROP\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+EXISTS\s+)?([`"]?[\w$]+[`"]?)/i.exec(stmt.sql);
          if (dropM) {
            const tName = dropM[1].replace(/[`"]/g, '');
            const action = new vscode.CodeAction(
              `Convert DROP TABLE to soft-delete (add deleted_at column)`,
              vscode.CodeActionKind.QuickFix
            );
            const edit = new vscode.WorkspaceEdit();
            const stmtRange = new vscode.Range(
              document.positionAt(stmt.startOffset),
              document.positionAt(stmt.endOffset)
            );
            edit.replace(
              document.uri,
              stmtRange,
              `ALTER TABLE ${tName} ADD COLUMN deleted_at TIMESTAMP NULL;\n-- soft-delete: filter with WHERE deleted_at IS NULL`
            );
            action.edit = edit;
            action.diagnostics = [diag];
            actions.push(action);
          }
          break;
        }
        case 'DBS-SCHEMA-005': {
          // NOT NULL without DEFAULT → make column nullable
          const action = new vscode.CodeAction(
            'Make column nullable instead (remove NOT NULL)',
            vscode.CodeActionKind.QuickFix
          );
          const edit = new vscode.WorkspaceEdit();
          const stmtRange = new vscode.Range(
            document.positionAt(stmt.startOffset),
            document.positionAt(stmt.endOffset)
          );
          const newSql = stmt.sql.replace(/\s+NOT\s+NULL\b/gi, '');
          edit.replace(document.uri, stmtRange, newSql);
          action.edit = edit;
          action.diagnostics = [diag];
          action.isPreferred = true;
          actions.push(action);
          break;
        }
        case 'DBS-PERF-002': {
          // SELECT * → expand with schema column list
          const tables = extractTablesFromStatement(stmt.parseMask);
          if (tables.length > 0) {
            this.schemaState.getCurrentSchema().then(schema => {
              if (!schema) { return; }
              const table = schema.tables[tables[0]];
              if (!table) { return; }
              const cols = Object.keys(table.columns).join(', ');
              const action = new vscode.CodeAction(
                `Expand SELECT * with column list (${cols.slice(0, 60)}${cols.length > 60 ? '…' : ''})`,
                vscode.CodeActionKind.QuickFix
              );
              const edit = new vscode.WorkspaceEdit();
              const stmtRange = new vscode.Range(
                document.positionAt(stmt.startOffset),
                document.positionAt(stmt.endOffset)
              );
              const newSql = stmt.sql.replace(/\bSELECT\s+\*\s+/i, `SELECT ${cols} `);
              edit.replace(document.uri, stmtRange, newSql);
              action.edit = edit;
              action.diagnostics = [diag];
              actions.push(action);
            });
          }
          break;
        }
      }
    }

    return actions;
  }
}
