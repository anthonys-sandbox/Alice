import { resolve, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { createLogger } from '../../utils/logger.js';
import type { ToolDefinition } from './registry.js';

const log = createLogger('Browser');

// ── Singleton browser session ─────────────────────────────────
// Stays alive between tool calls so Toby can navigate, click,
// type, and screenshot in sequence — like a real user.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let browser: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let page: any = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const NAV_TIMEOUT_MS = 30_000;           // 30 seconds per navigation

function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
        await closeBrowser();
        log.info('Browser closed due to inactivity');
    }, IDLE_TIMEOUT_MS);
}

async function getBrowser(): Promise<any> {
    if (!browser || !browser.connected) {
        log.info('Launching browser...');
        // Dynamic import so puppeteer is only loaded when actually needed.
        // Toby starts fine even if puppeteer/Chromium is not installed.
        const { default: puppeteer } = await import('puppeteer');
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
            ],
        });
    }
    resetIdleTimer();
    return browser;
}

async function getPage(): Promise<any> {
    const b = await getBrowser();
    if (!page || page.isClosed()) {
        const pages = await b.pages();
        page = pages.length > 0 ? pages[0] : await b.newPage();
        await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
    }
    return page;
}

async function closeBrowser(): Promise<void> {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (browser) {
        try { await browser.close(); } catch { /* ignore */ }
        browser = null;
        page = null;
    }
}

// ── Tools ─────────────────────────────────────────────────────

export const browsePageTool: ToolDefinition = {
    name: 'browse_page',
    description: 'Navigate to a URL and return the page text content. Use this to read web pages, documentation, or search results. Returns the visible text, page title, and current URL.',
    parameters: {
        type: 'object',
        properties: {
            url: { type: 'string', description: 'The URL to navigate to' },
            wait_for: { type: 'string', description: 'Optional CSS selector to wait for before extracting text' },
        },
        required: ['url'],
    },
    async execute(args) {
        try {
            const p = await getPage();
            log.info(`Navigating to ${args.url}`);
            await p.goto(args.url, {
                waitUntil: 'networkidle2',
                timeout: NAV_TIMEOUT_MS,
            });

            if (args.wait_for) {
                await p.waitForSelector(args.wait_for, { timeout: 10_000 }).catch(() => { });
            }

            // Wait a bit for dynamic content
            await new Promise(r => setTimeout(r, 1500));

            const title = await p.title();
            const url = p.url();
            const text = await p.evaluate(() => {
                // Remove script/style/nav/footer
                const remove = document.querySelectorAll('script, style, nav, footer, header, [role="navigation"]');
                remove.forEach(el => el.remove());
                return document.body?.innerText || '';
            });

            const trimmed = text.length > 8000
                ? text.slice(0, 8000) + '\n\n... (truncated)'
                : text;

            return `Page: ${title}\nURL: ${url}\n\n${trimmed}`;
        } catch (err: any) {
            return `Error browsing ${args.url}: ${err.message}`;
        }
    },
};

export const screenshotTool: ToolDefinition = {
    name: 'screenshot',
    description: 'Take a screenshot of the current browser page. Returns the path to the saved image. Use browse_page first to navigate to a URL.',
    parameters: {
        type: 'object',
        properties: {
            full_page: { type: 'boolean', description: 'Capture the full scrollable page, not just the viewport (default: false)' },
            selector: { type: 'string', description: 'Optional CSS selector to screenshot a specific element' },
        },
        required: [],
    },
    async execute(args) {
        try {
            const p = await getPage();
            const currentUrl = p.url();
            if (currentUrl === 'about:blank') {
                return 'Error: No page loaded. Use browse_page first to navigate to a URL.';
            }

            const outputDir = resolve('generated_images');
            if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

            const fileName = `screenshot_${Date.now()}.png`;
            const outputPath = join(outputDir, fileName);

            if (args.selector) {
                const element = await p.$(args.selector);
                if (!element) return `Error: Element not found: ${args.selector}`;
                await element.screenshot({ path: outputPath });
            } else {
                // Wait briefly for any late-loading content
                await new Promise(r => setTimeout(r, 1000));
                await p.screenshot({
                    path: outputPath,
                    fullPage: args.full_page ?? false,
                });
            }

            log.info(`Screenshot saved: ${outputPath}`);
            return `Screenshot saved!\n\n![Screenshot](/images/${fileName})\n\nFile: ${outputPath}\nPage: ${currentUrl}`;
        } catch (err: any) {
            return `Error taking screenshot: ${err.message}`;
        }
    },
};

export const clickElementTool: ToolDefinition = {
    name: 'click_element',
    description: 'Click an element on the current browser page by CSS selector. Use browse_page first to navigate.',
    parameters: {
        type: 'object',
        properties: {
            selector: { type: 'string', description: 'CSS selector of the element to click (e.g., "button.submit", "a[href="/about"]")' },
        },
        required: ['selector'],
    },
    async execute(args) {
        try {
            const p = await getPage();
            const currentUrl = p.url();
            if (currentUrl === 'about:blank') {
                return 'Error: No page loaded. Use browse_page first.';
            }

            await p.waitForSelector(args.selector, { timeout: 10_000 });
            await p.click(args.selector);

            // Wait for any navigation or DOM changes
            await new Promise(r => setTimeout(r, 2000));

            const newUrl = p.url();
            const navigated = newUrl !== currentUrl ? `\nNavigated to: ${newUrl}` : '';
            return `Clicked: ${args.selector}${navigated}`;
        } catch (err: any) {
            return `Error clicking "${args.selector}": ${err.message}`;
        }
    },
};

export const typeTextTool: ToolDefinition = {
    name: 'type_text',
    description: 'Type text into an input field on the current browser page. Clears the field first, then types the text.',
    parameters: {
        type: 'object',
        properties: {
            selector: { type: 'string', description: 'CSS selector of the input field' },
            text: { type: 'string', description: 'The text to type' },
            submit: { type: 'boolean', description: 'Press Enter after typing (default: false)' },
        },
        required: ['selector', 'text'],
    },
    async execute(args) {
        try {
            const p = await getPage();
            if (p.url() === 'about:blank') {
                return 'Error: No page loaded. Use browse_page first.';
            }

            await p.waitForSelector(args.selector, { timeout: 10_000 });

            // Clear existing content and type
            await p.click(args.selector, { clickCount: 3 }); // select all
            await p.type(args.selector, args.text);

            if (args.submit) {
                await p.keyboard.press('Enter');
                await new Promise(r => setTimeout(r, 2000));
            }

            const newUrl = p.url();
            return `Typed "${args.text.slice(0, 50)}${args.text.length > 50 ? '...' : ''}" into ${args.selector}${args.submit ? ' (submitted)' : ''}\nCurrent URL: ${newUrl}`;
        } catch (err: any) {
            return `Error typing into "${args.selector}": ${err.message}`;
        }
    },
};

export const browserTools = [browsePageTool, screenshotTool, clickElementTool, typeTextTool];
