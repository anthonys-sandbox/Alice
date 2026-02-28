import * as cron from 'node-cron';
import { loadMemory } from '../memory/index.js';
import { createLogger } from '../utils/logger.js';
import type { Agent } from '../runtime/agent.js';
import type { GoogleChatAdapter } from '../channels/google-chat.js';
import type { AliceConfig } from '../utils/config.js';

const log = createLogger('Heartbeat');

let heartbeatTask: ReturnType<typeof cron.schedule> | null = null;

/**
 * Start the heartbeat scheduler.
 * Reads HEARTBEAT.md and sends it to the agent at regular intervals.
 */
export function startHeartbeat(
    config: AliceConfig,
    agent: Agent,
    chat: GoogleChatAdapter
): void {
    const minutes = config.heartbeat.intervalMinutes;
    const cronExpr = `*/${minutes} * * * *`;

    log.info(`Starting heartbeat every ${minutes} minutes`);

    heartbeatTask = cron.schedule(cronExpr, async () => {
        log.info('Heartbeat triggered');

        try {
            // Reload memory to get latest HEARTBEAT.md
            const memory = loadMemory(config.memory.dir);

            if (!memory.heartbeat?.content) {
                log.debug('No HEARTBEAT.md found or empty — skipping');
                return;
            }

            const heartbeatPrompt = [
                'HEARTBEAT CHECK — This is an automated check triggered by your heartbeat scheduler.',
                'Review the following checklist and take any necessary actions.',
                'Report only items that need attention. If everything is fine, briefly confirm.',
                '',
                memory.heartbeat.content,
            ].join('\n');

            const response = await agent.processMessage(heartbeatPrompt);

            // Send the result to Google Chat
            if (response.text && response.text.trim()) {
                await chat.sendCard(
                    '💓 Heartbeat Report',
                    new Date().toLocaleString(),
                    response.text
                );
            }

            log.info('Heartbeat complete', { toolsUsed: response.toolsUsed.length });
        } catch (err: any) {
            log.error('Heartbeat failed', { error: err.message });
        }
    });
}

/**
 * Stop the heartbeat scheduler.
 */
export function stopHeartbeat(): void {
    if (heartbeatTask) {
        heartbeatTask.stop();
        heartbeatTask = null;
        log.info('Heartbeat stopped');
    }
}
