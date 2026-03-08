import * as cron from 'node-cron';
import { createLogger } from '../utils/logger.js';
import type { Agent } from '../runtime/agent.js';
import type { GoogleChatAdapter } from '../channels/google-chat.js';

const log = createLogger('ProactiveEngine');

let proactiveTask: ReturnType<typeof cron.schedule> | null = null;
let _agent: Agent | null = null;
let _chat: GoogleChatAdapter | null = null;

// ── Pattern Detectors ──────────────────────────────────────

interface ProactiveAlert {
    shouldAlert: boolean;
    message: string;
    priority: 'low' | 'medium' | 'high';
    category: string;
}

/**
 * Post-process raw tool output into a clean, user-friendly summary.
 * Uses the main provider (Gemini) for quality formatting.
 */
async function summarizeForUser(
    agent: Agent,
    rawOutput: string,
    context: string,
): Promise<string> {
    try {
        const result = await agent.processBackgroundMessage(
            `You are formatting a proactive alert for a busy professional. Given the raw analysis below, write a SHORT, actionable summary.

RULES:
- NEVER show JSON, code, thread IDs, message IDs, or API parameters
- NEVER say "I will use" or describe what tools/functions you'll call
- Use people's NAMES and email SUBJECTS, not IDs
- Maximum 3-4 bullet points
- Each bullet should be a clear, actionable insight
- If no actionable items exist, respond with exactly: "NOTHING_ACTIONABLE"

Context: ${context}

Raw analysis:
${rawOutput}

Write the clean summary now:`,
            { useMainProvider: true },
        );
        return result.text;
    } catch {
        // If summarization fails, try to clean up the raw output
        return rawOutput
            .replace(/\{[^}]*\}/g, '')          // Remove JSON objects
            .replace(/Thread ID: \S+/g, '')      // Remove thread IDs
            .replace(/Message ID: \S+/g, '')     // Remove message IDs
            .replace(/\bfrom:me\b.*?\n?/gi, '')  // Remove query syntax
            .slice(0, 300);
    }
}

/**
 * Detect email threads with many replies that might need a call.
 */
async function staleThreadDetector(agent: Agent): Promise<ProactiveAlert> {
    try {
        const result = await agent.processBackgroundMessage(
            'Search Gmail for long email threads from the last 3 days using gmail_search with query "newer_than:3d". Find threads with 5 or more replies. For each, note the SUBJECT LINE, the PEOPLE involved, and the reply count. If none found, say "NONE_FOUND".',
            { useMainProvider: false },
        );

        if (result.text.toLowerCase().includes('none_found') ||
            result.text.toLowerCase().includes('none found') ||
            result.text.toLowerCase().includes('no problematic')) {
            return { shouldAlert: false, message: '', priority: 'low', category: 'email' };
        }

        const summary = await summarizeForUser(agent, result.text,
            'Long email threads that might benefit from a quick call instead');

        if (summary.includes('NOTHING_ACTIONABLE')) {
            return { shouldAlert: false, message: '', priority: 'low', category: 'email' };
        }

        return {
            shouldAlert: true,
            message: `📧 **Long Thread Alert**\n${summary.slice(0, 400)}`,
            priority: 'medium',
            category: 'email',
        };
    } catch {
        return { shouldAlert: false, message: '', priority: 'low', category: 'email' };
    }
}

/**
 * Detect upcoming 1:1s with people you haven't emailed recently.
 */
async function missingContextDetector(agent: Agent): Promise<ProactiveAlert> {
    try {
        const result = await agent.processBackgroundMessage(
            'Check my calendar for 1:1 meetings in the next 24 hours using calendar_list. For each meeting, tell me: the MEETING TITLE, the OTHER PERSON\'S NAME, and the TIME. Then search Gmail to see if I\'ve emailed them in the last 2 weeks. Report which meetings have NO recent email context. If all meetings have recent context, say "ALL_CONTEXT_FRESH".',
            { useMainProvider: false },
        );

        if (result.text.toLowerCase().includes('all_context_fresh') ||
            result.text.toLowerCase().includes('all context is fresh') ||
            result.text.toLowerCase().includes('no meetings')) {
            return { shouldAlert: false, message: '', priority: 'low', category: 'meetings' };
        }

        const summary = await summarizeForUser(agent, result.text,
            'Upcoming meetings where you may lack recent context with the other person');

        if (summary.includes('NOTHING_ACTIONABLE')) {
            return { shouldAlert: false, message: '', priority: 'low', category: 'meetings' };
        }

        return {
            shouldAlert: true,
            message: `📋 **Meeting Prep Needed**\n${summary.slice(0, 400)}`,
            priority: 'high',
            category: 'meetings',
        };
    } catch {
        return { shouldAlert: false, message: '', priority: 'low', category: 'meetings' };
    }
}

/**
 * Detect follow-up opportunities — sent emails with no reply after 48h.
 */
async function followUpDetector(agent: Agent): Promise<ProactiveAlert> {
    try {
        const result = await agent.processBackgroundMessage(
            'Search Gmail for emails I sent 2-4 days ago that have NOT received a reply. Use gmail_search with query "from:me older_than:2d newer_than:4d". For each unreplied email, note the RECIPIENT NAME, the SUBJECT LINE, and WHEN it was sent. If all emails got replies, say "NO_FOLLOWUPS_NEEDED".',
            { useMainProvider: false },
        );

        if (result.text.toLowerCase().includes('no_followups_needed') ||
            result.text.toLowerCase().includes('no follow-ups needed') ||
            result.text.toLowerCase().includes('no emails')) {
            return { shouldAlert: false, message: '', priority: 'low', category: 'email' };
        }

        const summary = await summarizeForUser(agent, result.text,
            'Emails you sent that haven\'t gotten a reply — consider following up');

        if (summary.includes('NOTHING_ACTIONABLE')) {
            return { shouldAlert: false, message: '', priority: 'low', category: 'email' };
        }

        return {
            shouldAlert: true,
            message: `⏰ **Follow-up Reminder**\n${summary.slice(0, 400)}`,
            priority: 'medium',
            category: 'email',
        };
    } catch {
        return { shouldAlert: false, message: '', priority: 'low', category: 'email' };
    }
}

/**
 * Monday morning weekend catch-up — summarize what happened over the weekend.
 */
async function weekendCatchup(agent: Agent): Promise<ProactiveAlert> {
    const now = new Date();
    // Only run on Mondays before noon
    if (now.getDay() !== 1 || now.getHours() >= 12) {
        return { shouldAlert: false, message: '', priority: 'low', category: 'weekend' };
    }

    try {
        const result = await agent.processBackgroundMessage(
            'Give me a weekend catch-up: search Gmail for important emails received Saturday and Sunday. Also check my calendar for today\'s meetings. Summarize: how many emails came in, any urgent ones, and today\'s schedule.',
            { useMainProvider: true },
        );

        const summary = await summarizeForUser(agent, result.text,
            'Monday morning briefing — what happened over the weekend and what\'s on today');

        return {
            shouldAlert: true,
            message: `☀️ **Monday Catch-up**\n${summary.slice(0, 600)}`,
            priority: 'low',
            category: 'weekend',
        };
    } catch {
        return { shouldAlert: false, message: '', priority: 'low', category: 'weekend' };
    }
}

// ── Engine ──────────────────────────────────────────────────

const ALL_DETECTORS = [
    { name: 'staleThreads', fn: staleThreadDetector },
    { name: 'missingContext', fn: missingContextDetector },
    { name: 'followUps', fn: followUpDetector },
    { name: 'weekendCatchup', fn: weekendCatchup },
];

/**
 * Start the proactive intelligence engine.
 * Runs every 30 minutes, cycles through pattern detectors.
 */
export function startProactiveEngine(agent: Agent, chat: GoogleChatAdapter): void {
    _agent = agent;
    _chat = chat;

    log.info('Starting proactive intelligence engine (every 30 min)');

    proactiveTask = cron.schedule('*/30 * * * *', async () => {
        log.info('Proactive scan triggered');

        for (const detector of ALL_DETECTORS) {
            try {
                const alert = await detector.fn(agent);
                if (alert.shouldAlert) {
                    log.info(`Proactive alert: ${detector.name}`, { priority: alert.priority });
                    await chat.sendCard(
                        '🔮 Proactive Alert',
                        `${alert.category} • ${alert.priority} priority`,
                        alert.message,
                    );
                }
            } catch (err: any) {
                log.warn(`Detector ${detector.name} failed`, { error: err.message });
            }
        }
    });
}

export function stopProactiveEngine(): void {
    if (proactiveTask) {
        proactiveTask.stop();
        proactiveTask = null;
        log.info('Proactive engine stopped');
    }
}

export function isProactiveEngineRunning(): boolean {
    return proactiveTask !== null;
}

export function toggleProactiveEngine(): boolean {
    if (proactiveTask) {
        stopProactiveEngine();
        return false;
    } else if (_agent && _chat) {
        startProactiveEngine(_agent, _chat);
        return true;
    }
    return false;
}
