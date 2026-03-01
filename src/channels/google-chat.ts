import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { existsSync, readFileSync } from 'fs';
import { createLogger } from '../utils/logger.js';
import { getAuthenticatedClient } from '../utils/oauth.js';
import { formatForGoogleChat } from '../utils/markdown.js';
import type { Agent } from '../runtime/agent.js';

const log = createLogger('GoogleChat');

/**
 * Google Chat adapter — Google Sheets Queue Mode.
 *
 * Polls a Google Sheet for new messages using the Sheets API (OAuth2).
 * Apps Script writes incoming Chat messages to the sheet.
 * This adapter reads them, processes with the agent, and writes responses back.
 * Apps Script picks up the responses and returns them to Google Chat.
 *
 * Sheet columns: id | timestamp | sender | text | status | response
 */
export class GoogleChatAdapter {
    private sheetId: string;
    private oauthClientId: string;
    private oauthClientSecret: string;
    private agent: Agent | null = null;
    private pollInterval: ReturnType<typeof setInterval> | null = null;
    private processedIds: Set<string> = new Set();
    private chatAuth: GoogleAuth | null = null;

    constructor(
        sheetId: string,
        oauthClientId: string,
        oauthClientSecret: string,
        serviceAccountKeyPath?: string
    ) {
        this.sheetId = sheetId;
        this.oauthClientId = oauthClientId;
        this.oauthClientSecret = oauthClientSecret;

        // Set up service account auth for Chat API if key is available
        if (serviceAccountKeyPath && existsSync(serviceAccountKeyPath)) {
            try {
                const keyFile = JSON.parse(readFileSync(serviceAccountKeyPath, 'utf-8'));
                this.chatAuth = new GoogleAuth({
                    credentials: keyFile,
                    scopes: ['https://www.googleapis.com/auth/chat.bot'],
                });
                log.info('Chat API service account loaded for app-level auth');
            } catch (err: any) {
                log.warn('Failed to load service account key', { error: err.message });
            }
        }

        if (sheetId && oauthClientId && oauthClientSecret) {
            log.info('Google Chat adapter initialized (Sheets queue mode)');
        } else {
            log.warn('Google Chat not configured — set RELAY_SHEET_ID, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET in .env');
        }
    }

    setAgent(agent: Agent): void {
        this.agent = agent;
    }

    async startListening(pollMs: number = 3000): Promise<void> {
        if (!this.sheetId || !this.oauthClientId || !this.oauthClientSecret) {
            log.debug('Sheets queue not configured — skipping polling');
            return;
        }

        if (!this.agent) {
            log.error('Agent not bound — call setAgent() before startListening()');
            return;
        }

        // Verify OAuth works
        try {
            const auth = await getAuthenticatedClient(this.oauthClientId, this.oauthClientSecret);
            const sheets = google.sheets({ version: 'v4', auth });

            // Quick test — read the sheet title
            const meta = await sheets.spreadsheets.get({ spreadsheetId: this.sheetId });
            log.info(`📋 Connected to sheet: "${meta.data.properties?.title}"`);
        } catch (err: any) {
            log.error('Failed to connect to relay sheet', { error: err.message });
            return;
        }

        log.info(`🎧 Polling Google Sheet relay every ${pollMs / 1000}s`);

        // Poll immediately
        await this.poll();

        // Then on interval
        this.pollInterval = setInterval(() => this.poll(), pollMs);
    }

    stopListening(): void {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
            log.info('Stopped polling');
        }
    }

    private async poll(): Promise<void> {
        try {
            const auth = await getAuthenticatedClient(this.oauthClientId, this.oauthClientSecret);
            const sheets = google.sheets({ version: 'v4', auth });

            // Read all rows (A:G includes spaceName in column G)
            const res = await sheets.spreadsheets.values.get({
                spreadsheetId: this.sheetId,
                range: 'messages!A:G',
            });

            const rows = res.data.values || [];

            // Skip header row, find pending messages
            for (let i = 1; i < rows.length; i++) {
                const [id, _timestamp, sender, text, status, _response, spaceName] = rows[i];

                if (status !== 'pending') continue;
                if (this.processedIds.has(id)) continue;
                this.processedIds.add(id);

                // Trim processed set
                if (this.processedIds.size > 500) {
                    const arr = Array.from(this.processedIds);
                    this.processedIds = new Set(arr.slice(-250));
                }

                log.info(`💬 Message from ${sender}: ${(text || '').slice(0, 80)}`);

                if (!this.agent || !text) continue;

                let responseText: string;
                const trimmedCmd = text.trim().toLowerCase();

                // Handle chat commands
                if (trimmedCmd.startsWith('/')) {
                    const cmdResponse = await this.handleChatCommand(trimmedCmd);
                    if (cmdResponse !== null) {
                        responseText = formatForGoogleChat(cmdResponse);
                    } else {
                        // Unknown command — pass to agent
                        try {
                            const result = await this.agent.processMessage(text);
                            const toolInfo = result.toolsUsed.length > 0
                                ? `\n\n_Tools: ${result.toolsUsed.join(', ')} | Iterations: ${result.iterations}_`
                                : '';
                            responseText = formatForGoogleChat(result.text) + toolInfo;
                        } catch (err: any) {
                            log.error('Error processing message', { error: err.message });
                            responseText = `❌ Error: ${err.message}`;
                        }
                    }
                } else {
                    try {
                        const result = await this.agent.processMessage(text);
                        const toolInfo = result.toolsUsed.length > 0
                            ? `\n\n_Tools: ${result.toolsUsed.join(', ')} | Iterations: ${result.iterations}_`
                            : '';
                        responseText = formatForGoogleChat(result.text) + toolInfo;
                    } catch (err: any) {
                        log.error('Error processing message', { error: err.message });
                        responseText = `❌ Error: ${err.message}`;
                    }
                }

                // Write response back to the sheet (columns E and F of this row)
                const rowIndex = i + 1; // 1-indexed for Sheets API
                await sheets.spreadsheets.values.update({
                    spreadsheetId: this.sheetId,
                    range: `messages!E${rowIndex}:F${rowIndex}`,
                    valueInputOption: 'RAW',
                    requestBody: {
                        values: [['done', responseText]],
                    },
                });

                log.info('📨 Response written to sheet');

                // Send response directly to Google Chat if spaceName + service account available
                if (spaceName && this.chatAuth) {
                    try {
                        const client = await this.chatAuth.getClient();
                        const tokenResponse = await client.getAccessToken();
                        const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;

                        if (!token) {
                            log.error('Failed to get service account access token');
                        } else {
                            const chatUrl = `https://chat.googleapis.com/v1/${spaceName}/messages`;
                            const chatRes = await fetch(chatUrl, {
                                method: 'POST',
                                headers: {
                                    'Authorization': `Bearer ${token}`,
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({ text: responseText }),
                            });

                            if (chatRes.ok) {
                                // Mark as delivered in the sheet
                                await sheets.spreadsheets.values.update({
                                    spreadsheetId: this.sheetId,
                                    range: `messages!E${rowIndex}`,
                                    valueInputOption: 'RAW',
                                    requestBody: { values: [['delivered']] },
                                });
                                log.info('📤 Response delivered to Google Chat');
                            } else {
                                const errBody = await chatRes.text();
                                log.error('Chat API error', { status: chatRes.status, body: errBody.slice(0, 200) });
                            }
                        }
                    } catch (chatErr: any) {
                        log.error('Failed to deliver to Chat', { error: chatErr.message });
                    }
                }
            }
        } catch (err: any) {
            if (err.message && !err.message.includes('fetch failed')) {
                log.debug('Poll error (will retry)', { error: err.message });
            }
        }
    }

    async sendMessage(text: string): Promise<boolean> {
        log.info(`📤 ${text.slice(0, 100)}`);
        return true;
    }

    async sendCard(title: string, subtitle: string, text: string): Promise<boolean> {
        const formatted = `*${title}*\n_${subtitle}_\n\n${text}`;
        return this.sendMessage(formatted);
    }

    /**
     * Handle chat commands. Returns response string if handled, null otherwise.
     */
    private async handleChatCommand(command: string): Promise<string | null> {
        if (!this.agent) return null;
        const cmd = command.split(/\s+/)[0];

        switch (cmd) {
            case '/status': {
                const s = this.agent.getStatus();
                return [
                    '📊 Session Status',
                    `Session: ${s.sessionId.slice(0, 8)}...`,
                    `Messages: ${s.messageCount}`,
                    `Model: ${s.model}`,
                    `System prompt: ${s.systemPromptChars} chars`,
                    `Est. context: ~${s.estimatedTokens} tokens`,
                ].join('\n');
            }
            case '/new':
            case '/reset':
                this.agent.clearHistory();
                this.agent.refreshContext();
                return '🔄 Session reset. Fresh start!';
            case '/compact':
                return await this.agent.compactSession();
            case '/help':
                return [
                    'Available Commands:',
                    '/status — Session info',
                    '/new or /reset — Fresh session',
                    '/compact — Summarize to free context',
                    '/help — This help',
                ].join('\n');
            default:
                return null;
        }
    }
}
