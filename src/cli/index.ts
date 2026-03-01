#!/usr/bin/env node

import { Command } from 'commander';
import { createInterface } from 'readline';
import chalk from 'chalk';
import { loadConfig } from '../utils/config.js';
import { setLogLevel } from '../utils/logger.js';
import { Gateway } from '../gateway/server.js';
import { Agent } from '../runtime/agent.js';
import { loadSkills } from '../skills/loader.js';

const program = new Command();

program
    .name('alice')
    .description('✨ Alice — Your personal AI agent')
    .version('1.0.0');

// ============================================================
// alice start
// ============================================================
program
    .command('start')
    .description('Start the Alice gateway server')
    .option('-p, --port <number>', 'Gateway port', '18790')
    .option('--no-heartbeat', 'Disable the heartbeat scheduler')
    .action(async (opts) => {
        const config = loadConfig();
        if (opts.port) config.gateway.port = parseInt(opts.port, 10);
        if (opts.heartbeat === false) config.heartbeat.enabled = false;
        setLogLevel(config.logging.level);

        console.log(chalk.magenta(`
   ╔══════════════════════════════════════╗
   ║        ✨  T  O  B  Y              ║
   ║     Personal AI Agent Runtime       ║
   ╚══════════════════════════════════════╝
    `));

        const gateway = new Gateway(config);
        await gateway.start();

        // Handle graceful shutdown
        const shutdown = async () => {
            console.log(chalk.yellow('\n\nShutting down Alice...'));
            await gateway.stop();
            process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    });

// ============================================================
// alice chat
// ============================================================
program
    .command('chat')
    .description('Interactive terminal chat with the agent')
    .action(async () => {
        const config = loadConfig();
        setLogLevel('warn'); // Quiet mode for interactive chat

        console.log(chalk.magenta(`
   ✨ Alice Interactive Chat
   Type your message and press Enter. Type "exit" to quit.
   Type "clear" to reset conversation history.
    `));

        const agent = new Agent(config);
        const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        const prompt = () => {
            rl.question(chalk.cyan('\n🧑 You: '), async (input) => {
                const trimmed = input.trim();
                if (!trimmed) { prompt(); return; }
                if (trimmed.toLowerCase() === 'exit') {
                    console.log(chalk.gray('Goodbye! 👋'));
                    rl.close();
                    process.exit(0);
                }
                if (trimmed.toLowerCase() === 'clear') {
                    agent.clearHistory();
                    console.log(chalk.yellow('Conversation history cleared.'));
                    prompt();
                    return;
                }

                console.log(chalk.gray('Thinking...'));
                try {
                    const response = await agent.processMessage(trimmed);
                    console.log(chalk.magenta('\n✨ Alice: ') + response.text);
                    if (response.toolsUsed.length > 0) {
                        console.log(chalk.gray(`   [Tools: ${response.toolsUsed.join(', ')} | Iterations: ${response.iterations}]`));
                    }
                } catch (err: any) {
                    console.log(chalk.red(`Error: ${err.message}`));
                }
                prompt();
            });
        };

        prompt();
    });

// ============================================================
// alice skills
// ============================================================
const skillsCmd = program
    .command('skills')
    .description('Manage Alice skills');

skillsCmd
    .command('list')
    .description('List all loaded skills')
    .action(() => {
        const config = loadConfig();
        const skills = loadSkills(config.skills.dirs);

        if (skills.length === 0) {
            console.log(chalk.yellow('No skills found.'));
            console.log(chalk.gray('Add skills to ./skills/ or ~/.alice/skills/'));
            return;
        }

        console.log(chalk.magenta(`\n🦀 Loaded Skills (${skills.length}):\n`));
        for (const skill of skills) {
            console.log(chalk.cyan(`  • ${skill.name}`) + chalk.gray(` — ${skill.description}`));
            console.log(chalk.gray(`    Source: ${skill.source}`));
            if (skill.requires) {
                console.log(chalk.gray(`    Requires: ${skill.requires.join(', ')}`));
            }
        }
    });

// ============================================================
// alice doctor
// ============================================================
program
    .command('doctor')
    .description('Run health diagnostics with live connectivity checks')
    .action(async () => {
        const config = loadConfig();
        console.log(chalk.magenta('\n✨ Alice Health Check\n'));

        // ── Config Checks ──
        const hasKey = !!config.gemini.apiKey;
        console.log(hasKey
            ? chalk.green('✅ Gemini API key configured')
            : chalk.red('❌ Gemini API key missing — set GEMINI_API_KEY in .env')
        );

        const hasRelay = !!config.googleChat.sheetId && !!config.googleChat.oauthClientId;
        console.log(hasRelay
            ? chalk.green('✅ Google Chat relay configured (Sheets queue)')
            : chalk.yellow('⚠️  Google Chat relay not configured')
        );

        const activeModel = config.chatProvider === 'gemini'
            ? config.gemini.model
            : config.ollama.model;
        console.log(chalk.cyan(`🤖 Chat Provider: ${config.chatProvider}`));
        console.log(chalk.cyan(`📦 Model: ${activeModel}`));
        console.log(chalk.cyan(`🔌 Gateway: ${config.gateway.host}:${config.gateway.port}`));
        console.log(chalk.cyan(`💓 Heartbeat: ${config.heartbeat.enabled ? `every ${config.heartbeat.intervalMinutes} min` : 'disabled'}`));

        const skills = loadSkills(config.skills.dirs);
        console.log(chalk.cyan(`🧩 Skills: ${skills.length} loaded`));

        // ── MCP Servers ──
        if (config.mcp.servers.length > 0) {
            console.log(chalk.cyan(`🔗 MCP Servers: ${config.mcp.servers.length} configured`));
            config.mcp.servers.forEach(s => {
                const status = s.enabled !== false ? chalk.green('enabled') : chalk.gray('disabled');
                console.log(chalk.gray(`   • ${s.name} (${s.command}) — ${status}`));
            });
        } else {
            console.log(chalk.gray(`🔗 MCP Servers: none configured`));
        }

        // ── Live Connectivity Checks ──
        console.log(chalk.magenta('\n📡 Connectivity Tests\n'));

        // Check Ollama
        try {
            const ollamaUrl = `http://${config.ollama.host}:${config.ollama.port}/api/tags`;
            const ollamaRes = await fetch(ollamaUrl, { signal: AbortSignal.timeout(5000) });
            if (ollamaRes.ok) {
                const data = await ollamaRes.json() as { models?: Array<{ name: string }> };
                const models = (data.models || []).map((m: any) => m.name).join(', ');
                console.log(chalk.green(`✅ Ollama reachable at ${config.ollama.host}:${config.ollama.port}`));
                console.log(chalk.gray(`   Available models: ${models || 'none'}`));
                const targetModel = config.ollama.model;
                const hasModel = (data.models || []).some((m: any) => m.name === targetModel || m.name.startsWith(targetModel));
                console.log(hasModel
                    ? chalk.green(`✅ Target model "${targetModel}" is available`)
                    : chalk.red(`❌ Target model "${targetModel}" not found — run: ollama pull ${targetModel}`)
                );
            } else {
                console.log(chalk.red(`❌ Ollama responded with status ${ollamaRes.status}`));
            }
        } catch (err: any) {
            console.log(chalk.red(`❌ Ollama not reachable at ${config.ollama.host}:${config.ollama.port}`));
            console.log(chalk.gray(`   Error: ${err.message}`));
        }

        // Check Gemini API
        if (hasKey) {
            try {
                const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${config.gemini.apiKey}`;
                const geminiRes = await fetch(geminiUrl, { signal: AbortSignal.timeout(10000) });
                if (geminiRes.ok) {
                    console.log(chalk.green('✅ Gemini API key is valid'));
                } else {
                    const msg = await geminiRes.text();
                    console.log(chalk.red(`❌ Gemini API responded with ${geminiRes.status}: ${msg.slice(0, 200)}`));
                }
            } catch (err: any) {
                console.log(chalk.red(`❌ Gemini API not reachable`));
                console.log(chalk.gray(`   Error: ${err.message}`));
            }
        }

        // Check Google Sheets relay
        if (config.googleChat.sheetId) {
            try {
                const sheetUrl = `https://docs.google.com/spreadsheets/d/${config.googleChat.sheetId}/edit`;
                const sheetRes = await fetch(sheetUrl, {
                    method: 'HEAD',
                    redirect: 'manual',
                    signal: AbortSignal.timeout(5000),
                });
                // 200 or 302 means the sheet exists (may need auth)
                if (sheetRes.status < 400) {
                    console.log(chalk.green('✅ Google Sheet relay is accessible'));
                } else {
                    console.log(chalk.red(`❌ Google Sheet returned ${sheetRes.status}`));
                }
            } catch (err: any) {
                console.log(chalk.yellow(`⚠️  Could not reach Google Sheets: ${err.message}`));
            }
        }

        // Check Gateway port availability
        try {
            const gwRes = await fetch(`http://127.0.0.1:${config.gateway.port}/api/health`, {
                signal: AbortSignal.timeout(2000),
            });
            if (gwRes.ok) {
                console.log(chalk.green(`✅ Gateway is running on port ${config.gateway.port}`));
            } else {
                console.log(chalk.yellow(`⚠️  Gateway port ${config.gateway.port} responded with ${gwRes.status}`));
            }
        } catch {
            console.log(chalk.gray(`🔹 Gateway not currently running on port ${config.gateway.port}`));
        }

        console.log('');
    });

export { program };
