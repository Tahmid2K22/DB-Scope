// src/ai/watsonxClient.ts
// Thin wrapper around the IBM watsonx.ai Chat API (ibm/granite-3-3-8b-instruct).
// All AI calls in DB-Scope go through this one module so credentials are
// configured once and token refresh is handled transparently.

import * as vscode from 'vscode';
import fetch from 'node-fetch';
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
    return this.config.get<string>('watsonxApiKey', '');
  }

  private get projectId(): string {
    return this.config.get<string>('watsonxProjectId', '');
  }

  private get baseUrl(): string {
    return this.config.get<string>('watsonxUrl', 'https://us-south.ml.cloud.ibm.com').replace(/\/$/, '');
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

  // ── Main call ──────────────────────────────────────────────────────────────

  /**
   * Send a system + user message to Granite and return the raw text response.
   * @param systemPrompt  Instruction context for the model
   * @param userMessage   The actual content / data to analyse
   * @param maxTokens     Maximum tokens to generate (default 512)
   */
  async ask(systemPrompt: string, userMessage: string, maxTokens = 512): Promise<string> {
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
    this.logger.info(`WatsonxClient: received ${content.length} chars`);
    return content;
  }
}

// ── Singleton factory ──────────────────────────────────────────────────────

let _instance: WatsonxClient | null = null;

export function getWatsonxClient(): WatsonxClient {
  if (!_instance) { _instance = new WatsonxClient(); }
  return _instance;
}
