/**
 * Gemini CLI OAuth Token Manager
 * 
 * Reads cached OAuth credentials from the Gemini CLI (~/.gemini/oauth_creds.json)
 * and manages token refresh to route requests through the Code Assist API,
 * which is covered by Google AI Ultra subscriptions.
 * 
 * @see https://github.com/google-gemini/gemini-cli
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('GeminiCLI');

const OAUTH_CREDS_PATH = join(homedir(), '.gemini', 'oauth_creds.json');
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// Token refresh buffer — refresh 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface OAuthCreds {
    client_id: string;
    client_secret: string;
    refresh_token: string;
    // May also contain access_token, token_type, expiry_date etc.
    [key: string]: any;
}

interface CachedToken {
    accessToken: string;
    expiresAt: number; // Unix timestamp ms
}

let cachedToken: CachedToken | null = null;
let cachedCreds: OAuthCreds | null = null;

/**
 * Check if Gemini CLI OAuth credentials exist on this machine.
 */
export function hasCliCredentials(): boolean {
    return existsSync(OAUTH_CREDS_PATH);
}

/**
 * Read the cached OAuth credentials from ~/.gemini/oauth_creds.json.
 * Returns null if file doesn't exist or is malformed.
 */
function readCreds(): OAuthCreds | null {
    if (cachedCreds) return cachedCreds;

    if (!existsSync(OAUTH_CREDS_PATH)) {
        log.debug('No CLI credentials found', { path: OAUTH_CREDS_PATH });
        return null;
    }

    try {
        const raw = readFileSync(OAUTH_CREDS_PATH, 'utf-8');
        const creds = JSON.parse(raw);

        if (!creds.refresh_token) {
            log.warn('CLI creds missing refresh_token');
            return null;
        }
        if (!creds.client_id) {
            log.warn('CLI creds missing client_id');
            return null;
        }

        cachedCreds = creds;
        log.info('Loaded Gemini CLI OAuth credentials');
        return creds;
    } catch (err: any) {
        log.error('Failed to parse CLI credentials', { error: err.message });
        return null;
    }
}

/**
 * Exchange a refresh token for a fresh access token.
 */
async function refreshAccessToken(creds: OAuthCreds): Promise<CachedToken> {
    const body = new URLSearchParams({
        client_id: creds.client_id,
        client_secret: creds.client_secret || '',
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
        throw new Error(`Token refresh failed (${resp.status}): ${errText}`);
    }

    const data = await resp.json();
    const token: CachedToken = {
        accessToken: data.access_token,
        expiresAt: Date.now() + (data.expires_in * 1000),
    };

    log.info('Access token refreshed', {
        expiresIn: `${Math.round(data.expires_in / 60)}m`,
    });

    return token;
}

/**
 * Get a valid access token, refreshing if needed.
 * Returns null if CLI creds aren't available.
 */
export async function getAccessToken(): Promise<string | null> {
    const creds = readCreds();
    if (!creds) return null;

    // Return cached token if still valid
    if (cachedToken && cachedToken.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
        return cachedToken.accessToken;
    }

    try {
        cachedToken = await refreshAccessToken(creds);
        return cachedToken.accessToken;
    } catch (err: any) {
        log.error('Failed to refresh access token', { error: err.message });
        // Invalidate cached creds so next call re-reads the file
        cachedCreds = null;
        cachedToken = null;
        return null;
    }
}

/**
 * Invalidate cached tokens (e.g., after an API error suggesting token is bad).
 */
export function invalidateTokens(): void {
    cachedToken = null;
    cachedCreds = null;
    log.info('CLI tokens invalidated — will re-read on next request');
}
