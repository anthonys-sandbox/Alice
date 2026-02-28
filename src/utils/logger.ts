import chalk from 'chalk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

const LEVEL_COLORS: Record<LogLevel, (s: string) => string> = {
    debug: chalk.gray,
    info: chalk.cyan,
    warn: chalk.yellow,
    error: chalk.red,
};

const LEVEL_ICONS: Record<LogLevel, string> = {
    debug: '🔍',
    info: '💠',
    warn: '⚠️',
    error: '❌',
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
    currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function timestamp(): string {
    return chalk.gray(new Date().toISOString().slice(11, 19));
}

function formatMessage(level: LogLevel, component: string, message: string, meta?: Record<string, any>): string {
    const parts = [
        timestamp(),
        LEVEL_COLORS[level](`${LEVEL_ICONS[level]} ${level.toUpperCase().padEnd(5)}`),
        chalk.magenta(`[${component}]`),
        message,
    ];

    if (meta && Object.keys(meta).length > 0) {
        parts.push(chalk.gray(JSON.stringify(meta)));
    }

    return parts.join(' ');
}

export function createLogger(component: string) {
    return {
        debug(message: string, meta?: Record<string, any>) {
            if (shouldLog('debug')) console.log(formatMessage('debug', component, message, meta));
        },
        info(message: string, meta?: Record<string, any>) {
            if (shouldLog('info')) console.log(formatMessage('info', component, message, meta));
        },
        warn(message: string, meta?: Record<string, any>) {
            if (shouldLog('warn')) console.warn(formatMessage('warn', component, message, meta));
        },
        error(message: string, meta?: Record<string, any>) {
            if (shouldLog('error')) console.error(formatMessage('error', component, message, meta));
        },
    };
}
