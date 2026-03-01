import { readdirSync, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { parseMarkdownFile } from '../utils/markdown.js';
import { createLogger } from '../utils/logger.js';
import { registerTool, type ToolDefinition } from '../runtime/tools/registry.js';

const log = createLogger('Skills');

export interface SkillToolDef {
    name: string;
    description: string;
    parameters?: Record<string, any>;
    command: string;   // Shell command to execute. Use {{arg_name}} for parameter substitution.
}

export interface Skill {
    name: string;
    description: string;
    tools?: string[];           // Informational: which built-in tools this skill uses
    custom_tools?: SkillToolDef[];  // Dynamic tools this skill provides
    requires?: string[];
    content: string;
    source: string; // which directory it came from
}

/**
 * Load all skills from the configured directories.
 * Later directories have higher priority (project-local > user-global > bundled).
 */
export function loadSkills(skillDirs: string[]): Skill[] {
    const skillMap = new Map<string, Skill>();

    for (const dir of skillDirs) {
        if (!existsSync(dir)) {
            log.debug(`Skills directory not found, skipping: ${dir}`);
            continue;
        }

        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const skillPath = join(dir, entry.name, 'SKILL.md');
            if (!existsSync(skillPath)) continue;

            const parsed = parseMarkdownFile(skillPath);
            if (!parsed) continue;

            const skill: Skill = {
                name: parsed.frontmatter.name || entry.name,
                description: parsed.frontmatter.description || '',
                tools: parsed.frontmatter.tools,
                custom_tools: parsed.frontmatter.custom_tools,
                requires: parsed.frontmatter.requires,
                content: parsed.content,
                source: dir,
            };

            // Check requirements (required binaries)
            if (skill.requires && !checkRequirements(skill.requires)) {
                log.warn(`Skill "${skill.name}" skipped: missing requirements`, { requires: skill.requires });
                continue;
            }

            // Register any custom tools this skill provides
            if (skill.custom_tools && Array.isArray(skill.custom_tools)) {
                for (const toolDef of skill.custom_tools) {
                    registerSkillTool(toolDef, join(dir, entry.name));
                }
            }

            // Auto-install npm dependencies if package.json exists
            const pkgPath = join(dir, entry.name, 'package.json');
            const nodeModules = join(dir, entry.name, 'node_modules');
            if (existsSync(pkgPath) && !existsSync(nodeModules)) {
                try {
                    log.info(`Installing dependencies for skill: ${skill.name}`);
                    execSync('npm install --production', {
                        cwd: join(dir, entry.name),
                        stdio: 'ignore',
                        timeout: 60000,
                    });
                } catch (err: any) {
                    log.warn(`Failed to install deps for skill "${skill.name}"`, { error: err.message });
                }
            }

            skillMap.set(skill.name, skill);
            log.debug(`Loaded skill: ${skill.name}`, { source: dir });
        }
    }

    const skills = Array.from(skillMap.values());
    log.info(`Loaded ${skills.length} skills`);
    return skills;
}

/**
 * Register a skill-defined custom tool.
 * The tool executes a shell command with parameter substitution.
 */
function registerSkillTool(toolDef: SkillToolDef, skillDir: string): void {
    if (!toolDef.name || !toolDef.command) {
        log.warn('Skill tool missing name or command, skipping');
        return;
    }

    const tool: ToolDefinition = {
        name: toolDef.name,
        description: toolDef.description || `Custom tool from skill`,
        parameters: toolDef.parameters || { type: 'object', properties: {}, required: [] },
        async execute(args: Record<string, any>) {
            try {
                // Substitute {{param}} placeholders with actual args
                let cmd = toolDef.command;
                for (const [key, value] of Object.entries(args)) {
                    cmd = cmd.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
                }

                log.info(`Executing skill tool: ${toolDef.name}`, { command: cmd.slice(0, 100) });
                const output = execSync(cmd, {
                    cwd: skillDir,
                    timeout: 30000,
                    encoding: 'utf-8',
                    maxBuffer: 1024 * 1024,
                });
                return output.trim() || 'Command completed successfully (no output).';
            } catch (err: any) {
                return `Error executing ${toolDef.name}: ${err.message}`;
            }
        },
    };

    registerTool(tool);
    log.info(`Registered skill tool: ${toolDef.name}`);
}

/**
 * Check if required system binaries are available.
 */
function checkRequirements(requires: string[]): boolean {
    for (const req of requires) {
        try {
            execSync(`which ${req}`, { stdio: 'ignore' });
        } catch {
            return false;
        }
    }
    return true;
}

/**
 * Install a skill from a git URL or local path.
 * Returns the installed skill name or throws on failure.
 */
export function installSkill(source: string, targetDir: string): string {
    const isGitUrl = source.startsWith('http') || source.startsWith('git@') || source.includes('.git');

    if (isGitUrl) {
        // Extract repo name from URL
        const repoName = source.split('/').pop()?.replace('.git', '') || `skill-${Date.now()}`;
        const destPath = join(targetDir, repoName);

        if (existsSync(destPath)) {
            // Pull latest instead of cloning
            log.info(`Skill "${repoName}" already exists, pulling latest...`);
            execSync('git pull', { cwd: destPath, stdio: 'ignore', timeout: 30000 });
        } else {
            log.info(`Cloning skill from ${source}...`);
            execSync(`git clone "${source}" "${destPath}"`, { stdio: 'ignore', timeout: 60000 });
        }

        // Install dependencies if package.json exists
        const pkgPath = join(destPath, 'package.json');
        if (existsSync(pkgPath)) {
            log.info(`Installing dependencies for ${repoName}...`);
            execSync('npm install --production', { cwd: destPath, stdio: 'ignore', timeout: 60000 });
        }

        // Verify SKILL.md exists
        if (!existsSync(join(destPath, 'SKILL.md'))) {
            log.warn(`No SKILL.md found in ${repoName} — skill may not load`);
        }

        return repoName;
    }

    // Local path — just verify it exists
    const absPath = resolve(source);
    if (!existsSync(absPath) || !existsSync(join(absPath, 'SKILL.md'))) {
        throw new Error(`Not a valid skill path: ${source} (must contain SKILL.md)`);
    }

    // Symlink or copy to the target dir
    const skillName = absPath.split('/').pop() || 'unnamed-skill';
    const destPath = join(targetDir, skillName);
    if (!existsSync(destPath)) {
        execSync(`ln -s "${absPath}" "${destPath}"`, { stdio: 'ignore' });
    }

    return skillName;
}

/**
 * Build skill instructions to inject into the system prompt.
 */
export function buildSkillPrompt(skills: Skill[]): string {
    if (skills.length === 0) return '';

    const sections = skills.map(skill => {
        let section = `### Skill: ${skill.name}\n${skill.description}\n\n${skill.content}`;
        if (skill.custom_tools && skill.custom_tools.length > 0) {
            const toolNames = skill.custom_tools.map(t => t.name).join(', ');
            section += `\n\n**Custom tools provided:** ${toolNames}`;
        }
        return section;
    });

    return `<skills>\n${sections.join('\n\n---\n\n')}\n</skills>`;
}
