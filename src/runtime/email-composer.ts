import { createLogger } from '../utils/logger.js';
import type { Agent } from './agent.js';

const log = createLogger('EmailComposer');

interface ComposeRequest {
    to: string;
    subject?: string;
    context?: string;
    tone?: 'formal' | 'casual' | 'urgent' | 'friendly' | 'concise';
    replyToId?: string;
    threadId?: string;
    action?: 'draft' | 'send';
}

/**
 * Smart Email Composer — drafts context-aware emails with tone control.
 * Can pull thread history and recipient patterns for style matching.
 */
export async function composeEmail(agent: Agent, request: ComposeRequest): Promise<{
    to: string;
    subject: string;
    body: string;
    threadId?: string;
    action: string;
    sent?: boolean;
}> {
    const { executeTool } = await import('./tools/registry.js');

    // Gather context from thread if replying
    let threadContext = '';
    if (request.replyToId || request.threadId) {
        try {
            const thread = await executeTool('gmail_read', {
                message_id: request.replyToId || request.threadId,
            });
            threadContext = `\nExisting thread:\n${thread}\n`;
        } catch {
            log.warn('Could not fetch thread for context');
        }
    }

    // Get recent emails with this recipient for style matching
    let recipientHistory = '';
    if (request.to) {
        try {
            const recent = await executeTool('gmail_search', {
                query: `to:${request.to} OR from:${request.to}`,
                max_results: 3,
            });
            recipientHistory = `\nRecent conversation history with ${request.to}:\n${recent}\n`;
        } catch {
            // Skip if not available
        }
    }

    const toneGuidance = {
        formal: 'Use professional, polished language. Proper salutation and closing.',
        casual: 'Keep it relaxed and conversational. First-name basis.',
        urgent: 'Convey urgency clearly. Be direct and action-oriented. Use deadline language.',
        friendly: 'Warm and approachable but still professional. Show genuine interest.',
        concise: 'Extremely brief. Get straight to the point. No fluff.',
    };

    const prompt = `Draft an email with the following requirements:
To: ${request.to}
${request.subject ? `Subject: ${request.subject}` : 'Generate an appropriate subject line.'}
Tone: ${toneGuidance[request.tone || 'friendly']}
${request.context ? `Context/Instructions: ${request.context}` : ''}
${threadContext}
${recipientHistory}

Rules:
- Return ONLY the email content (no metadata)
- Match the tone precisely
- If thread context exists, make the reply coherent with the conversation
- If recipient history exists, subtly match the communication style
- Include a clear call-to-action if appropriate
- Keep formatting clean with proper paragraphing

Format your response as:
SUBJECT: <subject line>
---
<email body>`;

    const result = await agent.processBackgroundMessage(prompt, { useMainProvider: false });
    const text = result.text;

    // Parse subject and body
    const subjectMatch = text.match(/SUBJECT:\s*(.+?)(?:\n|---)/);
    const subject = subjectMatch ? subjectMatch[1].trim() : request.subject || 'No subject';
    const bodyStart = text.indexOf('---');
    const body = bodyStart >= 0 ? text.slice(bodyStart + 3).trim() : text;

    // If action is 'send', actually send it
    let sent = false;
    if (request.action === 'send') {
        try {
            await executeTool('gmail_send', {
                to: request.to,
                subject,
                body,
                ...(request.threadId ? { thread_id: request.threadId } : {}),
            });
            sent = true;
            log.info('Email sent', { to: request.to, subject });
        } catch (err: any) {
            log.error('Failed to send email', { error: err.message });
        }
    }

    return {
        to: request.to,
        subject,
        body,
        threadId: request.threadId,
        action: request.action || 'draft',
        sent,
    };
}
