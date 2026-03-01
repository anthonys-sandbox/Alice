import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface AliceConfig {
    chatProvider: 'gemini' | 'ollama';
    gemini: {
        apiKey: string;
        model: string;
        auth: 'api-key' | 'cli' | 'auto';
    };
    ollama: {
        host: string;
        port: number;
        model: string;
        visionModel?: string;
        fallbackModel?: string;
    };
    googleChat: {
        sheetId: string;
        oauthClientId: string;
        oauthClientSecret: string;
        serviceAccountKeyPath: string;
    };
    gateway: {
        host: string;
        port: number;
    };
    heartbeat: {
        enabled: boolean;
        intervalMinutes: number;
    };
    memory: {
        dir: string;
    };
    skills: {
        dirs: string[];
    };
    agent: {
        maxIterations: number;
        timeoutMs: number;
    };
    logging: {
        level: 'debug' | 'info' | 'warn' | 'error';
    };
    mcp: {
        servers: Array<{
            name: string;
            command: string;
            args?: string[];
            env?: Record<string, string>;
            cwd?: string;
            enabled?: boolean;
        }>;
    };
    openRouter: {
        apiKey: string;
    };
}

const DEFAULTS: AliceConfig = {
    chatProvider: 'ollama',
    gemini: {
        apiKey: '',
        model: 'gemini-3-flash-preview',
        auth: 'auto' as const,
    },
    ollama: {
        host: '127.0.0.1',
        port: 11434,
        model: 'qwen3:8b',
        visionModel: 'qwen3-vl',
        fallbackModel: 'qwen3:1.7b',
    },
    googleChat: {
        sheetId: '',
        oauthClientId: '',
        oauthClientSecret: '',
        serviceAccountKeyPath: '',
    },
    gateway: {
        host: '127.0.0.1',
        port: 18790,
    },
    heartbeat: {
        enabled: true,
        intervalMinutes: 30,
    },
    memory: {
        dir: './memory',
    },
    skills: {
        dirs: [
            './skills',
            join(homedir(), '.alice', 'skills'),
        ],
    },
    agent: {
        maxIterations: 25,
        timeoutMs: 5 * 60 * 1000, // 5 minutes
    },
    logging: {
        level: 'info',
    },
    mcp: {
        servers: [],
    },
    openRouter: {
        apiKey: '',
    },
};

export function loadConfig(projectDir?: string): AliceConfig {
    const config = { ...DEFAULTS };

    // Load from alice.config.json if it exists
    const configPath = join(projectDir || process.cwd(), 'alice.config.json');
    if (existsSync(configPath)) {
        try {
            const fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
            deepMerge(config, fileConfig);
        } catch {
            // Config file is malformed — use defaults
        }
    }

    // Environment variables override everything
    if (process.env.GEMINI_API_KEY) config.gemini.apiKey = process.env.GEMINI_API_KEY;
    if (process.env.GEMINI_MODEL) config.gemini.model = process.env.GEMINI_MODEL;
    if (process.env.GEMINI_AUTH) config.gemini.auth = process.env.GEMINI_AUTH as AliceConfig['gemini']['auth'];

    if (process.env.CHAT_PROVIDER) config.chatProvider = process.env.CHAT_PROVIDER as AliceConfig['chatProvider'];
    if (process.env.OLLAMA_HOST) config.ollama.host = process.env.OLLAMA_HOST;
    if (process.env.OLLAMA_PORT) config.ollama.port = parseInt(process.env.OLLAMA_PORT, 10);
    if (process.env.OLLAMA_MODEL) config.ollama.model = process.env.OLLAMA_MODEL;
    if (process.env.OLLAMA_VISION_MODEL) config.ollama.visionModel = process.env.OLLAMA_VISION_MODEL;
    if (process.env.OLLAMA_FALLBACK_MODEL) config.ollama.fallbackModel = process.env.OLLAMA_FALLBACK_MODEL;
    if (process.env.RELAY_SHEET_ID) config.googleChat.sheetId = process.env.RELAY_SHEET_ID;
    if (process.env.GOOGLE_CLIENT_ID) config.googleChat.oauthClientId = process.env.GOOGLE_CLIENT_ID;
    if (process.env.GOOGLE_CLIENT_SECRET) config.googleChat.oauthClientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (process.env.GOOGLE_SA_KEY_PATH) config.googleChat.serviceAccountKeyPath = process.env.GOOGLE_SA_KEY_PATH;
    if (process.env.GATEWAY_PORT) config.gateway.port = parseInt(process.env.GATEWAY_PORT, 10);
    if (process.env.HEARTBEAT_INTERVAL) config.heartbeat.intervalMinutes = parseInt(process.env.HEARTBEAT_INTERVAL, 10);
    if (process.env.LOG_LEVEL) config.logging.level = process.env.LOG_LEVEL as AliceConfig['logging']['level'];
    if (process.env.OPENROUTER_API_KEY) config.openRouter.apiKey = process.env.OPENROUTER_API_KEY;

    return config;
}

function deepMerge(target: Record<string, any>, source: Record<string, any>): void {
    for (const key of Object.keys(source)) {
        if (
            source[key] &&
            typeof source[key] === 'object' &&
            !Array.isArray(source[key]) &&
            target[key] &&
            typeof target[key] === 'object'
        ) {
            deepMerge(target[key], source[key]);
        } else {
            target[key] = source[key];
        }
    }
}
