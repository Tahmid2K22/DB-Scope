// src/ai/watsonxClient.ts
// Dual AI engine client for DB-Scope:
// 1. IBM watsonx.ai Chat API (ibm/granite-3-3-8b-instruct) when credentials are provided.
// 2. IBM Bob Shell CLI (`bob run`) as a seamless fallback powered by BOB_API_KEY.
// All AI calls in DB-Scope go through this one module so credentials and fallbacks
// are handled transparently across the extension.

import * as vscode from 'vscode';
import fetch from 'node-fetch';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger';

const IAM_TOKEN_URL = 'https://iam.cloud.ibm.com/identity/token';
const MODEL_ID      = 'ibm/granite-3-3-8b-instruct';
const API_VERSION   = '2024-05-31';

interface IamTokenCache {
  token: string;
  expiresAt: number; // ms epoch
}

export class WatsonxClient {
  private readonly logger = Logger.getInstance();
  private tokenCache: IamTokenCache | null = null;

  private get config() {
    return vscode.workspace.getConfiguration('dbscope');
  }

  private get apiKey(): string {
    return this.config.get<string>('watsonxApiKey', '') || process.env.WATSONX_API_KEY || '';
  }

  private get projectId(): string {
    return this.config.get<string>('watsonxProjectId', '') || process.env.WATSONX_PROJECT_ID || '';
  }

  private get baseUrl(): string {
    return (this.config.get<string>('watsonxUrl', 'https://us-south.ml.cloud.ibm.com') || 'https://us-south.ml.cloud.ibm.com').replace(/\/$/, '');
  }

  private getBobApiKey(): string {
    const configKey = this.config.get<string>('bobApiKey', '');
    if (configKey) { return configKey; }

    if (process.env.BOB_API_KEY) {
      return process.env.BOB_API_KEY;
    }

    // Check workspace .env files
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
      for (const folder of folders) {
        const envPath = path.join(folder.uri.fsPath, '.env');
        if (fs.existsSync(envPath)) {
          try {
            const raw = fs.readFileSync(envPath, 'utf8');
            const match = raw.match(/^\s*BOB_API_KEY\s*=\s*(.+?)\s*$/m);
            if (match) {
              return match[1].replace(/["']/g, '').trim();
            }
          } catch { /* ignore */ }
        }
      }
    }

    return '';
  }

  // ── IAM token exchange with 50-minute cache ────────────────────────────────

  private async getIamToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now) {
      return this.tokenCache.token;
    }

    const apiKey = this.apiKey;
    if (!apiKey) {
      throw new Error(
        'DB-Scope: IBM watsonx.ai API key is not set. ' +
        'Open Settings and set "dbscope.watsonxApiKey".'
      );
    }

    const resp = await fetch(IAM_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ibm:params:oauth:grant-type:apikey&apikey=${encodeURIComponent(apiKey)}`,
    });

    if (!resp.ok) {
      throw new Error(`DB-Scope: IAM token exchange failed (${resp.status}). Check your watsonxApiKey.`);
    }

    const data = await resp.json() as { access_token: string; expires_in: number };
    // Cache for 50 minutes (token lifetime is 60 min; keep a 10-min buffer)
    this.tokenCache = {
      token: data.access_token,
      expiresAt: now + 50 * 60 * 1000,
    };
    this.logger.info('WatsonxClient: IAM token refreshed');
    return this.tokenCache.token;
  }

  // ── IBM watsonx.ai Call ───────────────────────────────────────────────────

  private async askWatsonx(systemPrompt: string, userMessage: string, maxTokens = 512): Promise<string> {
    const projectId = this.projectId;
    if (!projectId) {
      throw new Error(
        'DB-Scope: watsonx.ai project ID is not set. ' +
        'Open Settings and set "dbscope.watsonxProjectId".'
      );
    }

    const token  = await this.getIamToken();
    const url    = `${this.baseUrl}/ml/v1/text/chat?version=${API_VERSION}`;

    const body = {
      model_id:   MODEL_ID,
      project_id: projectId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage  },
      ],
      parameters: { max_new_tokens: maxTokens },
    };

    this.logger.info(`WatsonxClient: calling ${MODEL_ID} (max_new_tokens=${maxTokens})`);

    const resp = await fetch(url, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`DB-Scope: watsonx.ai call failed (${resp.status}): ${text.slice(0, 200)}`);
    }

    const data = await resp.json() as { choices: { message: { content: string } }[] };
    const content = data?.choices?.[0]?.message?.content ?? '';
    this.logger.info(`WatsonxClient: received ${content.length} chars from watsonx.ai`);
    return content;
  }

  // ── IBM Bob Shell Fallback ────────────────────────────────────────────────

  private async askBob(systemPrompt: string, userMessage: string): Promise<string> {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'cmd.exe' : 'bob';
    const args = isWin
      ? ['/c', 'bob', 'run', '--accept-license', '--trust', '-f', 'json', '--max-turns', '1']
      : ['run', '--accept-license', '--trust', '-f', 'json', '--max-turns', '1'];

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const cwd = workspaceFolders && workspaceFolders.length > 0
      ? workspaceFolders[0].uri.fsPath
      : process.cwd();

    const bobApiKey = this.getBobApiKey();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(bobApiKey ? { BOB_API_KEY: bobApiKey } : {}),
    };

    const prompt = `${systemPrompt}\n\nTask:\n${userMessage}\n\nIMPORTANT: Return ONLY the raw output or JSON specified above. No markdown fences outside the JSON.`;

    this.logger.info(`WatsonxClient: delegating query to IBM Bob Shell CLI in ${cwd}`);

    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        env,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      child.stdin.write(prompt, 'utf8');
      child.stdin.end();

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('IBM Bob Shell timed out after 60s'));
      }, 60_000);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && stdout.trim().length === 0) {
          reject(new Error(`IBM Bob Shell exited with code ${code}. ${stderr.slice(0, 300)}`));
          return;
        }

        const raw = stdout.trim();
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && typeof parsed.last_message === 'string') {
            this.logger.info(`WatsonxClient: received response from IBM Bob (${parsed.last_message.length} chars)`);
            resolve(parsed.last_message);
            return;
          }
        } catch {
          // stdout may contain non-JSON preamble
        }

        this.logger.info(`WatsonxClient: received response from IBM Bob (${raw.length} chars)`);
        resolve(raw);
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // ── Main Entry Point ───────────────────────────────────────────────────────

  /**
   * Send a system + user message to IBM AI and return the raw text response.
   * Prefers watsonx.ai Granite if configured; seamlessly falls back to IBM Bob Shell.
   */
  async ask(systemPrompt: string, userMessage: string, maxTokens = 512): Promise<string> {
    if (this.apiKey && this.projectId) {
      try {
        return await this.askWatsonx(systemPrompt, userMessage, maxTokens);
      } catch (err) {
        this.logger.warn(`WatsonxClient: watsonx.ai failed (${err}), falling back to IBM Bob Shell...`);
      }
    }

    return await this.askBob(systemPrompt, userMessage);
  }
}

// ── Singleton factory ──────────────────────────────────────────────────────

let _instance: WatsonxClient | null = null;

export function getWatsonxClient(): WatsonxClient {
  if (!_instance) { _instance = new WatsonxClient(); }
  return _instance;
}
