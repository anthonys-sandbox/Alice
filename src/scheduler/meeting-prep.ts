import * as cron from 'node-cron';
import { createLogger } from '../utils/logger.js';
import { executeTool } from '../runtime/tools/registry.js';
import type { Agent } from '../runtime/agent.js';
import type { GoogleChatAdapter } from '../channels/google-chat.js';

const log = createLogger('MeetingPrep');

let prepTask: ReturnType<typeof cron.schedule> | null = null;
const preppedMeetings = new Set<string>(); // Track already-prepped event IDs

/**
 * Meeting Auto-Prep: runs every 15 minutes, checks upcoming meetings,
 * gathers context (Drive docs, recent emails with attendees, related tasks),
 * and posts a prep card to Google Chat 15 min before each meeting.
 */
let _agent: Agent | null = null;
let _chat: GoogleChatAdapter | null = null;

export function startMeetingPrep(agent: Agent, chat: GoogleChatAdapter): void {
    _agent = agent;
    _chat = chat;
    log.info('Starting meeting auto-prep (every 15 min)');

    prepTask = cron.schedule('*/15 * * * *', async () => {
        try {
            // Get events in the next 30 minutes
            const now = new Date();
            const soon = new Date(now.getTime() + 30 * 60_000);

            const calRaw = await executeTool('calendar_list', {
                time_min: now.toISOString(),
                time_max: soon.toISOString(),
                max_results: 5,
            });

            let events: any[] = [];
            try {
                const parsed = JSON.parse(calRaw);
                events = parsed.items || parsed.events || [];
            } catch {
                // If it's not JSON, no events
                return;
            }

            for (const event of events) {
                const eventId = event.id || event.summary;
                if (!eventId || preppedMeetings.has(eventId)) continue;

                const summary = event.summary || '(untitled)';
                const attendees = (event.attendees || [])
                    .filter((a: any) => !a.self)
                    .map((a: any) => a.email || a.displayName)
                    .slice(0, 5);

                const startTime = event.start?.dateTime
                    ? new Date(event.start.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
                    : 'All day';

                log.info(`Preparing for meeting: "${summary}" at ${startTime}`);

                // Gather context in parallel
                const [driveResults, taskResults] = await Promise.all([
                    // Search Drive for docs related to the meeting topic
                    executeTool('drive_search', { search_term: summary.replace(/[^\w\s]/g, '') }).catch(() => ''),
                    // Check related tasks
                    executeTool('tasks_list', { show_completed: false }).catch(() => ''),
                ]);

                // Search email threads with attendees (first 2)
                let emailContext = '';
                for (const attendee of attendees.slice(0, 2)) {
                    try {
                        const emails = await executeTool('gmail_search', {
                            query: `from:${attendee} newer_than:7d`,
                            max_results: 3,
                        });
                        if (emails && !emails.includes('error')) {
                            emailContext += `\nRecent from ${attendee}:\n${emails.slice(0, 500)}`;
                        }
                    } catch { /* skip */ }
                }

                // Build prep summary via LLM
                const prepPrompt = `Prepare a brief meeting prep for: "${summary}" starting at ${startTime}.
Attendees: ${attendees.length > 0 ? attendees.join(', ') : 'Unknown'}

Related Drive docs:
${driveResults.slice(0, 800) || 'None found'}

Open tasks:
${taskResults.slice(0, 600) || 'None'}

Recent email context:
${emailContext.slice(0, 800) || 'None found'}

Provide a concise prep (3-5 bullet points): key agenda items, relevant docs, things to follow up on, and any open tasks related to this meeting. Be actionable.`;

                const response = await agent.processBackgroundMessage(prepPrompt, { useMainProvider: true });

                // Send to Google Chat
                if (chat && response.text) {
                    const cardsV2 = [{
                        cardId: `meeting-prep-${eventId}`,
                        card: {
                            header: {
                                title: `📋 Meeting Prep: ${summary}`,
                                subtitle: `${startTime} · ${attendees.length} attendees`,
                            },
                            sections: [{
                                widgets: [{
                                    textParagraph: { text: response.text.slice(0, 2000) },
                                }],
                            }],
                        },
                    }];

                    try {
                        await chat.sendCardV2(cardsV2, response.text);
                        log.info(`Meeting prep sent for: "${summary}"`);
                    } catch (err: any) {
                        log.warn(`Failed to send meeting prep card: ${err.message}`);
                    }
                }

                preppedMeetings.add(eventId);

                // Cleanup old prepped meetings (keep last 50)
                if (preppedMeetings.size > 50) {
                    const entries = [...preppedMeetings];
                    for (let i = 0; i < entries.length - 50; i++) {
                        preppedMeetings.delete(entries[i]);
                    }
                }
            }
        } catch (err: any) {
            log.error('Meeting prep check failed', { error: err.message });
        }
    });
}

export function stopMeetingPrep(): void {
    if (prepTask) {
        prepTask.stop();
        prepTask = null;
        log.info('Meeting auto-prep stopped');
    }
}

export function isMeetingPrepRunning(): boolean {
    return prepTask !== null;
}

export function toggleMeetingPrep(): boolean {
    if (prepTask) {
        stopMeetingPrep();
        return false;
    } else if (_agent && _chat) {
        startMeetingPrep(_agent, _chat);
        return true;
    }
    return false;
}
