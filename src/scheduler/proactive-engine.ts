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
 * Detect email threads with many replies that might need a call.
 */
async function staleThreadDetector(agent: Agent): Promise<ProactiveAlert> {
    try {
        const result = await agent.processBackgroundMessage(
            'Search Gmail for email threads with 5+ replies in the last 3 days. Use gmail_search with query "newer_than:3d". Check if any threads have many replies that might benefit from a call instead. Return a brief summary of problematic threads, or say "none found" if all looks fine.',
            { useMainProvider: false }
        );
        const hasIssues = !result.text.toLowerCase().includes('none found') &&
            !result.text.toLowerCase().includes('no problematic');
        return {
            shouldAlert: hasIssues,
            message: hasIssues ? `📧 **Long Thread Alert**\n${result.text.slice(0, 400)}` : '',
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
            'Check my calendar for 1:1 meetings in the next 24 hours using calendar_list. For each meeting, search Gmail for recent emails with that person (last 2 weeks). If there are meetings where I haven\'t communicated with the attendee recently, list them. Otherwise say "all context is fresh".',
            { useMainProvider: false }
        );
        const hasIssues = !result.text.toLowerCase().includes('all context is fresh') &&
            !result.text.toLowerCase().includes('no meetings');
        return {
            shouldAlert: hasIssues,
            message: hasIssues ? `📋 **Meeting Context Gap**\n${result.text.slice(0, 400)}` : '',
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
            'Search Gmail for emails I SENT 2-4 days ago that haven\'t received a reply. Use gmail_search with query "from:me older_than:2d newer_than:4d". Check the most important ones. If any seem like they need a follow-up, list them briefly. Otherwise say "no follow-ups needed".',
            { useMainProvider: false }
        );
        const hasIssues = !result.text.toLowerCase().includes('no follow-ups needed') &&
            !result.text.toLowerCase().includes('no emails');
        return {
            shouldAlert: hasIssues,
            message: hasIssues ? `⏰ **Follow-up Reminder**\n${result.text.slice(0, 400)}` : '',
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
            'Give me a weekend catch-up: search Gmail for emails received Saturday and Sunday (use gmail_search with "newer_than:2d older_than:0d"). Also check if there are any calendar events for today. Summarize what I need to know to start the week.',
            { useMainProvider: true }
        );
        return {
            shouldAlert: true,
            message: `☀️ **Monday Catch-up**\n${result.text.slice(0, 600)}`,
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
                        alert.message
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
