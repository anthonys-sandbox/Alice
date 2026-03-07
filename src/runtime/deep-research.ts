import { createLogger } from '../utils/logger.js';
import { executeTool } from './tools/registry.js';
import type { Agent } from './agent.js';

const log = createLogger('DeepResearch');

export interface ResearchResult {
    query: string;
    summary: string;
    sources: Array<{ title: string; url: string; snippet: string }>;
    subQueries: string[];
    duration: number;
}

/**
 * Deep Research Agent — multi-query research orchestrator.
 * 
 * 1. LLM generates 3-5 search sub-queries from the main topic
 * 2. Runs web_search + web_fetch in parallel
 * 3. Deduplicates and cross-references sources
 * 4. LLM synthesizes findings with citations
 */
export async function deepResearch(
    query: string,
    agent: Agent,
    opts: { maxSources?: number; saveToMemory?: boolean } = {}
): Promise<ResearchResult> {
    const startTime = Date.now();
    const maxSources = opts.maxSources || 8;

    log.info('Starting deep research', { query });

    // Step 1: Generate sub-queries via LLM
    const subQueryResult = await agent.processBackgroundMessage(
        `You are a research assistant. Given this research question, generate 3-5 specific search queries that would cover different angles of the topic. Return ONLY a JSON array of strings, no explanation.

Research question: "${query}"

Example output: ["query 1", "query 2", "query 3"]`,
        { useMainProvider: false }
    );

    let subQueries: string[] = [];
    try {
        const cleaned = subQueryResult.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        subQueries = JSON.parse(cleaned);
        if (!Array.isArray(subQueries)) subQueries = [query];
    } catch {
        subQueries = [query]; // Fall back to original query
    }
    subQueries = subQueries.slice(0, 5);
    log.info('Generated sub-queries', { count: subQueries.length, queries: subQueries });

    // Step 2: Run all searches in parallel
    const searchPromises = subQueries.map(async (sq) => {
        try {
            const result = await executeTool('web_search', { query: sq });
            return { query: sq, result, error: null };
        } catch (err: any) {
            return { query: sq, result: '', error: err.message };
        }
    });
    const searchResults = await Promise.all(searchPromises);

    // Step 3: Extract URLs from search results and fetch top pages
    const allSources: Array<{ title: string; url: string; snippet: string; content: string }> = [];
    const seenUrls = new Set<string>();

    for (const sr of searchResults) {
        if (!sr.result) continue;
        // Try to extract URLs from the search result
        const urlMatches = sr.result.match(/https?:\/\/[^\s"'<>)\]]+/g) || [];
        for (const url of urlMatches.slice(0, 3)) {
            if (seenUrls.has(url) || allSources.length >= maxSources) continue;
            seenUrls.add(url);

            try {
                const content = await executeTool('web_fetch', { url, max_length: 3000 });
                const titleMatch = content.match(/^#\s+(.+)/m);
                allSources.push({
                    title: titleMatch?.[1] || url.split('/').pop() || url,
                    url,
                    snippet: content.slice(0, 200),
                    content: content.slice(0, 2000),
                });
            } catch {
                // Skip URLs that can't be fetched
                allSources.push({
                    title: url.split('/').pop() || url,
                    url,
                    snippet: sr.result.slice(0, 200),
                    content: '',
                });
            }
        }
    }

    log.info('Sources gathered', { count: allSources.length });

    // Step 4: Synthesize findings via LLM
    const sourceContext = allSources
        .map((s, i) => `[Source ${i + 1}] ${s.title}\nURL: ${s.url}\n${s.content || s.snippet}`)
        .join('\n\n---\n\n');

    const synthesisResult = await agent.processBackgroundMessage(
        `You are a research analyst. Synthesize these sources into a comprehensive, well-organized research summary.

Research question: "${query}"

Sources:
${sourceContext.slice(0, 8000)}

Instructions:
- Write a thorough summary (3-5 paragraphs)
- Cite sources using [Source N] notation
- Highlight key facts, trends, and insights
- Note any conflicting information between sources
- End with a "Key Takeaways" section (3-5 bullet points)`,
        { useMainProvider: true }
    );

    const duration = Date.now() - startTime;
    log.info('Deep research complete', { duration: `${duration}ms`, sources: allSources.length });

    // Optionally save to memory
    if (opts.saveToMemory) {
        try {
            await executeTool('remember', {
                content: `Research on "${query}": ${synthesisResult.text.slice(0, 500)}`,
                category: 'research',
            });
        } catch { /* non-critical */ }
    }

    return {
        query,
        summary: synthesisResult.text,
        sources: allSources.map(s => ({ title: s.title, url: s.url, snippet: s.snippet })),
        subQueries,
        duration,
    };
}
