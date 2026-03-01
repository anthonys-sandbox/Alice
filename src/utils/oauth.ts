import { OAuth2Client } from 'google-auth-library';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import { createLogger } from './logger.js';

const log = createLogger('OAuth');
const TOKEN_PATH = './.alice-tokens.json';

interface StoredTokens {
    access_token: string;
    refresh_token: string;
    expiry_date: number;
}

/**
 * Create an OAuth2 client for authenticating against domain-restricted
 * Google Apps Script web apps.
 *
 * First run: opens browser for user to log in. Stores refresh token locally.
 * Subsequent runs: silently refreshes access token.
 */
export async function getAuthenticatedClient(
    clientId: string,
    clientSecret: string
): Promise<OAuth2Client> {
    const oauth2Client = new OAuth2Client(
        clientId,
        clientSecret,
        'http://localhost:18791/oauth2callback'
    );

    // Check for stored tokens
    if (existsSync(TOKEN_PATH)) {
        const tokens: StoredTokens = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'));
        oauth2Client.setCredentials(tokens);

        // Refresh if expired
        if (tokens.expiry_date && Date.now() > tokens.expiry_date - 60000) {
            log.info('Refreshing access token...');
            const { credentials } = await oauth2Client.refreshAccessToken();
            oauth2Client.setCredentials(credentials);
            saveTokens(credentials);
        }

        log.debug('Using stored OAuth tokens');
        return oauth2Client;
    }

    // No stored tokens — need interactive login
    log.info('No OAuth tokens found — starting browser login flow');
    await interactiveLogin(oauth2Client);
    return oauth2Client;
}

/**
 * Get a valid access token string for use in fetch headers.
 */
export async function getAccessToken(
    clientId: string,
    clientSecret: string
): Promise<string> {
    const client = await getAuthenticatedClient(clientId, clientSecret);
    const token = await client.getAccessToken();
    return token.token || '';
}

/**
 * Interactive OAuth login — opens browser, user logs in, token is stored.
 */
async function interactiveLogin(oauth2Client: OAuth2Client): Promise<void> {
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: [
            'https://www.googleapis.com/auth/spreadsheets',
            'openid',
            'https://www.googleapis.com/auth/userinfo.profile',
        ],
    });

    console.log('\n🔐 Opening browser for Google login...');
    console.log(`   If the browser doesn't open, visit: ${authUrl}\n`);

    // Try to open the browser
    try {
        const open = (await import('open')).default;
        await open(authUrl);
    } catch {
        // If open fails, user can manually visit the URL
    }

    // Start a temporary local server to capture the callback
    return new Promise<void>((resolve, reject) => {
        const server = createServer(async (req, res) => {
            try {
                const url = new URL(req.url!, `http://localhost:18791`);
                const code = url.searchParams.get('code');

                if (code) {
                    const { tokens } = await oauth2Client.getToken(code);
                    oauth2Client.setCredentials(tokens);
                    saveTokens(tokens);

                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(`
                        <html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;background:#1a1a2e;color:#e0e0e0;">
                        <div style="text-align:center">
                            <h1>✨ Alice Authenticated!</h1>
                            <p>You can close this window and return to your terminal.</p>
                        </div>
                        </body></html>
                    `);

                    log.info('OAuth tokens stored successfully');
                    server.close();
                    resolve();
                } else {
                    res.writeHead(400);
                    res.end('Missing authorization code');
                }
            } catch (err: any) {
                log.error('OAuth error', { error: err.message });
                res.writeHead(500);
                res.end('Authentication error');
                server.close();
                reject(err);
            }
        });

        server.listen(18791, () => {
            log.debug('OAuth callback server listening on :18791');
        });

        // Timeout after 2 minutes
        setTimeout(() => {
            server.close();
            reject(new Error('OAuth login timed out after 2 minutes'));
        }, 120000);
    });
}

function saveTokens(tokens: any): void {
    writeFileSync(TOKEN_PATH, JSON.stringify({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: tokens.expiry_date,
    }, null, 2));
    log.debug('Tokens saved to', { path: TOKEN_PATH });
}
