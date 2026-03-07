import * as cron from 'node-cron';
import { createLogger } from '../utils/logger.js';
import { executeTool } from '../runtime/tools/registry.js';
import type { Agent } from '../runtime/agent.js';
import type { GoogleChatAdapter } from '../channels/google-chat.js';

const log = createLogger('EmailWatcher');

let watchTask: ReturnType<typeof cron.schedule> | null = null;
let lastCheckTime: string | null = null;

/**
 * Email Watch & Alerts: polls Gmail every 2 minutes for new urgent emails.
 * Classifies urgency via background LLM, alerts in Google Chat for urgent items.
 */
let _agent: Agent | null = null;
let _chat: GoogleChatAdapter | null = null;

export function startEmailWatcher(agent: Agent, chat: GoogleChatAdapter): void {
    _agent = agent;
    _chat = chat;
    log.info('Starting email watcher (every 2 min)');

    // Initialize with current time so we don't alert on old emails
    lastCheckTime = new Date().toISOString();

    watchTask = cron.schedule('*/2 * * * *', async () => {
        try {
            // Search for new unread emails since last check
            const query = lastCheckTime
                ? `is:unread after:${Math.floor(new Date(lastCheckTime).getTime() / 1000)}`
                : 'is:unread newer_than:5m';

            const result = await executeTool('gmail_search', {
                query,
                max_results: 5,
            });

            lastCheckTime = new Date().toISOString();

            // Parse results
            let messages: any[] = [];
            try {
                const parsed = JSON.parse(result);
                messages = parsed.messages || [];
            } catch {
                // Not JSON or no messages
                return;
            }

            if (messages.length === 0) return;

            log.info(`Email watcher: ${messages.length} new message(s) found`);

            // Read each message and classify urgency
            for (const msg of messages.slice(0, 3)) {
                try {
                    const detail = await executeTool('gmail_read', { message_id: msg.id });

                    // Quick urgency classification via background model
                    const classifyResult = await agent.processBackgroundMessage(
                        `Classify this email's urgency as HIGH, MEDIUM, or LOW. Respond with JSON only: {"urgency": "HIGH|MEDIUM|LOW", "reason": "brief explanation", "suggested_action": "what to do"}\n\nEmail:\n${detail.slice(0, 1500)}`,
                        { useMainProvider: false }
                    );

                    let urgency = 'LOW';
                    let reason = '';
                    let action = '';
                    try {
                        const cleaned = classifyResult.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                        const parsed = JSON.parse(cleaned);
                        urgency = parsed.urgency || 'LOW';
                        reason = parsed.reason || '';
                        action = parsed.suggested_action || '';
                    } catch { /* default to LOW */ }

                    // Only alert for HIGH urgency
                    if (urgency === 'HIGH' && chat) {
                        const subjectMatch = detail.match(/Subject:\s*(.+)/);
                        const fromMatch = detail.match(/From:\s*(.+)/);
                        const subject = subjectMatch?.[1]?.trim() || '(no subject)';
                        const from = fromMatch?.[1]?.trim() || 'Unknown';
                        const snippet = detail.slice(0, 300).replace(/\n/g, ' ');

                        const cardsV2 = [{
                            cardId: `email-alert-${msg.id}`,
                            card: {
                                header: {
                                    title: '🚨 Urgent Email Alert',
                                    subtitle: `From: ${from.replace(/<[^>]+>/, '').trim()}`,
                                },
                                sections: [{
                                    widgets: [
                                        { decoratedText: { topLabel: 'Subject', text: subject, wrapText: true, startIcon: { knownIcon: 'EMAIL' } } },
                                        { textParagraph: { text: `<b>Why urgent:</b> ${reason}` } },
                                        { textParagraph: { text: `<b>Suggested action:</b> ${action}` } },
                                        { textParagraph: { text: `<i>${snippet}...</i>` } },
                                    ],
                                }],
                            },
                        }];

                        try {
                            await chat.sendCardV2(cardsV2, `🚨 Urgent: ${subject} from ${from}`);
                            log.info(`Urgent email alert sent: "${subject}"`);
                        } catch (err: any) {
                            log.warn(`Failed to send email alert: ${err.message}`);
                        }
                    }
                } catch (err: any) {
                    log.warn(`Failed to process email ${msg.id}: ${err.message}`);
                }
            }
        } catch (err: any) {
            log.error('Email watcher check failed', { error: err.message });
        }
    });
}

export function stopEmailWatcher(): void {
    if (watchTask) {
        watchTask.stop();
        watchTask = null;
        log.info('Email watcher stopped');
    }
}

export function isEmailWatcherRunning(): boolean {
    return watchTask !== null;
}

export function toggleEmailWatcher(): boolean {
    if (watchTask) {
        stopEmailWatcher();
        return false;
    } else if (_agent && _chat) {
        startEmailWatcher(_agent, _chat);
        return true;
    }
    return false;
}
