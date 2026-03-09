import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, write } from 'fs';
import { dirname, resolve, extname, join } from 'path';
import { execSync, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { createLogger } from '../../utils/logger.js';
import { browserTools } from './browser.js';
import type { CronJobManager } from '../../scheduler/cron-jobs.js';

const log = createLogger('Tools');

/**
 * Global event emitter for streaming tool output to the UI.
 * The gateway subscribes to 'tool_output' events and forwards them via WebSocket.
 */
export const toolEvents = new EventEmitter();

// ============================================================
// Tool type definitions
// ============================================================

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, any>;
    execute: (args: Record<string, any>) => Promise<string>;
}

// ============================================================
// generate_image
// ============================================================

export const generateImageTool: ToolDefinition = {
    name: 'generate_image',
    description: 'Generate an image using an AI model (like Nano Banana Pro). Returns the path to the generated image file.',
    parameters: {
        type: 'object',
        properties: {
            prompt: { type: 'string', description: 'The prompt describing the image to generate' },
            model: { type: 'string', description: 'The model to use. Defaults to "gemini-3-pro-image-preview" (Nano Banana Pro)' },
            aspectRatio: { type: 'string', enum: ['1:1', '16:9', '9:16', '3:2', '4:3'], description: 'The aspect ratio of the image' },
        },
        required: ['prompt'],
    },
    async execute(args) {
        const prompt = args.prompt;
        const model = args.model || 'gemini-3-pro-image-preview';
        const aspectRatio = args.aspectRatio || '1:1';
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) return 'Error: GEMINI_API_KEY not found in environment';

        log.info(`Generating image with model ${model}`, { prompt, aspectRatio });

        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        responseModalities: ['IMAGE'],
                        imageConfig: { aspectRatio }
                    }
                })
            });

            const data: any = await response.json();

            if (data.error) {
                return `Error from Gemini API: ${data.error.message}`;
            }

            const imagePart = data.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
            if (!imagePart) {
                log.error('No image data in response', data);
                return 'Error: The model did not return any image data. It might have returned text or an empty response instead.';
            }

            const base64Data = imagePart.inlineData.data;
            const mimeType = imagePart.inlineData.mimeType || 'image/png';
            const extension = mimeType.split('/')[1] || 'png';

            const fileName = `generated_${Date.now()}.${extension}`;
            const outputDir = resolve('generated_images');
            if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

            const outputPath = join(outputDir, fileName);
            writeFileSync(outputPath, Buffer.from(base64Data, 'base64'));

            log.info(`Image saved to ${outputPath}`);
            return `Image generated successfully!\n\n![${prompt}](/images/${fileName})\n\nSaved to: ${outputPath}`;
        } catch (err: any) {
            log.error('Image generation failed', { error: err.message });
            return `Error generating image: ${err.message}`;
        }
    }
};

// ============================================================
// read_file
// ============================================================

export const readFileTool: ToolDefinition = {
    name: 'read_file',
    description: 'Read the contents of a file. Supports text files. For large files, use startLine/endLine to paginate.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Absolute or relative path to the file to read' },
            startLine: { type: 'integer', description: 'Optional start line (1-indexed)' },
            endLine: { type: 'integer', description: 'Optional end line (1-indexed, inclusive)' },
        },
        required: ['path'],
    },
    async execute(args) {
        const filePath = resolve(args.path);
        if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;

        try {
            const content = readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            const start = (args.startLine ?? 1) - 1;
            const end = args.endLine ?? lines.length;
            const slice = lines.slice(start, end);

            log.debug(`Read ${slice.length} lines from ${filePath}`);
            return `File: ${filePath} (${lines.length} total lines, showing ${start + 1}-${Math.min(end, lines.length)})\n\n${slice.join('\n')}`;
        } catch (err: any) {
            return `Error reading file: ${err.message}`;
        }
    },
};

// ============================================================
// write_file
// ============================================================

export const writeFileTool: ToolDefinition = {
    name: 'write_file',
    description: 'Write content to a file. Creates the file and parent directories if they don\'t exist. Overwrites existing content.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Absolute or relative path to the file to write' },
            content: { type: 'string', description: 'The content to write to the file' },
        },
        required: ['path', 'content'],
    },
    async execute(args) {
        const filePath = resolve(args.path);
        try {
            const dir = dirname(filePath);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(filePath, args.content, 'utf-8');
            log.debug(`Wrote ${args.content.length} chars to ${filePath}`);
            return `Successfully wrote ${args.content.length} characters to ${filePath}`;
        } catch (err: any) {
            return `Error writing file: ${err.message}`;
        }
    },
};

// ============================================================
// edit_file
// ============================================================

export const editFileTool: ToolDefinition = {
    name: 'edit_file',
    description: 'Perform a surgical text replacement in a file. Finds the exact old_text and replaces it with new_text.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Path to the file to edit' },
            old_text: { type: 'string', description: 'The exact text to find and replace (must match exactly)' },
            new_text: { type: 'string', description: 'The replacement text' },
        },
        required: ['path', 'old_text', 'new_text'],
    },
    async execute(args) {
        const filePath = resolve(args.path);
        if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;

        try {
            const content = readFileSync(filePath, 'utf-8');
            if (!content.includes(args.old_text)) {
                return `Error: Could not find the exact text to replace in ${filePath}. Make sure old_text matches exactly.`;
            }

            const occurrences = content.split(args.old_text).length - 1;
            const newContent = content.replace(args.old_text, args.new_text);
            writeFileSync(filePath, newContent, 'utf-8');

            log.debug(`Edited ${filePath} (${occurrences} occurrence(s))`);
            return `Successfully replaced text in ${filePath} (${occurrences} occurrence(s) found, first replaced)`;
        } catch (err: any) {
            return `Error editing file: ${err.message}`;
        }
    },
};

// ============================================================
// bash
// ============================================================

export const bashTool: ToolDefinition = {
    name: 'bash',
    description: 'Execute a shell command and return stdout + stderr. Output streams in real-time to the UI console.',
    parameters: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'The shell command to execute' },
            cwd: { type: 'string', description: 'Optional working directory for the command' },
            timeout: { type: 'integer', description: 'Optional timeout in milliseconds (default: 30000)' },
        },
        required: ['command'],
    },
    async execute(args) {
        const timeout = args.timeout ?? 30000;
        const cwd = args.cwd ? resolve(args.cwd) : process.cwd();

        log.debug(`Executing: ${args.command}`, { cwd, timeout });

        return new Promise<string>((resolvePromise) => {
            const child = spawn('bash', ['-c', args.command], {
                cwd,
                env: { ...process.env, PAGER: 'cat' },
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            let stdout = '';
            let stderr = '';
            let killed = false;

            // Stream stdout chunks in real-time
            child.stdout.on('data', (data: Buffer) => {
                const chunk = data.toString();
                stdout += chunk;
                toolEvents.emit('tool_output', {
                    tool: 'bash',
                    stream: 'stdout',
                    chunk,
                    command: args.command,
                });
            });

            // Stream stderr chunks
            child.stderr.on('data', (data: Buffer) => {
                const chunk = data.toString();
                stderr += chunk;
                toolEvents.emit('tool_output', {
                    tool: 'bash',
                    stream: 'stderr',
                    chunk,
                    command: args.command,
                });
            });

            // Timeout handling
            const timer = setTimeout(() => {
                killed = true;
                child.kill('SIGTERM');
            }, timeout);

            child.on('close', (code) => {
                clearTimeout(timer);

                const output = stdout.length > 10000
                    ? stdout.slice(0, 10000) + '\n\n... (output truncated, showing first 10000 chars)'
                    : stdout;

                if (killed) {
                    resolvePromise(`Command: ${args.command}\nKilled after ${timeout}ms timeout\n\nSTDOUT:\n${output}\n\nSTDERR:\n${stderr}`);
                } else if (code === 0) {
                    resolvePromise(`Command: ${args.command}\nExit code: 0\n\n${output}`);
                } else {
                    resolvePromise(`Command: ${args.command}\nExit code: ${code ?? 1}\n\nSTDOUT:\n${output}\n\nSTDERR:\n${stderr}`);
                }
            });

            child.on('error', (err) => {
                clearTimeout(timer);
                resolvePromise(`Command: ${args.command}\nError: ${err.message}`);
            });
        });
    },
};

// ============================================================
// web_search
// ============================================================

export const webSearchTool: ToolDefinition = {
    name: 'web_search',
    description: 'Search the web for information. Returns a summary of search results.',
    parameters: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'The search query' },
        },
        required: ['query'],
    },
    async execute(args) {
        // Use Gemini grounding with Google Search as a lightweight search
        // For now, provide a simple curl-based fallback
        try {
            const encodedQuery = encodeURIComponent(args.query);
            const output = execSync(
                `curl -sL "https://www.google.com/search?q=${encodedQuery}&num=5" | head -c 5000`,
                { encoding: 'utf-8', timeout: 15000 }
            );
            return `Web search results for "${args.query}":\n\n${output.slice(0, 3000)}`;
        } catch {
            return `Web search for "${args.query}" failed. Connectivity issue or rate limited.`;
        }
    },
};

// ============================================================
// list_directory
// ============================================================

export const listDirectoryTool: ToolDefinition = {
    name: 'list_directory',
    description: 'List files and directories at a given path. Shows type, size, and name.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Path to the directory to list' },
        },
        required: ['path'],
    },
    async execute(args) {
        const dirPath = resolve(args.path);
        if (!existsSync(dirPath)) return `Error: Directory not found: ${dirPath}`;

        try {
            const output = execSync(`ls -la "${dirPath}"`, {
                encoding: 'utf-8',
                timeout: 5000,
            });
            return `Directory listing for ${dirPath}:\n\n${output}`;
        } catch (err: any) {
            return `Error listing directory: ${err.message}`;
        }
    },
};

// ============================================================
// git_status
// ============================================================

export const gitStatusTool: ToolDefinition = {
    name: 'git_status',
    description: 'Show the working tree status of a git repository. Returns modified, staged, and untracked files.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Path to the git repository (defaults to cwd)' },
        },
        required: [],
    },
    async execute(args) {
        const cwd = args.path ? resolve(args.path) : process.cwd();
        try {
            const output = execSync('git status --short --branch', { cwd, encoding: 'utf-8', timeout: 10000 });
            return `Git status for ${cwd}:\n${output || '(clean working tree)'}`;
        } catch (err: any) {
            return `Error: ${err.message}`;
        }
    },
};

// ============================================================
// git_diff
// ============================================================

export const gitDiffTool: ToolDefinition = {
    name: 'git_diff',
    description: 'Show changes between commits, working tree, and staging area. Defaults to unstaged changes.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Path to the git repository (defaults to cwd)' },
            staged: { type: 'boolean', description: 'Show staged changes instead of unstaged (default: false)' },
            file: { type: 'string', description: 'Optional specific file to diff' },
        },
        required: [],
    },
    async execute(args) {
        const cwd = args.path ? resolve(args.path) : process.cwd();
        const staged = args.staged ? '--staged' : '';
        const file = args.file ? `-- "${args.file}"` : '';
        try {
            const output = execSync(`git diff ${staged} ${file}`.trim(), {
                cwd, encoding: 'utf-8', timeout: 10000, maxBuffer: 1024 * 1024,
            });
            if (!output.trim()) return 'No changes found.';
            const trimmed = output.length > 8000 ? output.slice(0, 8000) + '\n\n... (truncated)' : output;
            return trimmed;
        } catch (err: any) {
            return `Error: ${err.message}`;
        }
    },
};

// ============================================================
// git_commit
// ============================================================

export const gitCommitTool: ToolDefinition = {
    name: 'git_commit',
    description: 'Stage files and create a git commit. Stages all changes by default.',
    parameters: {
        type: 'object',
        properties: {
            message: { type: 'string', description: 'The commit message' },
            path: { type: 'string', description: 'Path to the git repository (defaults to cwd)' },
            files: { type: 'string', description: 'Specific files to stage (space-separated). Defaults to all changes (git add -A).' },
        },
        required: ['message'],
    },
    async execute(args) {
        const cwd = args.path ? resolve(args.path) : process.cwd();
        try {
            // Stage
            const stageCmd = args.files ? `git add ${args.files}` : 'git add -A';
            execSync(stageCmd, { cwd, encoding: 'utf-8', timeout: 10000 });
            // Commit
            const output = execSync(`git commit -m "${args.message.replace(/"/g, '\\"')}"`, {
                cwd, encoding: 'utf-8', timeout: 10000,
            });
            return `Commit successful:\n${output}`;
        } catch (err: any) {
            return `Error: ${err.stderr || err.message}`;
        }
    },
};

// ============================================================
// git_log
// ============================================================

export const gitLogTool: ToolDefinition = {
    name: 'git_log',
    description: 'Show recent git commit history.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Path to the git repository (defaults to cwd)' },
            count: { type: 'integer', description: 'Number of commits to show (default: 10)' },
        },
        required: [],
    },
    async execute(args) {
        const cwd = args.path ? resolve(args.path) : process.cwd();
        const count = args.count ?? 10;
        try {
            const output = execSync(
                `git log --oneline --graph --decorate -n ${count}`,
                { cwd, encoding: 'utf-8', timeout: 10000 }
            );
            return output || 'No commits found.';
        } catch (err: any) {
            return `Error: ${err.message}`;
        }
    },
};

// ============================================================
// clipboard_read / clipboard_write
// ============================================================

export const clipboardReadTool: ToolDefinition = {
    name: 'clipboard_read',
    description: 'Read the current contents of the system clipboard.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
        try {
            const output = execSync('pbpaste', { encoding: 'utf-8', timeout: 5000 });
            return output || '(clipboard is empty)';
        } catch (err: any) {
            return `Error reading clipboard: ${err.message}`;
        }
    },
};

export const clipboardWriteTool: ToolDefinition = {
    name: 'clipboard_write',
    description: 'Write text to the system clipboard.',
    parameters: {
        type: 'object',
        properties: {
            text: { type: 'string', description: 'The text to copy to clipboard' },
        },
        required: ['text'],
    },
    async execute(args) {
        try {
            execSync('pbcopy', { input: args.text, encoding: 'utf-8', timeout: 5000 });
            return `Copied ${args.text.length} characters to clipboard.`;
        } catch (err: any) {
            return `Error writing to clipboard: ${err.message}`;
        }
    },
};

// ============================================================
// web_fetch — fetch and convert web pages to readable text
// ============================================================

export const webFetchTool: ToolDefinition = {
    name: 'web_fetch',
    description: 'Fetch a web page and return its text content. Strips HTML tags and returns readable text. Good for reading articles, docs, and web pages.',
    parameters: {
        type: 'object',
        properties: {
            url: { type: 'string', description: 'The URL to fetch' },
            max_length: { type: 'integer', description: 'Maximum characters to return (default: 5000)' },
        },
        required: ['url'],
    },
    async execute(args) {
        const maxLen = args.max_length ?? 5000;
        try {
            const response = await fetch(args.url, {
                headers: { 'User-Agent': 'Alice/1.0 (Personal AI Agent)' },
                signal: AbortSignal.timeout(15000),
            });

            if (!response.ok) return `Error: HTTP ${response.status} ${response.statusText}`;

            const html = await response.text();

            // Simple HTML to text conversion (no dependencies needed)
            const text = html
                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
                .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
                .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/\s+/g, ' ')
                .trim();

            const trimmed = text.length > maxLen ? text.slice(0, maxLen) + '\n\n... (truncated)' : text;
            return `Content from ${args.url}:\n\n${trimmed}`;
        } catch (err: any) {
            return `Error fetching URL: ${err.message}`;
        }
    },
};

// ============================================================
// read_pdf — extract text from PDF files (uses pdftotext if available)
// ============================================================

export const readPdfTool: ToolDefinition = {
    name: 'read_pdf',
    description: 'Extract text content from a PDF file. Uses pdftotext (poppler) if available, otherwise falls back to basic extraction.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Path to the PDF file' },
        },
        required: ['path'],
    },
    async execute(args) {
        const filePath = resolve(args.path);
        if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;
        if (!filePath.toLowerCase().endsWith('.pdf')) return `Error: Not a PDF file: ${filePath}`;

        try {
            // Try pdftotext (from poppler — brew install poppler)
            const output = execSync(`pdftotext "${filePath}" -`, {
                encoding: 'utf-8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
            });
            const trimmed = output.length > 10000 ? output.slice(0, 10000) + '\n\n... (truncated)' : output;
            return `PDF content from ${filePath}:\n\n${trimmed}`;
        } catch {
            // Fallback: read raw bytes and extract visible text
            try {
                const raw = readFileSync(filePath, 'latin1');
                const textChunks = raw.match(/\(([^)]+)\)/g) || [];
                const extracted = textChunks.map(c => c.slice(1, -1)).join(' ').slice(0, 5000);
                return extracted
                    ? `PDF text (basic extraction) from ${filePath}:\n\n${extracted}`
                    : `Could not extract text from PDF. Install poppler for better results: brew install poppler`;
            } catch (err: any) {
                return `Error reading PDF: ${err.message}`;
            }
        }
    },
};

// ============================================================
// git_backup — commit + push all changes
// ============================================================

export const gitBackupTool: ToolDefinition = {
    name: 'git_backup',
    description: 'Backup the project to GitHub by staging all changes, committing with a timestamped message, and pushing to the remote. Optionally accepts a custom commit message.',
    parameters: {
        type: 'object',
        properties: {
            message: { type: 'string', description: 'Optional custom commit message (default: auto-generated with timestamp)' },
            path: { type: 'string', description: 'Path to the git repository (defaults to cwd)' },
        },
        required: [],
    },
    async execute(args) {
        const cwd = args.path || process.cwd();
        try {
            // Check if there are changes
            const status = execSync('git status --porcelain', { cwd, encoding: 'utf-8' }).trim();
            if (!status) {
                return 'No changes to backup — working tree is clean.';
            }

            // Stage all changes
            execSync('git add -A', { cwd, encoding: 'utf-8' });

            // Commit
            const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z/, '');
            const rawMsg = args.message || `auto-backup ${timestamp}`;
            // Sanitize commit message to prevent shell injection
            const commitMsg = rawMsg.replace(/["`$\\!]/g, '').slice(0, 120);
            const commitResult = execSync(`git commit -m "${commitMsg}"`, { cwd, encoding: 'utf-8' }).trim();

            // Push
            let pushResult = '';
            try {
                pushResult = execSync('git push', { cwd, encoding: 'utf-8', timeout: 30000 }).trim();
            } catch (pushErr: any) {
                return `✅ Committed: ${commitMsg}\n\n⚠️ Push failed: ${pushErr.message}\n\nChanges are committed locally. You can push manually with 'git push'.`;
            }

            const changedFiles = status.split('\n').length;
            return `✅ Backup complete!\n📝 Committed: "${commitMsg}"\n📁 ${changedFiles} file(s) changed\n🚀 Pushed to remote\n\n${commitResult}`;
        } catch (err: any) {
            return `Backup failed: ${err.message}`;
        }
    },
};

// ============================================================
// Tool Registry
// ============================================================

// ============================================================
// gemini_code — Gemini CLI for complex coding tasks
// ============================================================

const geminiCodeTool: ToolDefinition = {
    name: 'gemini_code',
    description: 'Delegate a complex coding task to the Gemini CLI agent. Use this for multi-file refactors, generating entire features, debugging complex issues, or any task that benefits from a dedicated coding agent with file access. The Gemini CLI will execute in the specified directory and can read/write files, run commands, etc.',
    parameters: {
        type: 'object',
        properties: {
            prompt: { type: 'string', description: 'The coding task description. Be specific about what files to change, what to implement, constraints, etc.' },
            working_directory: { type: 'string', description: 'Working directory for the Gemini CLI. Defaults to current directory if not specified.' },
        },
        required: ['prompt'],
    },
    async execute(args: Record<string, any>) {
        const prompt = args.prompt;
        const cwd = args.working_directory || process.cwd();

        try {
            log.info('Delegating to Gemini CLI', { prompt: prompt.slice(0, 100), cwd });

            const output = execSync(
                `npx -y @google/gemini-cli --non-interactive "${prompt.replace(/"/g, '\\"')}"`,
                {
                    cwd,
                    timeout: 5 * 60 * 1000, // 5 minute timeout
                    encoding: 'utf-8',
                    maxBuffer: 5 * 1024 * 1024, // 5MB output buffer
                    env: { ...process.env },
                }
            );

            // Truncate if too long to avoid bloating LLM context
            const maxLen = 8000;
            if (output.length > maxLen) {
                return output.slice(0, maxLen) + `\n\n... [output truncated, ${output.length - maxLen} chars omitted]`;
            }
            return output || 'Gemini CLI completed (no output).';
        } catch (err: any) {
            if (err.stdout) {
                // Command failed but produced output — return what we got
                const output = err.stdout.toString().slice(0, 8000);
                return `Gemini CLI completed with errors:\n\n${output}\n\nError: ${err.message}`;
            }
            return `Error running Gemini CLI: ${err.message}`;
        }
    },
};

// ============================================================
// Multi-Step Plan Tools
// ============================================================

interface PlanStep {
    description: string;
    status: 'pending' | 'done' | 'skipped';
}

interface Plan {
    id: string;
    goal: string;
    steps: PlanStep[];
    created: number;
}

const activePlans = new Map<string, Plan>();

const createPlanTool: ToolDefinition = {
    name: 'create_plan',
    description: 'Decompose a complex goal into a numbered list of concrete steps. Returns a plan ID that can be used with advance_plan to track progress. Use this when a task has 3+ distinct phases.',
    parameters: {
        type: 'object',
        properties: {
            goal: { type: 'string', description: 'The overall objective' },
            steps: {
                type: 'array',
                items: { type: 'string' },
                description: 'Ordered list of concrete steps to achieve the goal'
            }
        },
        required: ['goal', 'steps']
    },
    execute: async (args: Record<string, any>): Promise<string> => {
        const { goal, steps } = args;
        if (!steps || !Array.isArray(steps) || steps.length === 0) {
            return 'Error: steps must be a non-empty array of strings';
        }
        const id = `plan_${Date.now()}`;
        const plan: Plan = {
            id,
            goal,
            steps: steps.map((s: string) => ({ description: s, status: 'pending' as const })),
            created: Date.now()
        };
        activePlans.set(id, plan);
        const stepList = plan.steps.map((s, i) => `  ${i + 1}. [ ] ${s.description}`).join('\n');
        return `Plan created: ${id}\nGoal: ${goal}\n\nSteps:\n${stepList}`;
    }
};

const advancePlanTool: ToolDefinition = {
    name: 'advance_plan',
    description: 'Mark a step in an active plan as done or skipped. Returns the updated plan status with progress.',
    parameters: {
        type: 'object',
        properties: {
            plan_id: { type: 'string', description: 'The plan ID from create_plan' },
            step_number: { type: 'number', description: 'The 1-based step number to update' },
            status: { type: 'string', enum: ['done', 'skipped'], description: 'New status for the step' },
            notes: { type: 'string', description: 'Optional notes about what was accomplished' }
        },
        required: ['plan_id', 'step_number', 'status']
    },
    execute: async (args: Record<string, any>): Promise<string> => {
        const { plan_id, step_number, status, notes } = args;
        const plan = activePlans.get(plan_id);
        if (!plan) return `Error: No plan found with id ${plan_id}`;

        const idx = step_number - 1;
        if (idx < 0 || idx >= plan.steps.length) return `Error: Step ${step_number} out of range (1-${plan.steps.length})`;

        plan.steps[idx].status = status;

        const done = plan.steps.filter(s => s.status === 'done').length;
        const total = plan.steps.length;
        const pct = Math.round((done / total) * 100);

        const stepList = plan.steps.map((s, i) => {
            const icon = s.status === 'done' ? '✅' : s.status === 'skipped' ? '⏭️' : '⬜';
            return `  ${i + 1}. ${icon} ${s.description}`;
        }).join('\n');

        const allDone = plan.steps.every(s => s.status !== 'pending');
        let result = `Plan: ${plan.goal}\nProgress: ${done}/${total} (${pct}%)\n\n${stepList}`;
        if (notes) result += `\n\nNotes: ${notes}`;
        if (allDone) {
            result += '\n\n🎉 Plan complete!';
            activePlans.delete(plan_id);
        }
        return result;
    }
};

// ============================================================
// Smart Notification Tool
// ============================================================

const sendNotificationTool: ToolDefinition = {
    name: 'send_notification',
    description: 'Send a proactive notification to the user via their preferred channels (Google Chat, UI toast, etc). Use SPARINGLY — only for important discoveries, completed background tasks, time-sensitive alerts, or security concerns. Do NOT use for routine responses.',
    parameters: {
        type: 'object',
        properties: {
            message: { type: 'string', description: 'Brief notification message (1-2 sentences)' },
            priority: { type: 'string', enum: ['info', 'warning', 'urgent'], description: 'Priority level' },
            category: { type: 'string', enum: ['discovery', 'reminder', 'completion', 'security', 'error'], description: 'Notification category' }
        },
        required: ['message', 'priority']
    },
    execute: async (args: Record<string, any>): Promise<string> => {
        const { message, priority, category } = args;
        toolEvents.emit('notification', { message, priority: priority || 'info', category: category || 'info', timestamp: Date.now() });
        return `Notification sent: [${priority}] ${message}`;
    }
};

const ALL_TOOLS: ToolDefinition[] = [
    readFileTool,
    writeFileTool,
    editFileTool,
    bashTool,
    webSearchTool,
    webFetchTool,
    listDirectoryTool,
    generateImageTool,
    geminiCodeTool,
    gitStatusTool,
    gitDiffTool,
    gitCommitTool,
    gitLogTool,
    gitBackupTool,
    clipboardReadTool,
    clipboardWriteTool,
    readPdfTool,
    ...browserTools,
    createPlanTool,
    advancePlanTool,
    sendNotificationTool,
];

const toolMap = new Map<string, ToolDefinition>();
for (const tool of ALL_TOOLS) {
    toolMap.set(tool.name, tool);
}

/**
 * Register a dynamically-created tool at runtime.
 */
export function registerTool(tool: ToolDefinition): void {
    ALL_TOOLS.push(tool);
    toolMap.set(tool.name, tool);
    log.info(`Registered tool: ${tool.name}`);
}

export function getAllTools(): ToolDefinition[] {
    return ALL_TOOLS;
}

export function getTool(name: string): ToolDefinition | undefined {
    return toolMap.get(name);
}

/**
 * Validate a tool call before execution.
 * Returns null if valid, or an error string if invalid.
 */
export function validateToolCall(name: string, args: Record<string, any>): string | null {
    const tool = toolMap.get(name);
    if (!tool) {
        const available = ALL_TOOLS.map(t => t.name).join(', ');
        return `Unknown tool "${name}". Available tools: ${available}`;
    }

    const required: string[] = tool.parameters?.required || [];
    const missing = required.filter(param => !(param in args) || args[param] === undefined || args[param] === null);
    if (missing.length > 0) {
        return `Tool "${name}" is missing required parameter(s): ${missing.join(', ')}`;
    }

    return null;
}

export async function executeTool(name: string, args: Record<string, any>): Promise<string> {
    // Pre-validate
    const validationError = validateToolCall(name, args);
    if (validationError) {
        log.warn(`Tool validation failed: ${name}`, { error: validationError });
        return `Error: ${validationError}`;
    }

    const tool = toolMap.get(name)!;
    log.info(`Executing tool: ${name}`, { args: Object.keys(args) });

    // First attempt
    try {
        return await tool.execute(args);
    } catch (err: any) {
        log.warn(`Tool failed (attempt 1): ${name}`, { error: err.message });

        // Self-healing: adjust args and retry once
        const adjustedArgs = adjustArgsForRetry(name, args, err.message);
        if (adjustedArgs) {
            log.info(`Retrying ${name} with adjusted args`);
            try {
                return await tool.execute(adjustedArgs);
            } catch (retryErr: any) {
                log.warn(`Tool retry also failed: ${name}`, { error: retryErr.message });
            }
        }

        // Try alternative tool if available
        const alt = TOOL_ALTERNATIVES.get(name);
        if (alt) {
            const altTool = toolMap.get(alt.tool);
            if (altTool) {
                const altArgs = alt.mapArgs(args);
                log.info(`Falling back to alternative tool: ${alt.tool}`);
                try {
                    return await altTool.execute(altArgs);
                } catch (altErr: any) {
                    log.warn(`Alternative tool also failed: ${alt.tool}`, { error: altErr.message });
                }
            }
        }

        // All attempts exhausted
        return `Error executing tool ${name}: ${err.message}\n\nSuggestion: Check the arguments and try again. The tool expects: ${JSON.stringify(tool.parameters.properties, null, 2)}`;
    }
}

// Maps tools to their alternatives (fallbacks when the primary fails)
const TOOL_ALTERNATIVES = new Map<string, { tool: string; mapArgs: (args: Record<string, any>) => Record<string, any> }>([
    ['web_fetch', { tool: 'browse_page', mapArgs: (args) => ({ url: args.url }) }],
    ['browse_page', { tool: 'web_fetch', mapArgs: (args) => ({ url: args.url }) }],
    ['read_file', { tool: 'bash', mapArgs: (args) => ({ command: `cat "${args.path}"` }) }],
]);

// Adjusts tool args for a retry based on the error message
function adjustArgsForRetry(name: string, args: Record<string, any>, error: string): Record<string, any> | null {
    const lowerErr = error.toLowerCase();

    // Timeouts → increase timeout / reduce scope
    if (lowerErr.includes('timeout') || lowerErr.includes('timed out')) {
        if (name === 'bash' && args.command) {
            return { ...args, timeout: (args.timeout || 30000) * 2 };
        }
        if (name === 'browse_page' || name === 'web_fetch') {
            return { ...args, max_length: Math.min(args.max_length || 5000, 2000) };
        }
    }

    // Permission denied → try with sudo hint
    if (lowerErr.includes('permission denied') && name === 'bash') {
        return null; // Don't auto-sudo; return null to try alternative
    }

    // File not found → check with different casing or path
    if (lowerErr.includes('enoent') || lowerErr.includes('no such file') || lowerErr.includes('not found')) {
        if (name === 'read_file' && args.path) {
            // Try with ./ prefix
            if (!args.path.startsWith('/') && !args.path.startsWith('./')) {
                return { ...args, path: `./${args.path}` };
            }
        }
    }

    return null;
}

/**
 * Recursively sanitize a JSON Schema for Gemini compatibility.
 * - Converts numeric enum values to strings (Gemini requires TYPE_STRING for all enums)
 * - Strips unsupported schema fields
 */
function sanitizeSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema;

    const result = { ...schema };

    // Gemini requires enum only on STRING type — coerce type + values
    if (Array.isArray(result.enum)) {
        result.enum = result.enum.map((v: any) => String(v));
        if (result.type && result.type !== 'string') {
            result.type = 'string';
        }
    }

    // Recurse into properties
    if (result.properties && typeof result.properties === 'object') {
        const sanitized: Record<string, any> = {};
        for (const [key, value] of Object.entries(result.properties)) {
            sanitized[key] = sanitizeSchema(value);
        }
        result.properties = sanitized;
    }

    // Recurse into items (for arrays)
    if (result.items) {
        result.items = sanitizeSchema(result.items);
    }

    // Recurse into anyOf, oneOf, allOf
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
        if (Array.isArray(result[key])) {
            result[key] = result[key].map((s: any) => sanitizeSchema(s));
        }
    }

    return result;
}

/**
 * Convert tools to Gemini function declarations format.
 * Send core tools + all MCP tools to the model.
 * Non-core built-in tools remain registered and executable — just not advertised.
 */
export function toGeminiFunctionDeclarations() {
    const CORE_TOOLS = new Set([
        'bash', 'read_file', 'write_file', 'edit_file',
        'web_search', 'search_memory', 'semantic_search', 'search_codebase',
        'set_reminder', 'generate_image', 'delegate_task', 'code', 'workspace_status',
        'browse_page', 'create_cron_job', 'list_cron_jobs', 'delete_cron_job',
        'deep_research', 'parallel_tasks',
        'knowledge_graph', 'add_knowledge',
        'gmail_search', 'gmail_read', 'gmail_send',
        'calendar_list', 'calendar_create',
        'drive_list', 'drive_search', 'sheets_read',
        'docs_get', 'docs_create', 'slides_get',
        'tasks_list', 'tasks_create', 'contacts_search',
        'chat_send', 'chat_list_spaces',
        'keep_list', 'keep_create', 'meet_create', 'forms_responses',
        'standup_report', 'meeting_prep', 'email_to_task', 'weekly_digest', 'file_announce',
        'drive_download', 'sheets_write', 'docs_append', 'workspace_search', 'workspace_pipeline',
        'list_playbooks', 'run_playbook',
        'find_free_time', 'schedule_meeting', 'time_block', 'meeting_cost',
        'generate_document', 'brief_person', 'relationship_health',
        'analyze_image', 'analyze_screenshot', 'time_analysis',
        'github_repos', 'github_issues', 'github_create_issue', 'github_prs', 'github_search_code',
        'delegate_tasks', 'kb_search', 'kb_add', 'kb_list', 'kb_stats',
        'compose_email', 'list_approvals', 'approve_action', 'reject_action',
        'browse_templates', 'install_template',
        'create_automation', 'list_automations', 'toggle_automation', 'delete_automation',
        'start_background_task', 'check_task_status', 'list_background_tasks',
    ]);
    return ALL_TOOLS
        .filter(tool => CORE_TOOLS.has(tool.name) || tool.name.startsWith('mcp_'))
        .map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: sanitizeSchema(tool.parameters),
        }));
}

/**
 * Register cron job management tools bound to a CronJobManager instance.
 * Called at startup after CronJobManager is initialized.
 */
export function registerCronTools(manager: CronJobManager): void {
    registerTool({
        name: 'create_cron_job',
        description: 'Create a new scheduled cron job. The job will run automatically at the specified schedule and deliver results to Google Chat. Use standard cron expressions (e.g. "0 9 * * 1-5" = weekdays at 9am, "*/30 * * * *" = every 30 min).',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Human-readable name for the job (e.g. "Morning Briefing")' },
                cronExpr: { type: 'string', description: 'Cron expression for the schedule (e.g. "0 7 * * 1-5")' },
                prompt: { type: 'string', description: 'The prompt/instruction to execute when the job fires' },
                isolated: { type: 'boolean', description: 'Run in isolated context (default: true). Isolated jobs don\'t affect chat history.' },
            },
            required: ['name', 'cronExpr', 'prompt'],
        },
        async execute(args) {
            try {
                const job = manager.addJob({
                    id: `job_${Date.now().toString(36)}`,
                    name: args.name,
                    cronExpr: args.cronExpr,
                    prompt: args.prompt,
                    isolated: args.isolated !== false,
                    enabled: true,
                });
                return `✅ Cron job created: "${job.name}" (${job.cronExpr})\nID: ${job.id}\nNext run will be based on the cron schedule.`;
            } catch (err: any) {
                return `❌ Failed to create cron job: ${err.message}`;
            }
        },
    });

    registerTool({
        name: 'list_cron_jobs',
        description: 'List all scheduled cron jobs with their status, last run time, and schedule.',
        parameters: {
            type: 'object',
            properties: {},
            required: [],
        },
        async execute() {
            const jobs = manager.listJobs();
            if (jobs.length === 0) return 'No cron jobs configured.';

            return jobs.map(j => {
                const status = j.enabled ? '🟢 Active' : '⏸️ Paused';
                const lastRun = j.lastRun ? `Last run: ${j.lastRun}` : 'Never run';
                return `${status} **${j.name}** (${j.cronExpr})\n  ID: ${j.id} | ${lastRun} | Isolated: ${j.isolated}`;
            }).join('\n\n');
        },
    });

    registerTool({
        name: 'delete_cron_job',
        description: 'Delete a scheduled cron job by its ID.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'The job ID to delete (e.g. "job_morning_brief")' },
            },
            required: ['id'],
        },
        async execute(args) {
            const removed = manager.removeJob(args.id);
            return removed
                ? `✅ Cron job "${args.id}" deleted.`
                : `❌ No cron job found with ID "${args.id}".`;
        },
    });

    log.info('Cron job tools registered: create_cron_job, list_cron_jobs, delete_cron_job');
}
