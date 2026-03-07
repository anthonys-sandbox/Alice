import { createLogger } from '../utils/logger.js';
import { executeTool } from './tools/registry.js';
import type { Agent } from './agent.js';

const log = createLogger('PeopleIntel');

export interface PersonBrief {
    email: string;
    name?: string;
    emailHistory: string;
    meetingFrequency: string;
    sharedDocs: string;
    contactInfo: string;
    lastInteraction: string;
}

/**
 * Generate a comprehensive brief on a person based on email, calendar, drive, and contacts data.
 */
export async function briefPerson(agent: Agent, identifier: string): Promise<PersonBrief> {
    log.info('Generating person brief', { identifier });

    // Gather data from multiple sources in parallel
    const [emailData, calData, driveData, contactData] = await Promise.all([
        executeTool('gmail_search', { query: identifier, max_results: 10 }).catch(() => 'No email data'),
        executeTool('calendar_list', { max_results: 30, time_min: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString() }).catch(() => 'No calendar data'),
        executeTool('drive_search', { search_term: identifier }).catch(() => 'No drive data'),
        executeTool('contacts_search', { query: identifier, max_results: 3 }).catch(() => 'No contact data'),
    ]);

    // Use LLM to synthesize into a structured brief
    const result = await agent.processBackgroundMessage(
        `Create a comprehensive person brief for "${identifier}". Analyze this data and summarize:

EMAIL HISTORY:
${emailData}

CALENDAR (last 90 days):
${calData}

SHARED DRIVE FILES:
${driveData}

CONTACT INFO:
${contactData}

Provide:
1. Who this person is (name, org, role if discernible)
2. Email communication: frequency, topics, tone
3. Meeting history: how often you meet, last meeting
4. Shared documents: what you collaborate on
5. Last interaction date and what it was about
6. Key context for your next interaction with them

Be concise but thorough. Use emoji for readability.`,
        { useMainProvider: true }
    );

    return {
        email: identifier,
        emailHistory: emailData.slice(0, 500),
        meetingFrequency: 'See synthesis',
        sharedDocs: driveData.slice(0, 500),
        contactInfo: contactData.slice(0, 500),
        lastInteraction: 'See synthesis',
        name: result.text.match(/name[:\s]*([^\n,]+)/i)?.[1] || undefined,
    };
}

/**
 * Analyze relationship health across contacts.
 */
export async function relationshipHealth(agent: Agent): Promise<string> {
    log.info('Running relationship health check');

    const result = await agent.processBackgroundMessage(
        `Perform a relationship health check:
1. Use gmail_search to find frequent contacts (from:me newer_than:30d) 
2. Use gmail_search to find people I haven't replied to (is:unread label:inbox older_than:7d)
3. Use calendar_list to check who I meet with regularly vs. rarely

Categorize contacts into:
- 🟢 Strong (frequent email + meetings in last 2 weeks)
- 🟡 Cooling (no interaction in 2-4 weeks)  
- 🔴 Going Cold (no interaction in 30+ days despite prior frequency)

List the top 5 contacts in each category. For 🔴 contacts, suggest a re-engagement action.`,
        { useMainProvider: true }
    );

    return result.text;
}
