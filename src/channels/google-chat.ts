import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { existsSync, readFileSync } from 'fs';
import { createLogger } from '../utils/logger.js';
import { getAuthenticatedClient } from '../utils/oauth.js';
import { formatForGoogleChat } from '../utils/markdown.js';
import type { Agent } from '../runtime/agent.js';

const log = createLogger('GoogleChat');

type RelayMode = 'firestore' | 'sheets' | 'none';

/**
 * Google Chat adapter — supports two relay modes:
 *
 * 1. **Firestore (preferred)** — real-time listener via onSnapshot, zero polling.
 *    Requires FIREBASE_PROJECT_ID + service account key.
 *    Apps Script writes to Firestore, Alice listens instantly.
 *
 * 2. **Sheets (fallback)** — polls a Google Sheet every 30s.
 *    Apps Script writes incoming Chat messages to the sheet.
 *    Higher API usage but simpler setup.
 *
 * Both modes use the Chat API directly for sending responses.
 */
export class GoogleChatAdapter {
    private sheetId: string;
    private oauthClientId: string;
    private oauthClientSecret: string;
    private firebaseProjectId: string;
    private agent: Agent | null = null;
    private pollInterval: ReturnType<typeof setInterval> | null = null;
    private processedIds: Set<string> = new Set();
    private chatAuth: GoogleAuth | null = null;
    private lastSpaceName: string | null = null;
    private relayMode: RelayMode = 'none';
    private firestoreUnsubscribe: (() => void) | null = null;

    constructor(
        sheetId: string,
        oauthClientId: string,
        oauthClientSecret: string,
        serviceAccountKeyPath?: string,
        firebaseProjectId?: string
    ) {
        this.sheetId = sheetId;
        this.oauthClientId = oauthClientId;
        this.oauthClientSecret = oauthClientSecret;
        this.firebaseProjectId = firebaseProjectId || '';

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

        // Determine relay mode
        if (this.firebaseProjectId) {
            this.relayMode = 'firestore';
            log.info('Google Chat adapter initialized (Firestore real-time mode)');
        } else if (sheetId && oauthClientId && oauthClientSecret) {
            this.relayMode = 'sheets';
            log.info('Google Chat adapter initialized (Sheets polling mode — consider migrating to Firestore)');
        } else {
            log.warn('Google Chat not configured — set FIREBASE_PROJECT_ID or RELAY_SHEET_ID in .env');
        }
    }

    setAgent(agent: Agent): void {
        this.agent = agent;
    }

    async startListening(pollMs: number = 30000): Promise<void> {
        if (!this.agent) {
            log.error('Agent not bound — call setAgent() before startListening()');
            return;
        }

        if (this.relayMode === 'firestore') {
            return this.startFirestoreListener();
        } else if (this.relayMode === 'sheets') {
            return this.startSheetsPolling(pollMs);
        } else {
            log.debug('No relay configured — skipping');
        }
    }

    stopListening(): void {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
            log.info('Stopped Sheets polling');
        }
        if (this.firestoreUnsubscribe) {
            this.firestoreUnsubscribe();
            this.firestoreUnsubscribe = null;
            log.info('Stopped Firestore listener');
        }
    }

    // ─── Firestore Real-Time Mode ──────────────────────────────────────────

    private async startFirestoreListener(): Promise<void> {
        try {
            const { initializeApp, cert, getApps } = await import('firebase-admin/app');
            const { getFirestore } = await import('firebase-admin/firestore');

            // Initialize Firebase Admin if not already initialized
            if (getApps().length === 0) {
                const saKeyPath = process.env.GOOGLE_SA_KEY_PATH;
                if (saKeyPath && existsSync(saKeyPath)) {
                    const serviceAccount = JSON.parse(readFileSync(saKeyPath, 'utf-8'));
                    initializeApp({
                        credential: cert(serviceAccount),
                        projectId: this.firebaseProjectId,
                    });
                } else {
                    // Try application default credentials
                    initializeApp({ projectId: this.firebaseProjectId });
                }
            }

            const db = getFirestore();
            const messagesRef = db.collection('alice-chat-relay');

            // Query for pending messages
            const pendingQuery = messagesRef
                .where('status', '==', 'pending')
                .orderBy('timestamp', 'asc');

            // Real-time listener — fires on new pending messages
            this.firestoreUnsubscribe = pendingQuery.onSnapshot(
                (snapshot) => {
                    snapshot.docChanges().forEach((change) => {
                        if (change.type === 'added') {
                            const data = change.doc.data();
                            const docId = change.doc.id;

                            // Skip already processed
                            if (this.processedIds.has(docId)) return;
                            this.processedIds.add(docId);

                            // Process async
                            this.processFirestoreMessage(db, docId, data).catch((err) => {
                                log.error('Firestore message processing failed', { docId, error: err.message });
                            });
                        }
                    });
                },
                (error) => {
                    log.error('Firestore listener error', { error: error.message });
                    // Attempt to reconnect after 10s
                    setTimeout(() => {
                        log.info('Attempting to reconnect Firestore listener...');
                        this.startFirestoreListener().catch(e =>
                            log.error('Firestore reconnect failed', { error: e.message })
                        );
                    }, 10000);
                }
            );

            // Trim processed set periodically
            if (this.processedIds.size > 500) {
                const arr = Array.from(this.processedIds);
                this.processedIds = new Set(arr.slice(-250));
            }

            log.info('🔥 Firestore real-time listener active — zero polling, instant message delivery');
        } catch (err: any) {
            log.error('Failed to start Firestore listener', { error: err.message });
            // Fall back to Sheets if available
            if (this.sheetId && this.oauthClientId) {
                log.warn('Falling back to Sheets polling mode');
                this.relayMode = 'sheets';
                return this.startSheetsPolling(30000);
            }
        }
    }

    private async processFirestoreMessage(
        db: FirebaseFirestore.Firestore,
        docId: string,
        data: FirebaseFirestore.DocumentData
    ): Promise<void> {
        const { sender, text, spaceName } = data;

        // Remember space name for outbound messages
        if (spaceName && !this.lastSpaceName) {
            this.lastSpaceName = spaceName;
            log.info('Learned Chat space name', { spaceName });
        }

        log.info(`💬 Message from ${sender}: ${(text || '').slice(0, 80)}`);

        if (!this.agent || !text) return;

        let responseText: string;
        const trimmedCmd = text.trim().toLowerCase();

        if (trimmedCmd.startsWith('/')) {
            const cmdResponse = await this.handleChatCommand(trimmedCmd);
            if (cmdResponse !== null) {
                responseText = formatForGoogleChat(cmdResponse);
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

        // Write response back to Firestore
        const docRef = db.collection('alice-chat-relay').doc(docId);
        await docRef.update({
            status: 'done',
            response: responseText,
            respondedAt: new Date().toISOString(),
        });

        // Send response directly via Chat API if available
        if (spaceName && this.chatAuth) {
            try {
                const client = await this.chatAuth.getClient();
                const tokenResponse = await client.getAccessToken();
                const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;

                if (token) {
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
                        await docRef.update({ status: 'delivered' });
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

        log.info('📨 Response written to Firestore');
    }

    // ─── Sheets Polling Mode (fallback) ────────────────────────────────────

    private async startSheetsPolling(pollMs: number): Promise<void> {
        if (!this.sheetId || !this.oauthClientId || !this.oauthClientSecret) {
            log.debug('Sheets queue not configured — skipping polling');
            return;
        }

        // Verify OAuth works
        try {
            const auth = await getAuthenticatedClient(this.oauthClientId, this.oauthClientSecret);
            const sheets = google.sheets({ version: 'v4', auth });

            // Quick test — read the sheet title
            const meta = await sheets.spreadsheets.get({ spreadsheetId: this.sheetId });
            log.info(`📋 Connected to sheet: "${meta.data.properties?.title}"`);

            // Discover space name from existing rows for outbound messages
            if (!this.lastSpaceName) {
                const existing = await sheets.spreadsheets.values.get({
                    spreadsheetId: this.sheetId,
                    range: 'messages!G2:G100',
                });
                const spaceRows = (existing.data.values || []).flat().filter(Boolean);
                if (spaceRows.length > 0) {
                    this.lastSpaceName = spaceRows[spaceRows.length - 1]; // latest
                    log.info('Discovered Chat space name from sheet', { spaceName: this.lastSpaceName });
                }
            }
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

                // Remember the space name for proactive outbound messages
                if (spaceName && !this.lastSpaceName) {
                    this.lastSpaceName = spaceName;
                    log.info('Learned Chat space name', { spaceName });
                }

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

    // ─── Outbound Message Sending ──────────────────────────────────────────

    async sendMessage(text: string): Promise<boolean> {
        // Try Chat API directly (service account)
        const spaceName = this.lastSpaceName || process.env.GOOGLE_CHAT_SPACE;

        if (spaceName && this.chatAuth) {
            try {
                const client = await this.chatAuth.getClient();
                const tokenResponse = await client.getAccessToken();
                const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;

                if (token) {
                    const chatUrl = `https://chat.googleapis.com/v1/${spaceName}/messages`;
                    const chatRes = await fetch(chatUrl, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ text }),
                    });

                    if (chatRes.ok) {
                        log.info(`📤 Sent to Chat: ${text.slice(0, 100)}`);
                        return true;
                    } else {
                        const errBody = await chatRes.text();
                        log.error('Chat API send failed', { status: chatRes.status, body: errBody.slice(0, 200) });
                    }
                }
            } catch (err: any) {
                log.error('Chat API send error', { error: err.message });
            }
        }

        // Fallback: write to Firestore relay
        if (this.relayMode === 'firestore' && this.firebaseProjectId) {
            try {
                const { getFirestore } = await import('firebase-admin/firestore');
                const db = getFirestore();
                const msgId = `out_${Date.now().toString(36)}`;
                await db.collection('alice-chat-relay').doc(msgId).set({
                    sender: 'Alice',
                    text: '',
                    status: 'outbound',
                    response: text,
                    timestamp: new Date().toISOString(),
                    spaceName: spaceName || '',
                });
                log.info(`📤 Wrote to Firestore relay: ${text.slice(0, 100)}`);
                return true;
            } catch (err: any) {
                log.error('Firestore relay write failed', { error: err.message });
            }
        }

        // Fallback: write to Sheets relay
        if (this.sheetId && this.oauthClientId && this.oauthClientSecret) {
            try {
                const auth = await getAuthenticatedClient(this.oauthClientId, this.oauthClientSecret);
                const sheets = google.sheets({ version: 'v4', auth });
                const msgId = `out_${Date.now().toString(36)}`;

                await sheets.spreadsheets.values.append({
                    spreadsheetId: this.sheetId,
                    range: 'messages!A:G',
                    valueInputOption: 'RAW',
                    requestBody: {
                        values: [[msgId, new Date().toISOString(), 'Alice', '', 'outbound', text, '']],
                    },
                });
                log.info(`📤 Wrote to Sheet relay: ${text.slice(0, 100)}`);
                return true;
            } catch (err: any) {
                log.error('Sheet relay write failed', { error: err.message });
            }
        }

        log.warn('No delivery method available — message not sent');
        return false;
    }

    async sendCard(title: string, subtitle: string, text: string): Promise<boolean> {
        const formatted = `*${title}*\n_${subtitle}_\n\n${text}`;
        return this.sendMessage(formatted);
    }

    /**
     * Send a Google Chat Cards v2 message.
     * @param cardsV2 - Array of Cards v2 objects (see https://developers.google.com/workspace/chat/api/reference/rest/v1/cards)
     * @param fallbackText - Plain text fallback if card delivery fails
     */
    async sendCardV2(cardsV2: any[], fallbackText?: string): Promise<boolean> {
        const spaceName = this.lastSpaceName || process.env.GOOGLE_CHAT_SPACE;

        if (spaceName && this.chatAuth) {
            try {
                const client = await this.chatAuth.getClient();
                const tokenResponse = await client.getAccessToken();
                const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;

                if (token) {
                    const chatUrl = `https://chat.googleapis.com/v1/${spaceName}/messages`;
                    const payload: any = { cardsV2 };
                    // Note: do NOT include `text` alongside cardsV2 — Google Chat
                    // renders both, creating a duplicate plain-text bubble above the card.
                    // fallbackText is only used if the card send fails entirely.

                    const chatRes = await fetch(chatUrl, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(payload),
                    });

                    if (chatRes.ok) {
                        log.info(`📤 Sent card to Chat: ${cardsV2[0]?.card?.header?.title || 'Card'}`);
                        return true;
                    } else {
                        const errBody = await chatRes.text();
                        log.error('Chat API card send failed', { status: chatRes.status, body: errBody.slice(0, 300) });
                    }
                }
            } catch (err: any) {
                log.error('Chat API card send error', { error: err.message });
            }
        }

        // Fallback to plain text
        if (fallbackText) {
            return this.sendMessage(fallbackText);
        }
        return false;
    }

    // ─── Chat Commands ─────────────────────────────────────────────────────

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
                    `Relay: ${this.relayMode}`,
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
