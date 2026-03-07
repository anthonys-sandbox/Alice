import * as cron from 'node-cron';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { createLogger } from '../utils/logger.js';
import type { Agent } from '../runtime/agent.js';
import type { GoogleChatAdapter } from '../channels/google-chat.js';

const log = createLogger('CronJobs');

// ============================================================
// Types
// ============================================================

export interface CronJob {
    id: string;
    name: string;
    cronExpr: string;
    prompt: string;
    isolated: boolean;
    enabled: boolean;
    lastRun: string | null;
    lastResult: string | null;
    createdAt: string;
}

interface CronJobRow {
    id: string;
    name: string;
    cron_expr: string;
    prompt: string;
    isolated: number;
    enabled: number;
    last_run: string | null;
    last_result: string | null;
    created_at: string;
}

// ============================================================
// Morning Briefing — seeded on first startup
// ============================================================

const MORNING_BRIEFING: Omit<CronJob, 'lastRun' | 'lastResult' | 'createdAt'> = {
    id: 'job_morning_brief',
    name: 'Morning Briefing',
    cronExpr: '0 7 * * 1-5', // Weekdays at 7:00 AM local time
    prompt: `You are preparing a morning briefing for Anthony. Do all of the following steps:

1. **Gmail Inbox**: Use the Gmail MCP tools to get unread emails from the last 24 hours. Summarize the top items — sender, subject, and urgency level (high / medium / low). If there are no unread emails, say so.

2. **Calendar**: Use the Google Calendar MCP tools to get today's events. List them chronologically with time, title, and any relevant details. If there are no events, say so.

3. **Weather**: Use the weather MCP tools to get today's weather forecast for these two locations:
   - Independence, MO (home) — latitude 39.0911, longitude -94.4155
   - Overland Park, KS (work) — latitude 38.9822, longitude -94.6708
   Include temperature highs/lows, conditions, and precipitation chance for each.

Format everything as a clean, scannable briefing with headers (📧 Inbox, 📅 Calendar, 🌤️ Weather) and bullet points. Keep it concise but complete. Do NOT skip any of the 3 sections.`,
    isolated: true,
    enabled: true,
};

// ============================================================
// Smart Daily Triage — runs 30 min before briefing
// ============================================================

const DAILY_TRIAGE: Omit<CronJob, 'lastRun' | 'lastResult' | 'createdAt'> = {
    id: 'job_daily_triage',
    name: 'Smart Daily Triage',
    cronExpr: '30 6 * * 1-5', // Weekdays at 6:30 AM (30 min before briefing)
    prompt: `You are Alice, Anthony's AI assistant running a daily triage. Do these steps using gws tools:

1. **Scan urgent emails**: Use gmail_search with query "is:unread is:important newer_than:1d" to find urgent unread emails. For each, use gmail_read to get the full content.

2. **Check today's calendar**: Use calendar_list to get today's events. Note any meetings in the next 2 hours that need prep.

3. **Auto-create tasks**: For any email that contains an action item, deadline, or explicit request — use tasks_create to add a task prefixed with "[TRIAGE]". Include the email subject and sender in the task notes.

4. **Summary**: Report what you found and what tasks you created. Be concise.

Only create tasks for things that genuinely require action — don't create tasks for newsletters, status updates, or FYI emails.`,
    isolated: true,
    enabled: true,
};

// ============================================================
// CronJobManager
// ============================================================

export class CronJobManager {
    private db: Database.Database;
    private tasks: Map<string, ReturnType<typeof cron.schedule>> = new Map();
    private agent: Agent | null = null;
    private chat: GoogleChatAdapter | null = null;

    constructor(dataDir: string) {
        if (!existsSync(dataDir)) {
            mkdirSync(dataDir, { recursive: true });
        }

        const dbPath = join(dataDir, 'sessions.db');
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.migrate();
        log.info('CronJobManager initialized', { path: dbPath });
    }

    // ----------------------------------------------------------
    // Schema
    // ----------------------------------------------------------

    private migrate(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS cron_jobs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                cron_expr TEXT NOT NULL,
                prompt TEXT NOT NULL,
                isolated INTEGER NOT NULL DEFAULT 1,
                enabled INTEGER NOT NULL DEFAULT 1,
                last_run TEXT,
                last_result TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `);
    }

    // ----------------------------------------------------------
    // Dependency injection
    // ----------------------------------------------------------

    setAgent(agent: Agent): void {
        this.agent = agent;
    }

    setChat(chat: GoogleChatAdapter): void {
        this.chat = chat;
    }

    // ----------------------------------------------------------
    // CRUD
    // ----------------------------------------------------------

    addJob(job: Omit<CronJob, 'lastRun' | 'lastResult' | 'createdAt'>): CronJob {
        if (!cron.validate(job.cronExpr)) {
            throw new Error(`Invalid cron expression: "${job.cronExpr}"`);
        }

        const id = job.id || `job_${Date.now().toString(36)}`;

        // Check for duplicate
        const existing = this.db.prepare('SELECT id FROM cron_jobs WHERE id = ?').get(id);
        if (existing) {
            log.debug(`Job "${id}" already exists — skipping insert`);
            return this.getJob(id)!;
        }

        this.db.prepare(`
            INSERT INTO cron_jobs (id, name, cron_expr, prompt, isolated, enabled)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, job.name, job.cronExpr, job.prompt, job.isolated ? 1 : 0, job.enabled ? 1 : 0);

        const created = this.getJob(id)!;

        // Schedule if enabled
        if (job.enabled) {
            this.scheduleJob(created);
        }

        log.info(`Cron job added: "${job.name}" (${job.cronExpr})`, { id });
        return created;
    }

    removeJob(id: string): boolean {
        // Stop the cron task
        const task = this.tasks.get(id);
        if (task) {
            task.stop();
            this.tasks.delete(id);
        }

        const result = this.db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(id);
        if (result.changes > 0) {
            log.info('Cron job removed', { id });
            return true;
        }
        return false;
    }

    pauseJob(id: string): boolean {
        const task = this.tasks.get(id);
        if (task) {
            task.stop();
            this.tasks.delete(id);
        }
        const result = this.db.prepare('UPDATE cron_jobs SET enabled = 0 WHERE id = ?').run(id);
        if (result.changes > 0) {
            log.info('Cron job paused', { id });
            return true;
        }
        return false;
    }

    resumeJob(id: string): boolean {
        const result = this.db.prepare('UPDATE cron_jobs SET enabled = 1 WHERE id = ?').run(id);
        if (result.changes > 0) {
            const job = this.getJob(id);
            if (job) {
                this.scheduleJob(job);
                log.info('Cron job resumed', { id });
            }
            return true;
        }
        return false;
    }

    getJob(id: string): CronJob | null {
        const row = this.db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id) as CronJobRow | undefined;
        return row ? this.rowToJob(row) : null;
    }

    listJobs(): CronJob[] {
        const rows = this.db.prepare('SELECT * FROM cron_jobs ORDER BY created_at').all() as CronJobRow[];
        return rows.map(r => this.rowToJob(r));
    }

    // ----------------------------------------------------------
    // Execution
    // ----------------------------------------------------------

    async runJob(id: string): Promise<string> {
        const job = this.getJob(id);
        if (!job) throw new Error(`Job not found: ${id}`);
        if (!this.agent) throw new Error('Agent not set — cannot run jobs');

        log.info(`Running cron job: "${job.name}"`, { id });

        try {
            let resultText: string;

            if (job.isolated) {
                // Isolated execution: use the full agent loop but in a temp context
                // so MCP tools are available but chat history isn't polluted
                resultText = await this.runIsolated(job);
            } else {
                // Run through normal agent (adds to conversation history)
                const response = await this.agent.processMessage(job.prompt);
                resultText = response.text;
            }

            // Update DB with result
            this.db.prepare(`
                UPDATE cron_jobs SET last_run = datetime('now'), last_result = ? WHERE id = ?
            `).run(resultText.slice(0, 2000), id);

            // Deliver to Google Chat (morning briefing sends its own card)
            if (this.chat && resultText && job.id !== 'job_morning_brief') {
                try {
                    await this.chat.sendCard(
                        `📋 ${job.name}`,
                        new Date().toLocaleString(),
                        resultText
                    );
                    log.info(`Cron job result sent to Google Chat: "${job.name}"`);
                } catch (chatErr: any) {
                    log.warn(`Failed to send cron result to Chat: ${chatErr.message}`);
                }
            }

            log.info(`Cron job completed: "${job.name}"`, { id, resultLength: resultText.length });
            return resultText;

        } catch (err: any) {
            const errorMsg = `Error: ${err.message}`;
            this.db.prepare(`
                UPDATE cron_jobs SET last_run = datetime('now'), last_result = ? WHERE id = ?
            `).run(errorMsg, id);
            log.error(`Cron job failed: "${job.name}"`, { id, error: err.message });
            return errorMsg;
        }
    }

    /**
     * Run a job in an isolated context. For the morning briefing, we call
     * MCP tools directly (much faster/more reliable than LLM tool-calling loops)
     * then pass the data to the LLM for formatting.
     */
    private async runIsolated(job: CronJob): Promise<string> {
        if (!this.agent) throw new Error('Agent not set');

        // Special handling for morning briefing — direct tool calls
        if (job.id === 'job_morning_brief') {
            return this.runMorningBriefingDirect();
        }

        // Generic jobs still use the LLM loop
        const response = await this.agent.processBackgroundMessage(job.prompt);
        return response.text;
    }

    /**
     * Run morning briefing by calling MCP tools directly, then sending a rich Card v2.
     */
    private async runMorningBriefingDirect(): Promise<string> {
        const { executeTool } = await import('../runtime/tools/registry.js');
        const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
        const dateParts: {
            weatherText: string; calendarWidgets: any[]; emailWidgets: any[]; gmailSummary: string;
            calendarSummary: string; emailDigest: string; calendarTimeline: string;
        } = {
            weatherText: '', calendarWidgets: [], emailWidgets: [], gmailSummary: '',
            calendarSummary: '', emailDigest: '', calendarTimeline: '',
        };

        // 1. Gmail — search for recent unread emails, then fetch full content
        log.info('Morning briefing: fetching Gmail...');
        try {
            const gmailResult = await executeTool('mcp_gmail_search_emails', {
                query: 'is:unread newer_than:1d',
            });

            const resultStr = typeof gmailResult === 'string' ? gmailResult : JSON.stringify(gmailResult);

            // Check for auth errors
            if (resultStr.startsWith('Error:') || resultStr.includes('No access') || resultStr.includes('refresh token')) {
                dateParts.emailWidgets = [{ textParagraph: { text: '⚠️ Gmail not connected — needs OAuth setup.' } }];
                dateParts.gmailSummary = 'Gmail not connected.';
                dateParts.emailDigest = '';
            } else {
                // Parse email IDs from text or JSON format
                let emailIds: string[] = [];
                try {
                    const parsed = JSON.parse(resultStr);
                    if (Array.isArray(parsed)) {
                        emailIds = parsed.map((e: any) => e.id).filter(Boolean);
                    }
                } catch {
                    // Text format: "ID: xxx\nSubject: ...\nFrom: ...\nDate: ...\n\nID: yyy\n..."
                    const idMatches = resultStr.match(/ID:\s*(\S+)/g) || [];
                    emailIds = idMatches.map(m => m.replace('ID:', '').trim());
                }

                if (emailIds.length === 0) {
                    dateParts.emailWidgets = [{ textParagraph: { text: 'No unread emails in the last 24 hours. 🎉' } }];
                    dateParts.gmailSummary = 'No unread emails.';
                    dateParts.emailDigest = '';
                } else {
                    // Fetch full email content for each (up to 8)
                    log.info(`Morning briefing: reading ${Math.min(emailIds.length, 8)} email bodies...`);
                    const emailDetails = await Promise.all(emailIds.slice(0, 8).map(async (id: string) => {
                        try {
                            const content = await executeTool('mcp_gmail_read_email', { messageId: id });
                            return typeof content === 'string' ? content : JSON.stringify(content);
                        } catch {
                            return `(Could not read email ${id})`;
                        }
                    }));

                    // Build decoratedText widgets for each email + digest for AI
                    const digestParts: string[] = [];
                    const summaryParts: string[] = [];
                    for (const detail of emailDetails) {
                        const subjectMatch = detail.match(/Subject:\s*(.+)/);
                        const fromMatch = detail.match(/From:\s*(.+)/);
                        const dateMatch = detail.match(/Date:\s*(.+)/);
                        const subject = subjectMatch?.[1]?.trim() || '(no subject)';
                        const from = fromMatch?.[1]?.trim() || 'Unknown';
                        const dateStr = dateMatch?.[1]?.trim() || '';
                        const senderName = from.replace(/<[^>]+>/, '').replace(/"/g, '').trim();

                        // Format time if available
                        let timeLabel = '';
                        if (dateStr) {
                            try {
                                const d = new Date(dateStr);
                                timeLabel = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
                            } catch { /* skip */ }
                        }

                        dateParts.emailWidgets.push({
                            decoratedText: {
                                topLabel: timeLabel ? `${senderName} · ${timeLabel}` : senderName,
                                text: subject,
                                wrapText: true,
                                startIcon: { knownIcon: 'EMAIL' },
                            },
                        });

                        summaryParts.push(`${subject} (from ${senderName})`);
                        digestParts.push(detail.slice(0, 400));
                    }

                    dateParts.gmailSummary = `${emailIds.length} unread: ${summaryParts.join('; ')}`;
                    dateParts.emailDigest = digestParts.join('\n---\n');
                    log.info(`Morning briefing: ${emailIds.length} emails processed for digest`);
                }
            }
        } catch (err: any) {
            dateParts.emailWidgets = [{ textParagraph: { text: '⚠️ Gmail unavailable.' } }];
            dateParts.gmailSummary = 'Gmail unavailable.';
            log.warn('Morning briefing Gmail failed', { error: err.message });
        }

        // 2. Calendar — today's remaining events only
        log.info('Morning briefing: fetching Calendar...');
        try {
            const now = new Date();
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            const startsAt = now.toISOString().split('T')[0] + 'T00:00:00Z';
            const endsAt = tomorrow.toISOString().split('T')[0] + 'T00:00:00Z';

            const calResult = await executeTool('mcp_google-calendar_list-events', {
                calendarId: 'primary',
                timeMin: startsAt,
                timeMax: endsAt,
            });
            log.info('Morning briefing Calendar raw result', { resultLength: calResult?.length, preview: calResult?.slice(0, 500) });
            const { widgets, summary, timeline } = this.buildCalendarWidgets(calResult);
            dateParts.calendarWidgets = widgets;
            dateParts.calendarSummary = summary;
            dateParts.calendarTimeline = timeline;
        } catch (err: any) {
            dateParts.calendarWidgets = [{ textParagraph: { text: 'Calendar unavailable.' } }];
            dateParts.calendarSummary = 'Calendar unavailable.';
            log.warn('Morning briefing Calendar failed', { error: err.message });
        }

        // 3. Weather — Independence MO + Overland Park KS
        log.info('Morning briefing: fetching Weather...');
        let weatherSummary = 'Weather unavailable.';
        try {
            const [weatherHome, weatherWork] = await Promise.all([
                executeTool('mcp_weather_get_weather', {
                    latitude: 39.0911, longitude: -94.4155,
                }),
                executeTool('mcp_weather_get_weather', {
                    latitude: 38.9822, longitude: -94.6708,
                }),
            ]);
            const home = this.formatWeather(weatherHome);
            const work = this.formatWeather(weatherWork);
            dateParts.weatherText = `Home: ${home}\nWork: ${work}`;
            weatherSummary = `Home: ${home} | Work: ${work}`;
        } catch (err: any) {
            dateParts.weatherText = 'Weather unavailable.';
            log.warn('Morning briefing Weather failed', { error: err.message });
        }

        // 4. Ask Gemini for AI insights: greeting, weather, calendar analysis, email highlights
        log.info('Morning briefing: AI formatting pass...');
        let greeting = `Good morning! Here's your ${date} briefing.`;
        let weatherNarrative = dateParts.weatherText;
        let calendarInsight = '';
        let emailInsight = '';

        try {
            const emailSection = dateParts.emailDigest
                ? `\n\nEMAIL CONTENT (unread, last 24h):\n${dateParts.emailDigest}`
                : '\n\nEMAIL: No unread emails or Gmail not connected.';

            const calendarSection = dateParts.calendarTimeline
                ? `\n\nCALENDAR TIMELINE:\n${dateParts.calendarTimeline}`
                : '\n\nCALENDAR: No events today.';

            const response = await this.agent!.processBackgroundMessage(
                `You are Alice, Anthony's AI assistant. Analyze today's briefing data and respond with JSON ONLY.\n` +
                `Today is ${date}. Current time: ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}.\n\n` +
                `IMPORTANT: Only use data provided below. Do NOT invent or assume any details not explicitly present.\n\n` +
                `Weather data:\n${dateParts.weatherText}` +
                calendarSection +
                emailSection +
                `\n\nRespond with ONLY this JSON (no markdown, no code fences):\n` +
                `{\n` +
                `  "greeting": "A friendly 1-sentence good morning to Anthony",\n` +
                `  "weather": "1-2 sentence conversational weather summary with temps. If weather data says unavailable, say you couldn't fetch it.",\n` +
                `  "calendarInsight": "2-3 sentences: summarize the day's meetings, note any key themes or prep needed. End with how much estimated desk/free time there is between meetings (e.g. 'You have about 2 hours of desk time between meetings today.'). If no events, say the calendar is clear.",\n` +
                `  "emailInsight": "2-4 sentences: highlight the most important emails, any action items or things needing follow-up. Be specific about what's in them, not just who sent them. If no emails provided, say inbox is clear."\n` +
                `}`,
                { useMainProvider: true }
            );
            try {
                const cleaned = (response.text || '').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                const parsed = JSON.parse(cleaned);
                if (parsed.greeting) greeting = parsed.greeting;
                if (parsed.weather) weatherNarrative = parsed.weather;
                if (parsed.calendarInsight) calendarInsight = parsed.calendarInsight;
                if (parsed.emailInsight) emailInsight = parsed.emailInsight;
            } catch {
                if (response.text && response.text.length < 300) greeting = response.text;
            }
        } catch (err: any) {
            log.warn('AI formatting failed, using defaults', { error: err.message });
        }

        // 5. Build Cards v2 payload with strong visual hierarchy
        const calendarWidgets: any[] = [];
        if (calendarInsight) {
            calendarWidgets.push({ textParagraph: { text: `💡 <i>${calendarInsight}</i>` } });
            calendarWidgets.push({ divider: {} });
        }
        calendarWidgets.push(...dateParts.calendarWidgets);

        const inboxWidgets: any[] = [];
        if (emailInsight) {
            inboxWidgets.push({ textParagraph: { text: `💡 <i>${emailInsight}</i>` } });
            inboxWidgets.push({ divider: {} });
        }
        // Add individual email decoratedText widgets
        inboxWidgets.push(...dateParts.emailWidgets);

        const cardsV2 = [{
            cardId: 'morning-briefing',
            card: {
                header: {
                    title: '☀️ Morning Briefing',
                    subtitle: date,
                },
                sections: [
                    // Greeting
                    {
                        widgets: [{
                            textParagraph: { text: `<b>${greeting}</b>` },
                        }],
                    },
                    // Weather
                    {
                        header: '🌤️ Weather',
                        widgets: [{
                            textParagraph: { text: weatherNarrative },
                        }],
                    },
                    // Calendar (AI insight + divider + events)
                    {
                        header: '📅 Today\'s Schedule',
                        collapsible: calendarWidgets.length > 7,
                        uncollapsibleWidgetsCount: 7,
                        widgets: calendarWidgets,
                    },
                    // Inbox (AI insight + divider + email list)
                    {
                        header: '📧 Inbox',
                        collapsible: inboxWidgets.length > 4,
                        uncollapsibleWidgetsCount: 4,
                        widgets: inboxWidgets,
                    },
                ],
            },
        }];

        // 6. Send card via Chat API
        const plainText = `${greeting}\n\n${weatherNarrative}\n\n${calendarInsight}\n${dateParts.calendarSummary}\n\n${emailInsight}\n${dateParts.gmailSummary}`;
        if (this.chat) {
            try {
                const sent = await this.chat.sendCardV2(cardsV2, plainText);
                if (sent) {
                    log.info('Morning briefing card sent to Chat');
                    return plainText;
                }
            } catch (err: any) {
                log.warn('Card send failed, falling back to text', { error: err.message });
            }
        }

        return plainText;
    }

    /** Build Calendar event widgets for Cards v2 */
    private buildCalendarWidgets(raw: string): { widgets: any[]; summary: string; timeline: string } {
        try {
            const data = JSON.parse(raw);
            const items = data.items || [];
            if (items.length === 0) return { widgets: [{ textParagraph: { text: 'No events today.' } }], summary: 'No events today.', timeline: '' };

            const now = new Date();
            const events = items
                .filter((e: any) => e.eventType === 'default' || !e.eventType)
                .filter((e: any) => {
                    const self = (e.attendees || []).find((a: any) => a.self);
                    return !self || self.responseStatus !== 'declined';
                })
                .filter((e: any) => {
                    const endStr = e.end?.dateTime || e.end?.date;
                    if (!endStr) return true;
                    return new Date(endStr) > now;
                })
                .sort((a: any, b: any) => {
                    const aTime = a.start?.dateTime || a.start?.date || '';
                    const bTime = b.start?.dateTime || b.start?.date || '';
                    return aTime.localeCompare(bTime);
                });

            if (events.length === 0) {
                return { widgets: [{ textParagraph: { text: 'No more meetings today. 🎉' } }], summary: 'No more meetings today.', timeline: '' };
            }

            const widgets = events.map((event: any) => {
                const summary = event.summary || '(untitled)';
                const start = event.start?.dateTime;
                const end = event.end?.dateTime;
                const selfAttendee = (event.attendees || []).find((a: any) => a.self);
                const tentative = selfAttendee?.responseStatus === 'needsAction' || selfAttendee?.responseStatus === 'tentative';

                let timeStr = 'All day';
                if (start) {
                    const fmt = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
                    const startDate = new Date(start);
                    const endDate = end ? new Date(end) : null;
                    timeStr = endDate ? `${fmt(startDate)} – ${fmt(endDate)}` : fmt(startDate);
                }

                const location = event.location ? event.location.split(',')[0] : '';
                const meetLink = event.hangoutLink || '';
                let bottomLabel = '';
                if (tentative) bottomLabel += '⏳ Tentative';
                if (location) bottomLabel += (bottomLabel ? ' · ' : '') + `📍 ${location}`;

                const widget: any = {
                    decoratedText: {
                        topLabel: timeStr,
                        text: summary,
                        wrapText: true,
                        startIcon: {
                            knownIcon: 'INVITE',
                        },
                    },
                };

                if (bottomLabel) widget.decoratedText.bottomLabel = bottomLabel;

                // Add Meet button if available
                if (meetLink) {
                    widget.decoratedText.button = {
                        text: 'Join',
                        onClick: {
                            openLink: { url: meetLink },
                        },
                    };
                }

                return widget;
            });

            // Build timeline for AI summary (includes start+end for gap calculation)
            const fmt = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
            const timelineLines = events.map((e: any) => {
                const name = e.summary || '(untitled)';
                const start = e.start?.dateTime;
                const end = e.end?.dateTime;
                if (start && end) {
                    return `${fmt(new Date(start))}-${fmt(new Date(end))}: ${name}`;
                } else if (start) {
                    return `${fmt(new Date(start))}: ${name}`;
                }
                return `All day: ${name}`;
            });
            const timeline = timelineLines.join('\n');

            const summaryLines = events.map((e: any) => {
                const name = e.summary || '(untitled)';
                const start = e.start?.dateTime;
                if (start) {
                    return `${fmt(new Date(start))}: ${name}`;
                }
                return name;
            });
            return { widgets, summary: `${events.length} events remaining:\n${summaryLines.join('\n')}`, timeline };
        } catch {
            return { widgets: [{ textParagraph: { text: 'Calendar data unavailable.' } }], summary: 'Calendar error.', timeline: '' };
        }
    }

    /** Parse Gmail search results into a clean list */
    private formatGmail(raw: string): string {
        if (raw.startsWith('Error:') || raw.includes('No access') || raw.includes('refresh token')) {
            return 'Gmail not connected — needs OAuth setup.';
        }
        try {
            const data = JSON.parse(raw);
            if (Array.isArray(data) && data.length === 0) return 'No unread emails.';
            if (Array.isArray(data)) {
                const count = data.length;
                const list = data.slice(0, 8).map((email: any) => {
                    const from = email.from || email.sender || 'Unknown';
                    const subject = email.subject || '(no subject)';
                    return `- ${subject} (from ${from})`;
                }).join('\n');
                return count > 8 ? `${count} unread emails:\n${list}\n... and ${count - 8} more` : `${count} unread:\n${list}`;
            }
            return raw.length > 500 ? raw.slice(0, 500) + '...' : raw;
        } catch {
            return raw.length > 500 ? raw.slice(0, 500) + '...' : raw;
        }
    }

    /** Parse Weather JSON into clean format with °F */
    private formatWeather(raw: string): string {
        try {
            const data = JSON.parse(raw);
            const daily = data.daily;
            if (!daily) return 'No data';

            const toF = (c: number) => Math.round(c * 9 / 5 + 32);
            const high = toF(daily.temperature_2m_max[0]);
            const low = toF(daily.temperature_2m_min[0]);
            const precip = daily.precipitation_sum?.[0] || 0;
            const code = daily.weather_code?.[0] || 0;
            const condition = this.weatherCodeToDesc(code);

            let result = `${condition} ${high}°/${low}°F`;
            if (precip > 0) result += `, ${(precip / 25.4).toFixed(1)}" rain expected`;
            return result;
        } catch {
            return raw.length > 200 ? raw.slice(0, 200) + '...' : raw;
        }
    }

    /** WMO weather code to description */
    private weatherCodeToDesc(code: number): string {
        const codes: Record<number, string> = {
            0: '☀️ Clear', 1: '🌤️ Mostly clear', 2: '⛅ Partly cloudy',
            3: '☁️ Overcast', 45: '🌫️ Foggy', 48: '🌫️ Rime fog',
            51: '🌦️ Light drizzle', 53: '🌧️ Drizzle', 55: '🌧️ Heavy drizzle',
            61: '🌦️ Light rain', 63: '🌧️ Rain', 65: '🌧️ Heavy rain',
            71: '❄️ Light snow', 73: '🌨️ Snow', 75: '🌨️ Heavy snow',
            80: '🌦️ Rain showers', 81: '🌧️ Heavy showers', 82: '⛈️ Violent showers',
            85: '🌨️ Snow showers', 86: '🌨️ Heavy snow showers',
            95: '⛈️ Thunderstorm', 96: '⛈️ T-storm + hail', 99: '⛈️ T-storm + heavy hail',
        };
        return codes[code] || `Code ${code}`;
    }

    // ----------------------------------------------------------
    // Scheduling
    // ----------------------------------------------------------

    private scheduleJob(job: CronJob): void {
        // Stop existing if any
        const existing = this.tasks.get(job.id);
        if (existing) existing.stop();

        const task = cron.schedule(job.cronExpr, async () => {
            try {
                await this.runJob(job.id);
            } catch (err: any) {
                log.error(`Scheduled job execution failed: ${job.id}`, { error: err.message });
            }
        });

        this.tasks.set(job.id, task);
        log.debug(`Job scheduled: "${job.name}" (${job.cronExpr})`, { id: job.id });
    }

    /**
     * Load all enabled jobs from DB and start their schedules.
     * Also seeds the default morning briefing if no jobs exist.
     */
    startAll(): void {
        // Seed defaults if empty
        const count = this.db.prepare('SELECT COUNT(*) as c FROM cron_jobs').get() as { c: number };
        if (count.c === 0) {
            log.info('No cron jobs found — seeding defaults');
            this.addJob(MORNING_BRIEFING);
            this.addJob(DAILY_TRIAGE);
        }

        // Schedule all enabled jobs
        const jobs = this.listJobs().filter(j => j.enabled);
        for (const job of jobs) {
            this.scheduleJob(job);
        }

        log.info(`Cron jobs started: ${jobs.length} active jobs`);
    }

    /**
     * Stop all running cron tasks.
     */
    stopAll(): void {
        for (const [id, task] of this.tasks) {
            task.stop();
            log.debug(`Job stopped: ${id}`);
        }
        this.tasks.clear();
        log.info('All cron jobs stopped');
    }

    // ----------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------

    private rowToJob(row: CronJobRow): CronJob {
        return {
            id: row.id,
            name: row.name,
            cronExpr: row.cron_expr,
            prompt: row.prompt,
            isolated: row.isolated === 1,
            enabled: row.enabled === 1,
            lastRun: row.last_run,
            lastResult: row.last_result,
            createdAt: row.created_at,
        };
    }
}

