import * as cron from 'node-cron';
import { createLogger } from '../utils/logger.js';
import type { Agent } from '../runtime/agent.js';
import type { GoogleChatAdapter } from '../channels/google-chat.js';

const log = createLogger('Reports');

// ── Types ───────────────────────────────────────────────────

export interface ReportConfig {
    id: string;
    name: string;
    type: 'daily_summary' | 'weekly_review' | 'project_status' | 'custom';
    cronExpr: string;
    prompt: string;
    enabled: boolean;
}

// ── Prompts ─────────────────────────────────────────────────

const REPORT_PROMPTS: Record<string, string> = {
    daily_summary: `Generate a concise daily summary for the user. Include:
1. **Email highlights** — any important emails received today (use gmail_search for "newer_than:1d")
2. **Calendar** — meetings completed today and tomorrow's agenda (use calendar_list)
3. **Tasks** — completed and pending items
4. **Key metrics** — any notable numbers or updates

Format as a clean card-friendly summary. Be concise, use bullet points.`,

    weekly_review: `Generate a weekly review for the user. Include:
1. **Week in review** — major accomplishments and conversations this week
2. **Email stats** — rough count of emails sent/received this week
3. **Meetings** — how many meetings this week, any upcoming next week
4. **Open threads** — any email threads or tasks that need follow-up
5. **Next week** — key meetings and deadlines coming up

Format as a clean, scannable summary.`,

    project_status: `Generate a project status report. Include:
1. **GitHub activity** — recent commits, PRs, issues across repositories
2. **Active work** — what's currently in progress
3. **Blockers** — any known issues or blockers
4. **Next steps** — planned work items

Format as a clean status report.`,
};

// ── Report Scheduler ────────────────────────────────────────

let scheduledReports: ReportConfig[] = [];
const cronTasks = new Map<string, ReturnType<typeof cron.schedule>>();
let _agent: Agent | null = null;
let _chat: GoogleChatAdapter | null = null;

/**
 * Default reports — daily summary on weekday mornings, weekly review on Fridays
 */
const DEFAULT_REPORTS: ReportConfig[] = [
    {
        id: 'daily_summary',
        name: 'Daily Summary',
        type: 'daily_summary',
        cronExpr: '0 18 * * 1-5', // Weekdays at 6pm
        prompt: REPORT_PROMPTS.daily_summary,
        enabled: false, // Off by default — user enables via settings
    },
    {
        id: 'weekly_review',
        name: 'Weekly Review',
        type: 'weekly_review',
        cronExpr: '0 17 * * 5', // Fridays at 5pm
        prompt: REPORT_PROMPTS.weekly_review,
        enabled: false,
    },
];

/**
 * Start the report scheduler.
 */
export function startReportScheduler(agent: Agent, chat: GoogleChatAdapter): void {
    _agent = agent;
    _chat = chat;

    // Initialize with defaults if no custom reports exist
    if (scheduledReports.length === 0) {
        scheduledReports = [...DEFAULT_REPORTS];
    }

    for (const report of scheduledReports) {
        if (report.enabled) {
            scheduleReport(report);
        }
    }

    log.info(`Report scheduler started: ${scheduledReports.filter(r => r.enabled).length} active`);
}

function scheduleReport(report: ReportConfig): void {
    try {
        const task = cron.schedule(report.cronExpr, async () => {
            await generateAndSendReport(report);
        });
        cronTasks.set(report.id, task);
    } catch (err: any) {
        log.warn(`Failed to schedule report: ${report.name}`, { error: err.message });
    }
}

async function generateAndSendReport(report: ReportConfig): Promise<void> {
    if (!_agent || !_chat) return;

    log.info(`Generating report: ${report.name}`);

    try {
        const prompt = report.type === 'custom'
            ? report.prompt
            : (REPORT_PROMPTS[report.type] || report.prompt);

        const result = await _agent.processBackgroundMessage(prompt, {
            useMainProvider: true,
        });

        if (result.text && result.text.trim()) {
            await _chat.sendCard(
                `📊 ${report.name}`,
                new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
                result.text.slice(0, 1000),
            );
        }
    } catch (err: any) {
        log.error(`Report generation failed: ${report.name}`, { error: err.message });
    }
}

export function listReportConfigs(): ReportConfig[] {
    return [...scheduledReports];
}

export function toggleReport(id: string): boolean | null {
    const report = scheduledReports.find(r => r.id === id);
    if (!report) return null;

    report.enabled = !report.enabled;

    if (report.enabled && _agent) {
        scheduleReport(report);
    } else {
        const task = cronTasks.get(id);
        if (task) {
            task.stop();
            cronTasks.delete(id);
        }
    }

    return report.enabled;
}

export function runReportNow(id: string): Promise<void> {
    const report = scheduledReports.find(r => r.id === id);
    if (!report) return Promise.reject(new Error(`No report found: ${id}`));
    return generateAndSendReport(report);
}
