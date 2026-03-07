import { createLogger } from '../utils/logger.js';
import { executeTool } from './tools/registry.js';
import type { Agent } from './agent.js';

const log = createLogger('DocGenerator');

/**
 * Generate a formatted Google Document from a template type and context.
 * Uses the LLM to generate content, then creates a Google Doc via gws.
 */
export async function generateDocument(
    agent: Agent,
    type: 'proposal' | 'meeting-notes' | 'status-report' | 'memo' | 'custom',
    context: Record<string, string>
): Promise<{ title: string; docId: string; text: string }> {
    const title = context.title || `${type.replace('-', ' ')} — ${new Date().toLocaleDateString()}`;

    log.info('Generating document', { type, title });

    // Build prompt based on document type
    const typePrompts: Record<string, string> = {
        'proposal': `Write a professional project proposal with these sections:
- Executive Summary
- Problem Statement  
- Proposed Solution
- Timeline & Milestones
- Budget Considerations
- Next Steps`,
        'meeting-notes': `Write structured meeting notes with:
- Meeting Title, Date, Attendees
- Key Discussion Points
- Decisions Made
- Action Items (with owners)
- Next Steps`,
        'status-report': `Write a weekly status report with:
- Summary / TL;DR
- This Week's Accomplishments
- In Progress
- Blockers
- Next Week's Plans
- Metrics / KPIs`,
        'memo': `Write a professional memo with:
- TO / FROM / DATE / SUBJECT
- Purpose
- Background
- Key Points
- Recommendation
- Next Steps`,
        'custom': 'Write a professional, well-structured document.',
    };

    // Gather real data if context specifies data sources
    let dataContext = '';
    if (context.email_query) {
        try {
            const emails = await executeTool('gmail_search', { query: context.email_query, max_results: 5 });
            dataContext += `\n\nEmail data:\n${emails}`;
        } catch { /* non-critical */ }
    }
    if (context.calendar_range) {
        try {
            const events = await executeTool('calendar_list', { time_min: context.calendar_range, max_results: 20 });
            dataContext += `\n\nCalendar data:\n${events}`;
        } catch { /* non-critical */ }
    }

    // Generate document content via LLM
    const result = await agent.processBackgroundMessage(
        `${typePrompts[type] || typePrompts['custom']}

Topic/Context: ${context.topic || context.description || title}
${context.details ? `\nAdditional details: ${context.details}` : ''}
${dataContext}

Write the complete document. Use markdown formatting (headers, bullet points, bold).
Make it professional, thorough, and ready to share.`,
        { useMainProvider: true }
    );

    // Create the Google Doc
    let docId = '';
    try {
        const docResult = await executeTool('docs_create', { title });
        const parsed = JSON.parse(docResult);
        docId = parsed.documentId || parsed.id || '';
    } catch (err: any) {
        log.warn('Could not create Google Doc', { error: err.message });
    }

    // Append content to the doc if created
    if (docId) {
        try {
            await executeTool('docs_append', { document_id: docId, content: result.text });
        } catch { /* doc exists but append may not work — content returned in text */ }
    }

    log.info('Document generated', { type, title, docId });

    return { title, docId, text: result.text };
}
