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

// The Gemini CLI's public OAuth client ID (hardcoded in the CLI source, visible in the OAuth URL)
const CLI_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdi135j.apps.googleusercontent.com';

// Token refresh buffer — refresh 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Shape of ~/.gemini/oauth_creds.json as written by the Gemini CLI.
 * Note: client_id is NOT stored in this file — the CLI hardcodes it.
 */
interface OAuthCreds {
    access_token: string;
    refresh_token: string;
    scope: string;
    token_type: string;
    id_token?: string;
    expiry_date: number; // Unix timestamp in milliseconds
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
        const creds = JSON.parse(raw) as OAuthCreds;

        if (!creds.refresh_token) {
            log.warn('CLI creds missing refresh_token');
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
 * Uses the Gemini CLI's public OAuth client ID (PKCE flow, no client_secret needed).
 */
async function refreshAccessToken(creds: OAuthCreds): Promise<CachedToken> {
    const body = new URLSearchParams({
        client_id: CLI_CLIENT_ID,
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
 * First tries the existing access_token from the creds file,
 * then refreshes via the OAuth endpoint if expired.
 * Returns null if CLI creds aren't available.
 */
export async function getAccessToken(): Promise<string | null> {
    const creds = readCreds();
    if (!creds) return null;

    // Use cached token if still valid  
    if (cachedToken && cachedToken.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
        return cachedToken.accessToken;
    }

    // Try the existing access_token from the file if not expired
    if (creds.access_token && creds.expiry_date > Date.now() + REFRESH_BUFFER_MS) {
        cachedToken = {
            accessToken: creds.access_token,
            expiresAt: creds.expiry_date,
        };
        log.info('Using existing CLI access token', {
            expiresIn: `${Math.round((creds.expiry_date - Date.now()) / 60000)}m`,
        });
        return cachedToken.accessToken;
    }

    // Token expired — refresh it
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

