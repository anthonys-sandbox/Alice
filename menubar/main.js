const { menubar } = require('menubar');
const path = require('path');
const http = require('http');

const ALICE_URL = 'http://localhost:18790/';
const HEALTH_URL = 'http://localhost:18790/health';
const HEALTH_CHECK_INTERVAL = 3000;

const mb = menubar({
    index: false, // Don't load a URL on startup — we'll handle it ourselves
    icon: path.join(__dirname, 'iconTemplate.png'),
    preloadWindow: true,
    showDockIcon: false,
    browserWindow: {
        width: 420,
        height: 640,
        resizable: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
    },
    tooltip: 'Alice AI',
});

let isAliceOnline = false;
let healthCheckTimer = null;

/**
 * Check if Alice server is reachable.
 */
function checkAliceHealth() {
    return new Promise((resolve) => {
        const req = http.get(HEALTH_URL, { timeout: 2000 }, (res) => {
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

/**
 * Monitor Alice's availability and auto-reconnect when she comes back.
 */
function startHealthCheck() {
    healthCheckTimer = setInterval(async () => {
        const online = await checkAliceHealth();

        if (online && !isAliceOnline) {
            // Alice came back online — reload the UI
            console.log('✨ Alice is back online, reloading...');
            isAliceOnline = true;
            if (mb.window) {
                mb.window.loadURL(ALICE_URL);
            }
        } else if (!online && isAliceOnline) {
            // Alice went offline — show offline page
            console.log('⚠️  Alice went offline');
            isAliceOnline = false;
            if (mb.window) {
                showOfflinePage();
            }
        }
    }, HEALTH_CHECK_INTERVAL);
}

function showOfflinePage() {
    mb.window.loadURL(`data:text/html,
        <html>
        <head>
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    height: 100vh;
                    margin: 0;
                    background: #131314;
                    color: #e0e0ff;
                }
                h2 { margin-bottom: 8px; }
                p { color: #8888aa; margin-bottom: 20px; font-size: 13px; }
                .spinner {
                    width: 24px; height: 24px;
                    border: 3px solid #333;
                    border-top-color: #7c3aed;
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                }
                @keyframes spin { to { transform: rotate(360deg); } }
            </style>
        </head>
        <body>
            <h2>✨ Alice</h2>
            <p>Waiting for Alice to come online...</p>
            <div class="spinner"></div>
        </body>
        </html>
    `);
}

mb.on('ready', async () => {
    console.log('✨ Alice menu bar app ready');

    // Show offline page first, then check health
    showOfflinePage();
    isAliceOnline = false;

    // Do an immediate health check
    const online = await checkAliceHealth();
    if (online) {
        console.log('✨ Alice is online, loading UI...');
        isAliceOnline = true;
        mb.window.loadURL(ALICE_URL);
    }

    // Start periodic health monitoring
    startHealthCheck();

    // If launched by Alice (parent process), quit when parent dies
    if (process.ppid && process.ppid > 1) {
        const parentCheckTimer = setInterval(() => {
            try {
                process.kill(process.ppid, 0);
            } catch {
                console.log('Parent process gone, quitting menubar');
                clearInterval(parentCheckTimer);
                mb.app.quit();
            }
        }, 2000);
    }
});

mb.on('after-create-window', () => {
    // Handle connection errors gracefully
    mb.window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
        console.log(`Connection failed (${errorCode}): ${errorDescription}`);
        isAliceOnline = false;
        showOfflinePage();
    });

    // Auto-grant microphone permission for voice dictation
    mb.window.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
        if (permission === 'media' || permission === 'microphone') {
            callback(true);
        } else {
            callback(false);
        }
    });
});

// Quit when all windows are closed (macOS)
mb.app.on('window-all-closed', (e) => {
    e.preventDefault(); // Keep running in menu bar
});
