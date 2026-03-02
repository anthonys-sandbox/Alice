/**
 * OpenAI OAuth Token Manager
 * 
 * Reads cached OAuth credentials from the Codex CLI (~/.codex/auth.json)
 * or from a manual auth flow, and manages token refresh to route requests
 * through OpenAI's API using your ChatGPT subscription (Enterprise/Plus/Max).
 * 
 * Similar pattern to gemini-cli-auth.ts.
 * 
 * @see https://docs.openclaw.ai/concepts/oauth#openai-codex-chatgpt-oauth
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('OpenAI-OAuth');

// Possible credential file locations (Codex CLI stores tokens here)
const CODEX_AUTH_PATHS = [
    join(homedir(), '.codex', 'auth.json'),
    join(homedir(), '.codex', 'credentials.json'),
];

const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';

// OpenAI Codex CLI public OAuth client ID
const CODEX_CLIENT_ID = 'app_live_dXGl2f4VPwmUANzOXKHb1';

// Token refresh buffer — refresh 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Shape of Codex CLI auth.json — tokens are nested
 */
interface CodexAuthFile {
    auth_mode?: string;
    OPENAI_API_KEY?: string | null;
    tokens?: {
        access_token?: string;
        refresh_token?: string;
        id_token?: string;
        account_id?: string;
    };
    // Flat format fallback
    access_token?: string;
    refresh_token?: string;
    expires_at?: number;
    expiry_date?: number;
    last_refresh?: string;
}

interface OpenAICreds {
    access_token: string;
    refresh_token: string;
    expires_at?: number;
    expiry_date?: number;
    account_id?: string;
}

interface CachedToken {
    accessToken: string;
    expiresAt: number; // Unix timestamp ms
}

let cachedToken: CachedToken | null = null;
let cachedCreds: OpenAICreds | null = null;

/**
 * Check if Codex CLI OAuth credentials exist on this machine.
 */
export function hasCodexCredentials(): boolean {
    return CODEX_AUTH_PATHS.some(p => existsSync(p));
}

/**
 * Read the cached OAuth credentials from Codex CLI auth files.
 * Handles both nested format ({ tokens: { access_token } }) and flat format ({ access_token }).
 * Returns null if no file exists or is malformed.
 */
function readCreds(): OpenAICreds | null {
    if (cachedCreds) return cachedCreds;

    for (const authPath of CODEX_AUTH_PATHS) {
        if (!existsSync(authPath)) continue;

        try {
            const raw = readFileSync(authPath, 'utf-8');
            const file = JSON.parse(raw) as CodexAuthFile;

            // Codex CLI nests tokens under "tokens" key
            const accessToken = file.tokens?.access_token || file.access_token;
            const refreshToken = file.tokens?.refresh_token || file.refresh_token || '';

            if (!accessToken) {
                log.warn('Codex creds missing access_token', { path: authPath, keys: Object.keys(file) });
                continue;
            }

            cachedCreds = {
                access_token: accessToken,
                refresh_token: refreshToken,
                expires_at: file.expires_at,
                expiry_date: file.expiry_date,
                account_id: file.tokens?.account_id,
            };
            log.info('Loaded OpenAI Codex CLI credentials', { path: authPath, hasRefresh: !!refreshToken });
            return cachedCreds;
        } catch (err: any) {
            log.error('Failed to parse Codex credentials', { path: authPath, error: err.message });
        }
    }

    log.debug('No Codex CLI credentials found');
    return null;
}

/**
 * Exchange a refresh token for a fresh access token.
 */
async function refreshAccessToken(creds: OpenAICreds): Promise<CachedToken> {
    if (!creds.refresh_token) {
        throw new Error('No refresh token available');
    }

    const body = new URLSearchParams({
        client_id: CODEX_CLIENT_ID,
        refresh_token: creds.refresh_token,
        grant_type: 'refresh_token',
    });

    const resp = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });

    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`OpenAI token refresh failed (${resp.status}): ${errText}`);
    }

    const data = await resp.json();
    const token: CachedToken = {
        accessToken: data.access_token,
        expiresAt: Date.now() + (data.expires_in * 1000),
    };

    log.info('OpenAI access token refreshed', {
        expiresIn: `${Math.round(data.expires_in / 60)}m`,
    });

    return token;
}

/**
 * Get a valid OpenAI access token, refreshing if needed.
 * Returns null if Codex CLI creds aren't available.
 */
export async function getOpenAIAccessToken(): Promise<string | null> {
    const creds = readCreds();
    if (!creds) return null;

    // Use cached token if still valid
    if (cachedToken && cachedToken.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
        return cachedToken.accessToken;
    }

    // Try the existing access_token from the file if not expired
    const expiresAt = creds.expires_at
        ? creds.expires_at * 1000  // seconds → ms
        : creds.expiry_date || 0;

    if (creds.access_token && expiresAt > Date.now() + REFRESH_BUFFER_MS) {
        cachedToken = {
            accessToken: creds.access_token,
            expiresAt,
        };
        log.info('Using existing Codex access token', {
            expiresIn: `${Math.round((expiresAt - Date.now()) / 60000)}m`,
        });
        return cachedToken.accessToken;
    }

    // Token expired — refresh it
    if (creds.refresh_token) {
        try {
            cachedToken = await refreshAccessToken(creds);
            return cachedToken.accessToken;
        } catch (err: any) {
            log.error('Failed to refresh OpenAI access token', { error: err.message });
            cachedCreds = null;
            cachedToken = null;
            return null;
        }
    }

    // No refresh token — use access token as-is (may be an API key-style token)
    return creds.access_token || null;
}

/**
 * Synchronous version — reads the access token from file without refresh.
 * Used in constructor where async isn't available.
 * Returns null if no valid token file exists.
 */
export function getOpenAIAccessTokenSync(): string | null {
    const creds = readCreds();
    if (!creds?.access_token) return null;
    log.info('Using Codex CLI access token (sync read)');
    return creds.access_token;
}

/**
 * Invalidate cached tokens (e.g., after an API error suggesting token is bad).
 */
export function invalidateOpenAITokens(): void {
    cachedToken = null;
    cachedCreds = null;
    log.info('OpenAI tokens invalidated — will re-read on next request');
}
