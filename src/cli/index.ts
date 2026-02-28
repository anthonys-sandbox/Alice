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
   ║       ✨  A  L  I  C  E            ║
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
    .description('Run health diagnostics')
    .action(() => {
        const config = loadConfig();
        console.log(chalk.magenta('\n✨ Alice Health Check\n'));

        // Check Gemini API key
        const hasKey = !!config.gemini.apiKey;
        console.log(hasKey
            ? chalk.green('✅ Gemini API key configured')
            : chalk.red('❌ Gemini API key missing — set GEMINI_API_KEY in .env')
        );

        // Check Google Chat relay
        const hasRelay = !!config.googleChat.sheetId && !!config.googleChat.oauthClientId;
        console.log(hasRelay
            ? chalk.green('✅ Google Chat relay configured (Sheets queue)')
            : chalk.yellow('⚠️  Google Chat relay not configured — see scripts/apps-script-relay.js')
        );

        // Check provider & model
        const activeModel = config.chatProvider === 'gemini'
            ? config.gemini.model
            : config.ollama.model;
        console.log(chalk.cyan(`🤖 Chat Provider: ${config.chatProvider}`));
        console.log(chalk.cyan(`📦 Model: ${activeModel}`));
        console.log(chalk.cyan(`🔌 Gateway: ${config.gateway.host}:${config.gateway.port}`));
        console.log(chalk.cyan(`💓 Heartbeat: ${config.heartbeat.enabled ? `every ${config.heartbeat.intervalMinutes} min` : 'disabled'}`));

        // Check skills
        const skills = loadSkills(config.skills.dirs);
        console.log(chalk.cyan(`🧩 Skills: ${skills.length} loaded`));

        console.log('');
    });

export { program };
