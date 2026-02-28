import matter from 'gray-matter';
import { readFileSync, existsSync } from 'fs';

export interface ParsedMarkdown {
    frontmatter: Record<string, any>;
    content: string;
    raw: string;
}

/**
 * Parse a Markdown file with optional YAML frontmatter.
 * Returns the frontmatter as a structured object and the body content.
 */
export function parseMarkdownFile(filePath: string): ParsedMarkdown | null {
    if (!existsSync(filePath)) return null;

    const raw = readFileSync(filePath, 'utf-8');
    return parseMarkdownString(raw);
}

/**
 * Parse a Markdown string with optional YAML frontmatter.
 */
export function parseMarkdownString(raw: string): ParsedMarkdown {
    const { data: frontmatter, content } = matter(raw);
    return { frontmatter, content: content.trim(), raw };
}

/**
 * Basic Markdown to Google Chat format converter.
 * Google Chat supports limited formatting:
 * - *bold*
 * - _italic_
 * - ~strikethrough~
 * - `inline code`
 * - ```multiline code```
 */
export function formatForGoogleChat(text: string): string {
    if (!text) return '';

    return text
        // 1. Convert headers (# Header) to bold (*Header*)
        .replace(/^#+\s+(.*)$/gm, '*$1*')
        
        // 2. Format bullet points (use a real bullet char)
        .replace(/^\s*[-*+]\s+/gm, '• ')
        
        // 3. Format numbered lists (ensure they look okay)
        .replace(/^\s*(\d+)\.\s+/gm, '$1. ')
        
        // 4. Handle blockquotes (Google Chat doesn't support them well, use italics)
        .replace(/^\s*>\s+(.*)$/gm, '_"$1"_')
        
        // 5. Clean up bold/italic for Google Chat (Google Chat doesn't like double asterisks)
        .replace(/\*\*(.*?)\*\*/g, '*$1*')
        .replace(/__(.*?)__/g, '_$1_')
        
        // 6. Ensure code blocks are clean
        .replace(/```[a-z]*\n([\s\S]*?)\n```/g, '```\n$1\n```');
}

