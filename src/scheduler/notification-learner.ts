import Database from 'better-sqlite3';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('NotificationLearner');

/**
 * Learns from user interactions with notifications to improve urgency classification.
 * Tracks which alerts the user acts on vs. dismisses.
 */
export class NotificationLearner {
    private db: Database.Database;

    constructor(dataDir: string) {
        this.db = new Database(join(dataDir, 'notification_learning.db'));
        this.db.pragma('journal_mode = WAL');

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS notification_feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                alert_id TEXT NOT NULL,
                category TEXT NOT NULL,
                priority TEXT NOT NULL,
                sender TEXT,
                subject TEXT,
                action TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS user_preferences (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT DEFAULT (datetime('now'))
            );
        `);

        // Seed defaults
        this.ensurePreference('quiet_hours_start', '22:00');
        this.ensurePreference('quiet_hours_end', '07:00');
        this.ensurePreference('focus_mode', 'false');
        this.ensurePreference('batch_digest', 'false');

        log.info('Notification learner initialized');
    }

    private ensurePreference(key: string, defaultValue: string): void {
        const existing = this.db.prepare('SELECT value FROM user_preferences WHERE key = ?').get(key);
        if (!existing) {
            this.db.prepare('INSERT INTO user_preferences (key, value) VALUES (?, ?)').run(key, defaultValue);
        }
    }

    /**
     * Record user feedback on a notification.
     */
    recordFeedback(alertId: string, category: string, priority: string, action: 'acted' | 'dismissed' | 'snoozed', sender?: string, subject?: string): void {
        this.db.prepare(
            'INSERT INTO notification_feedback (alert_id, category, priority, sender, action, subject) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(alertId, category, priority, sender || null, action, subject || null);
    }

    /**
     * Get learned urgency weights for a category.
     * Returns a multiplier: >1 means user cares more, <1 means user cares less.
     */
    getUrgencyWeight(category: string): number {
        const stats = this.db.prepare(`
            SELECT 
                COUNT(CASE WHEN action = 'acted' THEN 1 END) as acted,
                COUNT(CASE WHEN action = 'dismissed' THEN 1 END) as dismissed,
                COUNT(*) as total
            FROM notification_feedback 
            WHERE category = ? AND created_at > datetime('now', '-30 days')
        `).get(category) as any;

        if (!stats || stats.total < 3) return 1.0; // Not enough data
        return stats.acted / (stats.total || 1);
    }

    /**
     * Should we send notifications right now?
     */
    shouldNotify(): boolean {
        const focusMode = this.getPreference('focus_mode');
        if (focusMode === 'true') return false;

        const now = new Date();
        const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const quietStart = this.getPreference('quiet_hours_start') || '22:00';
        const quietEnd = this.getPreference('quiet_hours_end') || '07:00';

        if (quietStart < quietEnd) {
            return currentTime < quietStart || currentTime >= quietEnd;
        } else {
            // Wraps midnight
            return currentTime < quietStart && currentTime >= quietEnd;
        }
    }

    /**
     * Get a user preference.
     */
    getPreference(key: string): string {
        const row = this.db.prepare('SELECT value FROM user_preferences WHERE key = ?').get(key) as any;
        return row?.value || '';
    }

    /**
     * Set a user preference.
     */
    setPreference(key: string, value: string): void {
        this.db.prepare(
            'INSERT OR REPLACE INTO user_preferences (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))'
        ).run(key, value);
    }

    /**
     * Get notification stats for display.
     */
    getStats(): { totalFeedback: number; actRate: number; topCategories: Array<{ category: string; acted: number; dismissed: number }> } {
        const total = (this.db.prepare('SELECT COUNT(*) as c FROM notification_feedback').get() as any).c;
        const acted = (this.db.prepare("SELECT COUNT(*) as c FROM notification_feedback WHERE action = 'acted'").get() as any).c;

        const categories = this.db.prepare(`
            SELECT category,
                COUNT(CASE WHEN action = 'acted' THEN 1 END) as acted,
                COUNT(CASE WHEN action = 'dismissed' THEN 1 END) as dismissed
            FROM notification_feedback
            GROUP BY category
            ORDER BY COUNT(*) DESC
            LIMIT 5
        `).all() as any[];

        return {
            totalFeedback: total,
            actRate: total > 0 ? acted / total : 0,
            topCategories: categories,
        };
    }

    close(): void {
        this.db.close();
    }
}
