import { createLogger } from '../utils/logger.js';
import { join, resolve } from 'path';
import { mkdirSync, writeFileSync, existsSync } from 'fs';

const log = createLogger('ClawHub');

const BASE_URL = 'https://wry-manatee-359.convex.site/api/v1';

// ── Types ────────────────────────────────────────────────

export interface ClawHubSkill {
    slug: string;
    displayName: string;
    summary: string;
    tags: Record<string, string>;
    stats: {
        comments: number;
        downloads: number;
        installsAllTime: number;
        installsCurrent: number;
        stars: number;
        versions: number;
    };
    createdAt: number;
    updatedAt: number;
    latestVersion: {
        version: string;
        createdAt: number;
        changelog: string;
    };
    metadata?: Record<string, any> | null;
}

export interface ClawHubSoul {
    slug: string;
    displayName: string;
    summary: string;
    tags: Record<string, string>;
    stats: {
        comments: number;
        downloads: number;
        stars: number;
        versions: number;
    };
    createdAt: number;
    updatedAt: number;
    latestVersion: {
        version: string;
        createdAt: number;
        changelog: string;
    };
}

export interface ClawHubSearchResult {
    score: number;
    slug: string;
    displayName: string;
    summary: string;
    version: string | null;
    updatedAt: number;
}

// ── Client ───────────────────────────────────────────────

export class ClawHubClient {
    private skillsDir: string;

    constructor(projectRoot: string) {
        this.skillsDir = join(projectRoot, '.agents', 'skills');
    }

    // ── Search ───────────────────────────────────────────

    /** Vector search across skills and souls */
    async search(query: string): Promise<ClawHubSearchResult[]> {
        try {
            const res = await fetch(`${BASE_URL}/search?q=${encodeURIComponent(query)}`);
            if (!res.ok) throw new Error(`Search failed: ${res.status}`);
            const data = await res.json();
            return data.results || [];
        } catch (err: any) {
            log.error('ClawHub search failed', { error: err.message });
            return [];
        }
    }

    // ── Skills ───────────────────────────────────────────

    /** List all available skills */
    async listSkills(cursor?: string): Promise<{ items: ClawHubSkill[]; nextCursor?: string }> {
        try {
            let url = `${BASE_URL}/skills`;
            if (cursor) url += `?cursor=${cursor}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`List skills failed: ${res.status}`);
            const data = await res.json();
            return { items: data.items || [], nextCursor: data.nextCursor };
        } catch (err: any) {
            log.error('ClawHub list skills failed', { error: err.message });
            return { items: [] };
        }
    }

    /** Get skill details by owner/slug */
    async getSkill(ownerSlug: string): Promise<ClawHubSkill | null> {
        try {
            const res = await fetch(`${BASE_URL}/skills/${ownerSlug}`);
            if (!res.ok) return null;
            return await res.json();
        } catch (err: any) {
            log.error('ClawHub get skill failed', { error: err.message });
            return null;
        }
    }

    /** Download and install a skill to .agents/skills/ */
    async installSkill(slug: string): Promise<{ success: boolean; path?: string; error?: string }> {
        try {
            log.info(`Installing skill from ClawHub: ${slug}`);

            // Download the ZIP
            const downloadUrl = `${BASE_URL}/download?slug=${encodeURIComponent(slug)}`;
            const res = await fetch(downloadUrl);
            if (!res.ok) {
                throw new Error(`Download failed: ${res.status} ${res.statusText}`);
            }

            const contentType = res.headers.get('content-type') || '';

            // If it returns a ZIP, extract it
            if (contentType.includes('zip') || contentType.includes('octet-stream')) {
                const buffer = Buffer.from(await res.arrayBuffer());
                const targetDir = join(this.skillsDir, slug);
                mkdirSync(targetDir, { recursive: true });

                // Use AdmZip to extract
                try {
                    // Try adm-zip if available (optional dependency)
                    const AdmZip = require('adm-zip');
                    const zip = new AdmZip(buffer);
                    zip.extractAllTo(targetDir, true);
                    log.info(`Skill installed to ${targetDir}`);
                    return { success: true, path: targetDir };
                } catch {
                    // Fallback: save the ZIP and extract with unzip CLI
                    const zipPath = join(targetDir, `${slug}.zip`);
                    writeFileSync(zipPath, buffer);

                    const { execSync } = await import('child_process');
                    try {
                        execSync(`unzip -o "${zipPath}" -d "${targetDir}"`, { stdio: 'pipe' });
                        // Clean up zip
                        try { (await import('fs')).unlinkSync(zipPath); } catch { }
                        log.info(`Skill installed to ${targetDir} (via unzip)`);
                        return { success: true, path: targetDir };
                    } catch (unzipErr: any) {
                        log.error('Failed to extract skill ZIP', { error: unzipErr.message });
                        return { success: false, error: `Downloaded ZIP but extraction failed: ${unzipErr.message}` };
                    }
                }
            }

            // If it returns JSON (maybe the skill content directly)
            if (contentType.includes('json')) {
                const data = await res.json();
                const targetDir = join(this.skillsDir, slug);
                mkdirSync(targetDir, { recursive: true });

                // If it has a SKILL.md field, write it
                if (data.skillMd || data.content) {
                    writeFileSync(join(targetDir, 'SKILL.md'), data.skillMd || data.content);
                    return { success: true, path: targetDir };
                }

                // If it has files array
                if (data.files && Array.isArray(data.files)) {
                    for (const file of data.files) {
                        const filePath = join(targetDir, file.path || file.name);
                        mkdirSync(join(filePath, '..'), { recursive: true });
                        writeFileSync(filePath, file.content || '');
                    }
                    return { success: true, path: targetDir };
                }

                // Save raw JSON as fallback
                writeFileSync(join(targetDir, 'skill-data.json'), JSON.stringify(data, null, 2));
                return { success: true, path: targetDir };
            }

            // Plain text response — treat as SKILL.md content
            const text = await res.text();
            if (text.length > 0) {
                const targetDir = join(this.skillsDir, slug);
                mkdirSync(targetDir, { recursive: true });
                writeFileSync(join(targetDir, 'SKILL.md'), text);
                return { success: true, path: targetDir };
            }

            return { success: false, error: 'Empty response from ClawHub' };
        } catch (err: any) {
            log.error('ClawHub install skill failed', { error: err.message });
            return { success: false, error: err.message };
        }
    }

    /** Check if a skill is already installed locally */
    isInstalled(slug: string): boolean {
        const skillDir = join(this.skillsDir, slug);
        return existsSync(join(skillDir, 'SKILL.md'));
    }

    /** List locally installed skills */
    getInstalledSlugs(): string[] {
        try {
            const { readdirSync } = require('fs');
            const dirs = readdirSync(this.skillsDir, { withFileTypes: true });
            return dirs
                .filter((d: any) => d.isDirectory() && existsSync(join(this.skillsDir, d.name, 'SKILL.md')))
                .map((d: any) => d.name);
        } catch {
            return [];
        }
    }

    // ── Souls ────────────────────────────────────────────

    /** List all available souls */
    async listSouls(): Promise<ClawHubSoul[]> {
        try {
            const res = await fetch(`${BASE_URL}/souls`);
            if (!res.ok) throw new Error(`List souls failed: ${res.status}`);
            const data = await res.json();
            return data.items || [];
        } catch (err: any) {
            log.error('ClawHub list souls failed', { error: err.message });
            return [];
        }
    }

    /** Get soul details by slug */
    async getSoul(slug: string): Promise<ClawHubSoul | null> {
        try {
            const res = await fetch(`${BASE_URL}/souls/${slug}`);
            if (!res.ok) return null;
            return await res.json();
        } catch (err: any) {
            log.error('ClawHub get soul failed', { error: err.message });
            return null;
        }
    }
}
