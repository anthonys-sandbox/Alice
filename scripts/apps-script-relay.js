/**
 * Alice Google Chat Relay — Event-Driven Architecture
 *
 * Uses a Google Sheet as the message queue. Apps Script receives Chat messages,
 * writes them to the Sheet, and returns "Thinking..." immediately.
 * Alice (local Node.js) picks up messages, processes them, writes responses,
 * and delivers them directly to Google Chat via the Chat API.
 *
 * SETUP:
 * 1. Create a Google Sheet — name it "GravityClaw Relay"
 * 2. Rename Sheet1 to "messages"
 * 3. Add headers in row 1: id | timestamp | sender | text | status | response | spaceName
 * 4. Copy the Sheet ID from the URL
 * 5. Go to https://script.google.com → New project → name it "Alice Relay"
 * 6. Paste this file into Code.gs
 * 7. Replace SPREADSHEET_ID below with your Sheet ID
 * 8. In GCP → Google Chat API → Configuration:
 *    - Connection: Apps Script
 *    - Select your "Alice Relay" deployment
 * 9. Add the Sheet ID to your .env:
 *       RELAY_SHEET_ID=your-sheet-id
 *
 * HOW IT WORKS:
 * 1. User sends message in Google Chat
 * 2. onMessage() writes it to the Sheet with status "pending" + spaceName
 * 3. onMessage() returns "✨ Thinking..." IMMEDIATELY
 * 4. Alice polls Sheet (every 3s), processes, writes response, sends to Chat directly
 *
 * Sheet columns: id | timestamp | sender | text | status | response | spaceName
 */

// ⬇️ REPLACE THIS with your Google Sheet ID
var SPREADSHEET_ID = 'YOUR_SHEET_ID_HERE';
var SHEET_NAME = 'messages';

// ============================================================
// Chat App Event Handlers
// ============================================================

function onMessage(event) {
    console.log('onMessage called');

    var chatPayload = event.chat || {};
    var messagePayload = chatPayload.messagePayload || {};
    var message = messagePayload.message || event.message;
    var space = messagePayload.space || event.space;
    var user = (message && message.sender) || event.user || {};

    if (!message) {
        return chatResponse('✨ Received event but no message content.');
    }

    var msgText = message.text || '';
    var argumentText = message.argumentText || '';
    var text = (argumentText || msgText).trim();

    if (!text) {
        return chatResponse('✨ I received your message but it was empty.');
    }

    var msgId = Utilities.getUuid();
    var senderName = user.displayName || user.name || 'Unknown';
    var spaceName = space ? space.name : '';

    console.log('Message from ' + senderName + ': ' + text.substring(0, 80));
    console.log('Space: ' + spaceName);

    try {
        var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
        if (!sheet) {
            return chatResponse('❌ Config error: Sheet tab "' + SHEET_NAME + '" not found.');
        }

        sheet.appendRow([
            msgId,
            new Date().toISOString(),
            senderName,
            text,
            'pending',
            '',
            spaceName
        ]);
        console.log('Wrote message to sheet, id: ' + msgId);
    } catch (e) {
        console.log('ERROR writing to sheet: ' + e.message);
        return chatResponse('❌ Sheet error: ' + e.message);
    }

    // Return immediately — Alice will deliver the response directly to Chat
    return chatResponse('✨ Thinking...');
}

function onAddedToSpace(event) {
    return chatResponse('✨ Alice is online! Send me a message.');
}

function onRemovedFromSpace(event) {
    // nothing to clean up
}

/**
 * Build a response in the Workspace Add-on format for Google Chat.
 */
function chatResponse(text) {
    return {
        hostAppDataAction: {
            chatDataAction: {
                createMessageAction: {
                    message: {
                        text: text
                    }
                }
            }
        }
    };
}
