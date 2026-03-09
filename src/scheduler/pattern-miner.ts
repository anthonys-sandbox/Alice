import Database from 'better-sqlite3';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';
import type { Agent } from '../runtime/agent.js';

const log = createLogger('PatternMiner');

// ── Types ───────────────────────────────────────────────────

export type EventType =
    | 'session_start'
    | 'session_end'
    | 'user_message'
    | 'tool_call'
    | 'tool_result'
    | 'email_check'
    | 'calendar_check'
    | 'automation_run'
    | 'webhook_received'
    | 'approval_granted'
    | 'approval_denied';

export interface BehaviorEvent {
    id: number;
    type: EventType;
    timestamp: string;
    hourOfDay: number;
    dayOfWeek: number;
    metadata: Record<string, any>;
}

export interface DailyPattern {
    hour: number;
    label: string;
    avgEvents: number;
    peakDay: string;
}

export interface Insight {
    category: 'productivity' | 'communication' | 'habit' | 'anomaly';
    title: string;
    description: string;
    confidence: number;   // 0-1
    lastUpdated: string;
}

export interface WeeklyDigest {
    totalEvents: number;
    activeDays: number;
    peakHour: number;
    topTools: Array<{ name: string; count: number }>;
    insights: Insight[];
    heatmap: number[][]; // 7 days × 24 hours
}

// ── Pattern Miner ───────────────────────────────────────────

export class PatternMiner {
    private db: Database.Database;
    private static MAX_EVENTS = 50_000; // Keep last 50K events

    constructor(dataDir: string) {
        this.db = new Database(join(dataDir, 'patterns.db'));
        this.db.pragma('journal_mode = WAL');
        this.ensureTables();
    }

    private ensureTables(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS behavior_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                timestamp TEXT DEFAULT (datetime('now')),
                hour_of_day INTEGER,
                day_of_week INTEGER,
                metadata TEXT DEFAULT '{}'
            );

            CREATE TABLE IF NOT EXISTS insights (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                confidence REAL DEFAULT 0.5,
                last_updated TEXT DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_events_type ON behavior_events(type);
            CREATE INDEX IF NOT EXISTS idx_events_time ON behavior_events(timestamp);
            CREATE INDEX IF NOT EXISTS idx_events_hour ON behavior_events(hour_of_day);
            CREATE INDEX IF NOT EXISTS idx_events_dow ON behavior_events(day_of_week);
        `);
    }

    // ── Event Recording ─────────────────────────────────────

    /** Record a behavioral event */
    recordEvent(type: EventType, metadata: Record<string, any> = {}): void {
        const now = new Date();
        const hourOfDay = now.getHours();
        const dayOfWeek = now.getDay(); // 0=Sun, 6=Sat

        this.db.prepare(
            'INSERT INTO behavior_events (type, hour_of_day, day_of_week, metadata) VALUES (?, ?, ?, ?)'
        ).run(type, hourOfDay, dayOfWeek, JSON.stringify(metadata));
    }

    // ── Analysis: Activity Heatmap ──────────────────────────

    /** Generate a 7×24 activity heatmap (days × hours) */
    getHeatmap(daysBack: number = 14): number[][] {
        const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString();
        const rows = this.db.prepare(
            'SELECT day_of_week, hour_of_day, COUNT(*) as cnt FROM behavior_events WHERE timestamp >= ? GROUP BY day_of_week, hour_of_day'
        ).all(cutoff) as Array<{ day_of_week: number; hour_of_day: number; cnt: number }>;

        const heatmap: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
        for (const row of rows) {
            heatmap[row.day_of_week][row.hour_of_day] = row.cnt;
        }
        return heatmap;
    }

    // ── Analysis: Peak Hours ────────────────────────────────

    /** Find the user's most active hours */
    getPeakHours(daysBack: number = 14): DailyPattern[] {
        const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString();
        const rows = this.db.prepare(
            'SELECT hour_of_day, COUNT(*) as cnt FROM behavior_events WHERE timestamp >= ? GROUP BY hour_of_day ORDER BY cnt DESC'
        ).all(cutoff) as Array<{ hour_of_day: number; cnt: number }>;

        const daysUsed = Math.max(1, Math.min(daysBack, this.getActiveDays(daysBack)));
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

        return rows.map(row => {
            // Find which day has the most events at this hour
            const dayData = this.db.prepare(
                'SELECT day_of_week, COUNT(*) as cnt FROM behavior_events WHERE timestamp >= ? AND hour_of_day = ? GROUP BY day_of_week ORDER BY cnt DESC LIMIT 1'
            ).get(cutoff, row.hour_of_day) as { day_of_week: number; cnt: number } | undefined;

            const h = row.hour_of_day;
            const label = h === 0 ? '12am' : h < 12 ? h + 'am' : h === 12 ? '12pm' : (h - 12) + 'pm';

            return {
                hour: row.hour_of_day,
                label,
                avgEvents: Math.round(row.cnt / daysUsed),
                peakDay: dayData ? dayNames[dayData.day_of_week] : '',
            };
        });
    }

    // ── Analysis: Tool Usage Patterns ────────────────────────

    /** Get most used tools with usage frequency */
    getToolPatterns(daysBack: number = 14): Array<{ name: string; count: number; lastUsed: string }> {
        const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString();
        return this.db.prepare(`
            SELECT json_extract(metadata, '$.tool') as name, COUNT(*) as count, MAX(timestamp) as lastUsed
            FROM behavior_events
            WHERE type = 'tool_call' AND timestamp >= ?
            GROUP BY name
            ORDER BY count DESC
            LIMIT 20
        `).all(cutoff) as any[];
    }

    // ── Analysis: Session Patterns ──────────────────────────

    /** Analyze average session duration and frequency */
    getSessionPatterns(daysBack: number = 14): { avgDuration: number; sessionsPerDay: number; longestStreak: number } {
        const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString();
        const starts = this.db.prepare(
            'SELECT timestamp FROM behavior_events WHERE type = ? AND timestamp >= ? ORDER BY timestamp'
        ).all('session_start', cutoff) as Array<{ timestamp: string }>;

        const ends = this.db.prepare(
            'SELECT timestamp FROM behavior_events WHERE type = ? AND timestamp >= ? ORDER BY timestamp'
        ).all('session_end', cutoff) as Array<{ timestamp: string }>;

        // Calculate durations by pairing starts and ends
        const durations: number[] = [];
        for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
            const dur = new Date(ends[i].timestamp).getTime() - new Date(starts[i].timestamp).getTime();
            if (dur > 0 && dur < 24 * 3600000) durations.push(dur);
        }

        const avgDuration = durations.length > 0
            ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 60000)
            : 0;

        const activeDays = this.getActiveDays(daysBack);
        const sessionsPerDay = activeDays > 0 ? Math.round(starts.length / activeDays * 10) / 10 : 0;

        return { avgDuration, sessionsPerDay, longestStreak: 0 };
    }

    // ── Analysis: Response Patterns ─────────────────────────

    /** Analyze message frequency by hour to find communication patterns */
    getMessagePatterns(daysBack: number = 14): { messagesPerHour: Record<number, number>; avgResponseTime: number } {
        const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString();
        const rows = this.db.prepare(
            'SELECT hour_of_day, COUNT(*) as cnt FROM behavior_events WHERE type = ? AND timestamp >= ? GROUP BY hour_of_day ORDER BY hour_of_day'
        ).all('user_message', cutoff) as Array<{ hour_of_day: number; cnt: number }>;

        const messagesPerHour: Record<number, number> = {};
        for (const row of rows) {
            messagesPerHour[row.hour_of_day] = row.cnt;
        }

        return { messagesPerHour, avgResponseTime: 0 };
    }

    // ── Insight Generation ──────────────────────────────────

    /** Generate behavioral insights from accumulated data */
    generateInsights(daysBack: number = 14): Insight[] {
        const insights: Insight[] = [];
        const peakHours = this.getPeakHours(daysBack);
        const sessionPatterns = this.getSessionPatterns(daysBack);
        const toolPatterns = this.getToolPatterns(daysBack);
        const heatmap = this.getHeatmap(daysBack);

        // Total events for confidence scaling
        const totalEvents = (this.db.prepare(
            'SELECT COUNT(*) as cnt FROM behavior_events WHERE timestamp >= ?'
        ).get(new Date(Date.now() - daysBack * 86400000).toISOString()) as any)?.cnt || 0;

        if (totalEvents < 10) return insights; // Not enough data

        const confidence = Math.min(1, totalEvents / 200); // More data = more confidence

        // 1. Peak productivity hours
        if (peakHours.length >= 3) {
            const top3 = peakHours.slice(0, 3);
            insights.push({
                category: 'productivity',
                title: 'Peak Activity Hours',
                description: `Your most active hours are ${top3.map(h => h.label).join(', ')}. Consider scheduling focused work during these times.`,
                confidence,
                lastUpdated: new Date().toISOString(),
            });
        }

        // 2. Session duration
        if (sessionPatterns.avgDuration > 0) {
            insights.push({
                category: 'productivity',
                title: 'Average Session Length',
                description: `Your average session lasts ${sessionPatterns.avgDuration} minutes with about ${sessionPatterns.sessionsPerDay} sessions per day.`,
                confidence,
                lastUpdated: new Date().toISOString(),
            });
        }

        // 3. Most relied-upon tools
        if (toolPatterns.length >= 3) {
            const top = toolPatterns.slice(0, 3);
            const friendly = top.map(t => (t.name || '').replace(/^mcp_[^_]+_/, '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
            insights.push({
                category: 'habit',
                title: 'Most Used Tools',
                description: `You rely most on: ${friendly.join(', ')}. These are your power tools.`,
                confidence,
                lastUpdated: new Date().toISOString(),
            });
        }

        // 4. Weekend vs weekday activity
        const weekdayTotal = heatmap.slice(1, 6).flat().reduce((a, b) => a + b, 0);
        const weekendTotal = (heatmap[0] || []).reduce((a, b) => a + b, 0) + (heatmap[6] || []).reduce((a, b) => a + b, 0);
        if (weekdayTotal > 0) {
            const ratio = weekendTotal / Math.max(1, weekdayTotal);
            if (ratio > 0.3) {
                insights.push({
                    category: 'habit',
                    title: 'Weekend Work Detected',
                    description: `You work on weekends at ${Math.round(ratio * 100)}% of your weekday intensity. Consider setting boundaries.`,
                    confidence,
                    lastUpdated: new Date().toISOString(),
                });
            }
        }

        // 5. Late night activity
        const lateNight = [22, 23, 0, 1, 2, 3];
        const lateTotal = heatmap.flat().length > 0
            ? lateNight.reduce((sum, h) => sum + heatmap.reduce((daySum, day) => daySum + (day[h] || 0), 0), 0)
            : 0;
        if (lateTotal > totalEvents * 0.15) {
            insights.push({
                category: 'anomaly',
                title: 'Night Owl Alert',
                description: `${Math.round(lateTotal / totalEvents * 100)}% of your activity happens after 10pm. This may impact sleep quality.`,
                confidence,
                lastUpdated: new Date().toISOString(),
            });
        }

        // Persist insights
        this.db.prepare('DELETE FROM insights').run();
        for (const insight of insights) {
            this.db.prepare(
                'INSERT INTO insights (category, title, description, confidence, last_updated) VALUES (?, ?, ?, ?, ?)'
            ).run(insight.category, insight.title, insight.description, insight.confidence, insight.lastUpdated);
        }

        return insights;
    }

    /** Get the most recent insights (from DB cache) */
    getInsights(): Insight[] {
        const rows = this.db.prepare('SELECT * FROM insights ORDER BY confidence DESC').all() as any[];
        return rows.map(r => ({
            category: r.category,
            title: r.title,
            description: r.description,
            confidence: r.confidence,
            lastUpdated: r.last_updated,
        }));
    }

    /** Get a brief context string for injection into system prompt */
    getContextSummary(): string {
        const insights = this.getInsights();
        if (insights.length === 0) return '';

        const top = insights.filter(i => i.confidence > 0.3).slice(0, 2);
        if (top.length === 0) return '';

        return top.map(i => i.description).join(' ');
    }

    // ── Weekly Digest ───────────────────────────────────────

    /** Generate a full weekly report */
    getWeeklyDigest(): WeeklyDigest {
        const daysBack = 7;
        const insights = this.generateInsights(daysBack);

        const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString();
        const totalEvents = (this.db.prepare(
            'SELECT COUNT(*) as cnt FROM behavior_events WHERE timestamp >= ?'
        ).get(cutoff) as any)?.cnt || 0;

        const peakHours = this.getPeakHours(daysBack);
        const toolPatterns = this.getToolPatterns(daysBack);

        return {
            totalEvents,
            activeDays: this.getActiveDays(daysBack),
            peakHour: peakHours[0]?.hour ?? -1,
            topTools: toolPatterns.slice(0, 5),
            insights,
            heatmap: this.getHeatmap(daysBack),
        };
    }

    // ── Helpers ─────────────────────────────────────────────

    private getActiveDays(daysBack: number): number {
        const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString();
        const row = this.db.prepare(
            "SELECT COUNT(DISTINCT DATE(timestamp)) as days FROM behavior_events WHERE timestamp >= ?"
        ).get(cutoff) as { days: number };
        return row?.days || 0;
    }

    /** Clean up old events to prevent DB growth */
    cleanup(): number {
        const result = this.db.prepare(`
            DELETE FROM behavior_events WHERE id NOT IN (
                SELECT id FROM behavior_events ORDER BY timestamp DESC LIMIT ?
            )
        `).run(PatternMiner.MAX_EVENTS);
        return result.changes;
    }

    /** Get event count for statistics */
    getStats(): { totalEvents: number; oldestEvent: string | null; daysTracked: number } {
        const row = this.db.prepare(
            'SELECT COUNT(*) as total, MIN(timestamp) as oldest FROM behavior_events'
        ).get() as { total: number; oldest: string | null };

        const daysTracked = row.oldest
            ? Math.ceil((Date.now() - new Date(row.oldest).getTime()) / 86400000)
            : 0;

        return {
            totalEvents: row.total || 0,
            oldestEvent: row.oldest,
            daysTracked,
        };
    }

    close(): void {
        this.db.close();
    }
}
