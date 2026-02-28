import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parseMarkdownFile } from '../utils/markdown.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Skills');

export interface Skill {
    name: string;
    description: string;
    tools?: string[];
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
                requires: parsed.frontmatter.requires,
                content: parsed.content,
                source: dir,
            };

            // Check requirements (required binaries)
            if (skill.requires && !checkRequirements(skill.requires)) {
                log.warn(`Skill "${skill.name}" skipped: missing requirements`, { requires: skill.requires });
                continue;
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
 * Check if required system binaries are available.
 */
function checkRequirements(requires: string[]): boolean {
    for (const req of requires) {
        try {
            const { execSync } = require('child_process');
            execSync(`which ${req}`, { stdio: 'ignore' });
        } catch {
            return false;
        }
    }
    return true;
}

/**
 * Build skill instructions to inject into the system prompt.
 */
export function buildSkillPrompt(skills: Skill[]): string {
    if (skills.length === 0) return '';

    const sections = skills.map(skill => {
        return `### Skill: ${skill.name}\n${skill.description}\n\n${skill.content}`;
    });

    return `<skills>\n${sections.join('\n\n---\n\n')}\n</skills>`;
}
