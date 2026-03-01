/**
 * Code Assist API Direct Client
 * 
 * Calls Google's Code Assist API (cloudcode-pa.googleapis.com/v1internal)
 * directly using the OAuth token from Gemini CLI's login flow.
 * This is the same internal API the Gemini CLI uses for "Login with Google" auth.
 * 
 * The Code Assist API has a different request/response format from the standard
 * Gemini API — it wraps the Vertex AI request format in a project-scoped envelope.
 * 
 * @see https://github.com/google-gemini/gemini-cli
 */

import { createLogger } from '../../utils/logger.js';
import { getAccessToken } from './gemini-cli-auth.js';

const log = createLogger('CodeAssist');

const CODE_ASSIST_ENDPOINT = process.env['CODE_ASSIST_ENDPOINT'] || 'https://cloudcode-pa.googleapis.com';
const CODE_ASSIST_API_VERSION = process.env['CODE_ASSIST_API_VERSION'] || 'v1internal';

/** Cached project ID from loadCodeAssist */
let cachedProjectId: string | null = null;

/**
 * Get the base URL for Code Assist API calls.
 */
function getBaseUrl(): string {
    return `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}`;
}

/**
 * Make an authenticated POST request to the Code Assist API.
 */
async function codeAssistPost(method: string, body: any, signal?: AbortSignal): Promise<any> {
    const token = await getAccessToken();
    if (!token) throw new Error('No CLI OAuth token available');

    const url = `${getBaseUrl()}:${method}`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal,
    });

    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Code Assist API ${method} failed (${resp.status}): ${errText}`);
    }

    return resp.json();
}

/**
 * Get the project ID by calling loadCodeAssist (the CLI's onboarding endpoint).
 * The request must include metadata matching what the CLI sends.
 * The response returns the project ID in the `cloudaicompanionProject` field.
 */
export async function getProjectId(): Promise<string> {
    if (cachedProjectId) return cachedProjectId;

    // Check env vars first (avoids API call)
    const envProject = process.env['GOOGLE_CLOUD_PROJECT'] || process.env['GOOGLE_CLOUD_PROJECT_ID'];

    try {
        const resp = await codeAssistPost('loadCodeAssist', {
            cloudaicompanionProject: envProject,
            metadata: {
                ideType: 'IDE_UNSPECIFIED',
                platform: 'PLATFORM_UNSPECIFIED',
                pluginType: 'GEMINI',
                duetProject: envProject,
            },
        });

        log.debug('loadCodeAssist response', {
            keys: Object.keys(resp),
            hasCloudaicompanionProject: !!resp.cloudaicompanionProject,
            hasCurrentTier: !!resp.currentTier,
        });

        // The project ID is in the `cloudaicompanionProject` field
        const projectId = resp.cloudaicompanionProject || envProject;

        if (projectId) {
            cachedProjectId = projectId;
            const tierName = resp.paidTier?.name || resp.currentTier?.name || 'unknown';
            log.info('Code Assist project loaded', { projectId, tier: tierName });
            return projectId;
        }

        throw new Error('No project ID returned from Code Assist. Try setting GOOGLE_CLOUD_PROJECT env var.');
    } catch (err: any) {
        log.error('Failed to load Code Assist project', { error: err.message });
        throw err;
    }
}

/**
 * Map standard Gemini API model names to Code Assist-compatible short names.
 * The Code Assist API only recognizes specific model identifiers.
 */
const MODEL_MAP: Record<string, string> = {
    // Dated preview → short name
    'gemini-2.5-flash-preview-05-20': 'gemini-2.5-flash',
    'gemini-2.5-pro-preview-05-06': 'gemini-2.5-pro',
    'gemini-2.5-pro-preview-06-05': 'gemini-2.5-pro',
    // Already-correct names (passthrough)
    'gemini-2.5-flash': 'gemini-2.5-flash',
    'gemini-2.5-pro': 'gemini-2.5-pro',
    'gemini-2.5-flash-lite': 'gemini-2.5-flash-lite',
    'gemini-3-flash-preview': 'gemini-3-flash-preview',
    'gemini-3-pro-preview': 'gemini-3-pro-preview',
    'gemini-3.1-pro-preview': 'gemini-3.1-pro-preview',
};

function resolveModelForCodeAssist(model: string): string {
    const mapped = MODEL_MAP[model];
    if (mapped) return mapped;

    // Try extracting base name by removing dated suffixes like -preview-MM-DD
    const baseMatch = model.match(/^(gemini-[\d.]+-(?:flash|pro)(?:-lite)?)/);
    if (baseMatch) {
        log.info('Stripped model name to base', { from: model, to: baseMatch[1] });
        return baseMatch[1];
    }

    // Pass through as-is and hope for the best
    log.warn('Unknown model for Code Assist, passing through', { model });
    return model;
}

/**
 * Convert Alice's message format to Code Assist API request format.
 * The Code Assist API wraps the Vertex AI-format request in a project envelope.
 */
function buildCodeAssistRequest(
    model: string,
    contents: any[],
    systemInstruction: string | undefined,
    tools: any[] | undefined,
    projectId: string,
): any {
    const vertexRequest: any = {
        contents: contents.map(c => ({
            role: c.role === 'assistant' ? 'model' : c.role,
            parts: Array.isArray(c.parts) ? c.parts : [{ text: c.content || '' }],
        })),
        generationConfig: {
            temperature: 1.0,
            topP: 0.95,
        },
    };

    if (systemInstruction) {
        vertexRequest.systemInstruction = {
            parts: [{ text: systemInstruction }],
        };
    }

    if (tools && tools.length > 0) {
        vertexRequest.tools = tools;
        // Explicitly enable function calling mode
        vertexRequest.toolConfig = {
            functionCallingConfig: {
                mode: 'AUTO',
            },
        };
        // Debug: log tool names being sent
        const toolNames = tools.flatMap(t =>
            (t.functionDeclarations || []).map((fd: any) => fd.name)
        );
        log.debug('Tools included in request', {
            toolCount: toolNames.length,
            tools: toolNames.slice(0, 10).join(', '),
        });
    } else {
        log.debug('No tools included in request');
    }

    return {
        model: resolveModelForCodeAssist(model),
        project: projectId,
        user_prompt_id: `alice-${Date.now()}`,
        request: vertexRequest,
    };
}

/**
 * Call generateContent via the Code Assist API.
 * Returns the unwrapped response in standard GenAI format.
 */
export async function generateContent(
    model: string,
    contents: any[],
    systemInstruction?: string,
    tools?: any[],
): Promise<any> {
    const projectId = await getProjectId();
    const request = buildCodeAssistRequest(model, contents, systemInstruction, tools, projectId);

    const rawResp = await codeAssistPost('generateContent', request);

    // Unwrap the Code Assist envelope — the actual response is in rawResp.response
    return rawResp.response || rawResp;
}

/**
 * Call streamGenerateContent via the Code Assist API.
 * Returns an async generator of response chunks in standard GenAI format.
 * 
 * The Code Assist API returns streaming responses as a JSON array:
 * [{response: {...}, traceId: "..."}, {response: {...}, traceId: "..."}, ...]
 */
export async function* streamGenerateContent(
    model: string,
    contents: any[],
    systemInstruction?: string,
    tools?: any[],
    signal?: AbortSignal,
): AsyncGenerator<any> {
    const projectId = await getProjectId();
    const request = buildCodeAssistRequest(model, contents, systemInstruction, tools, projectId);

    const token = await getAccessToken();
    if (!token) throw new Error('No CLI OAuth token available');

    const url = `${getBaseUrl()}:streamGenerateContent`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(request),
        signal,
    });

    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Code Assist streaming failed (${resp.status}): ${errText}`);
    }

    // The Code Assist API returns a JSON array, not NDJSON.
    // Read the full body and parse as JSON array, then yield each element.
    const text = await resp.text();

    try {
        const chunks = JSON.parse(text);

        if (Array.isArray(chunks)) {
            for (const chunk of chunks) {
                const innerResponse = chunk.response || chunk;
                yield innerResponse;
            }
        } else {
            // Single object response
            const innerResponse = chunks.response || chunks;
            yield innerResponse;
        }
    } catch (err) {
        log.error('Failed to parse streaming response', {
            textLength: text.length,
            preview: text.substring(0, 200),
        });
        throw new Error(`Code Assist stream parse error: ${(err as Error).message}`);
    }
}

/**
 * Reset cached project ID (e.g., on auth errors).
 */
export function resetCodeAssistState(): void {
    cachedProjectId = null;
    log.info('Code Assist state reset');
}
