const { menubar } = require('menubar');
const path = require('path');

const mb = menubar({
    index: `http://localhost:18790/`,
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

mb.on('ready', () => {
    console.log('✨ Alice menu bar app ready');
});

mb.on('after-create-window', () => {
    // Handle connection errors gracefully
    mb.window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
        console.log(`Connection failed (${errorCode}): ${errorDescription}`);
        // Show a retry page
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
                        background: #1a1a2e;
                        color: #e0e0ff;
                    }
                    h2 { margin-bottom: 8px; }
                    p { color: #8888aa; margin-bottom: 20px; }
                    button {
                        padding: 10px 24px;
                        border: none;
                        border-radius: 8px;
                        background: #7c3aed;
                        color: white;
                        font-size: 14px;
                        cursor: pointer;
                    }
                    button:hover { background: #6d28d9; }
                </style>
            </head>
            <body>
                <h2>✨ Alice is offline</h2>
                <p>Make sure Alice is running on port 18790</p>
                <button onclick="location.href='http://localhost:18790/'">Retry</button>
            </body>
            </html>
        `);
    });
});

// Quit when all windows are closed (macOS)
mb.app.on('window-all-closed', (e) => {
    e.preventDefault(); // Keep running in menu bar
});
