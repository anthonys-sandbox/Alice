import { GoogleGenAI } from '@google/genai';
import { createLogger } from '../../utils/logger.js';
import type { AliceConfig } from '../../utils/config.js';

const log = createLogger('Gemini');

export interface LLMMessage {
    role: 'user' | 'model';
    parts: LLMPart[];
}

export type LLMPart =
    | { text: string }
    | { functionCall: { name: string; args: Record<string, any> } }
    | { functionResponse: { name: string; response: { result: any } } };

export interface FunctionDeclaration {
    name: string;
    description: string;
    parameters: Record<string, any>;
}

export interface LLMResponse {
    text: string | null;
    functionCalls: Array<{ name: string; args: Record<string, any> }> | null;
    rawParts: any[]; // Raw parts from the model — preserves thought_signature
    rawResponse: any;
}

export class GeminiProvider {
    private ai: GoogleGenAI;
    private model: string;

    constructor(config: AliceConfig) {
        if (!config.gemini.apiKey) {
            throw new Error('GEMINI_API_KEY is required. Set it in .env or alice.config.json');
        }

        this.ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
        this.model = config.gemini.model;
        log.info(`Initialized Gemini provider`, { model: this.model });
    }

    async generateContent(
        systemInstruction: string,
        messages: LLMMessage[],
        functionDeclarations: FunctionDeclaration[]
    ): Promise<LLMResponse> {
        log.debug(`Calling ${this.model}`, {
            messagesCount: messages.length,
            toolsCount: functionDeclarations.length,
        });

        try {
            const response = await this.ai.models.generateContent({
                model: this.model,
                contents: messages as any,
                config: {
                    systemInstruction,
                    tools: functionDeclarations.length > 0
                        ? [{ functionDeclarations: functionDeclarations as any }]
                        : undefined,
                },
            });

            // Extract function calls if present
            const functionCalls = response.functionCalls?.map(fc => ({
                name: fc.name!,
                args: fc.args as Record<string, any>,
            })) ?? null;

            // Extract text response
            const text = response.text ?? null;

            // Preserve raw parts (includes thought_signature for function calls)
            const rawParts = (response.candidates?.[0]?.content?.parts as any[]) ?? [];

            log.debug('Response received', {
                hasText: !!text,
                functionCallCount: functionCalls?.length ?? 0,
            });

            return { text, functionCalls, rawParts, rawResponse: response };
        } catch (err: any) {
            log.error('Gemini API error', { error: err.message });
            throw err;
        }
    }

    /**
     * Streaming variant — yields text tokens as they arrive.
     */
    async generateContentStream(
        systemInstruction: string,
        messages: LLMMessage[],
        functionDeclarations: FunctionDeclaration[],
        onToken: (token: string) => void
    ): Promise<LLMResponse> {
        log.debug(`Streaming call to ${this.model}`, {
            messagesCount: messages.length,
            toolsCount: functionDeclarations.length,
        });

        try {
            const response = await this.ai.models.generateContentStream({
                model: this.model,
                contents: messages as any,
                config: {
                    systemInstruction,
                    tools: functionDeclarations.length > 0
                        ? [{ functionDeclarations: functionDeclarations as any }]
                        : undefined,
                },
            });

            let fullText = '';
            let functionCalls: Array<{ name: string; args: Record<string, any> }> | null = null;
            let rawParts: any[] = [];

            for await (const chunk of response) {
                // Stream text chunks
                const chunkText = chunk.text ?? '';
                if (chunkText) {
                    fullText += chunkText;
                    onToken(chunkText);
                }

                // Collect function calls from the final chunk
                if (chunk.functionCalls && chunk.functionCalls.length > 0) {
                    functionCalls = chunk.functionCalls.map(fc => ({
                        name: fc.name!,
                        args: fc.args as Record<string, any>,
                    }));
                }

                // Collect raw parts
                const parts = (chunk.candidates?.[0]?.content?.parts as any[]) ?? [];
                if (parts.length > 0) {
                    rawParts = parts;
                }
            }

            log.debug('Stream complete', {
                hasText: !!fullText,
                functionCallCount: functionCalls?.length ?? 0,
            });

            return {
                text: fullText || null,
                functionCalls,
                rawParts,
                rawResponse: null,
            };
        } catch (err: any) {
            log.error('Gemini streaming error', { error: err.message });
            // Fall back to non-streaming
            log.info('Falling back to non-streaming');
            const result = await this.generateContent(systemInstruction, messages, functionDeclarations);
            if (result.text) onToken(result.text);
            return result;
        }
    }
}
