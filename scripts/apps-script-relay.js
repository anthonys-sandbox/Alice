/**
 * Alice Google Chat Relay — Google Apps Script + Google Sheets Queue
 *
 * Uses a Google Sheet as the message queue so the local agent can
 * poll via the Sheets API with OAuth (no public web endpoint needed).
 *
 * SETUP:
 * 1. Create a new Google Sheet — name it "GravityClaw Relay"
 * 2. Rename Sheet1 to "messages"
 * 3. Add headers in row 1: id | timestamp | sender | text | status | response
 * 4. Copy the Sheet ID from the URL (the long string between /d/ and /edit)
 * 5. Go to https://script.google.com → New project → name it "Alice Relay"
 * 6. Paste this entire file into Code.gs
 * 7. Replace SPREADSHEET_ID below with your Sheet ID
 * 8. In GCP → Google Chat API → Configuration:
 *    - Connection: Apps Script
 *    - Select your "Alice Relay" deployment
 * 9. Add the Sheet ID to your .env:
 *       RELAY_SHEET_ID=your-sheet-id
 *
 * HOW IT WORKS:
 * 1. User sends message in Google Chat
 * 2. onMessage() writes it to the Sheet with status "pending"
 * 3. onMessage() polls the Sheet waiting for "response" column to be filled
 * 4. Local agent reads the Sheet via Sheets API, finds pending messages
 * 5. Agent processes the message and writes the response to the Sheet
 * 6. onMessage() picks up the response and returns it to Google Chat
 */

// ⬇️ REPLACE THIS with your Google Sheet ID
var SPREADSHEET_ID = 'YOUR_SHEET_ID_HERE';
var SHEET_NAME = 'messages';

// ============================================================
// Chat App Event Handlers
// ============================================================

function onMessage(event) {
    console.log('onMessage called, event keys: ' + Object.keys(event).join(', '));

    // Google Workspace Add-on event format:
    // Message is at event.chat.messagePayload.message (NOT event.message)
    var chatPayload = event.chat || {};
    var messagePayload = chatPayload.messagePayload || {};
    var message = messagePayload.message || event.message; // fallback for standalone Chat apps
    var space = messagePayload.space || event.space;
    var user = (message && message.sender) || event.user || {};

    console.log('chat payload keys: ' + Object.keys(chatPayload).join(', '));
    console.log('message exists: ' + !!message);

    if (!message) {
        console.log('No message found in event');
        return chatResponse('✨ Received event but no message content.');
    }

    var msgText = message.text || '';
    // For @mentions in spaces, argumentText has the text without the @mention
    var argumentText = message.argumentText || '';
    var text = (argumentText || msgText).trim();

    console.log('Raw text: ' + msgText);
    console.log('Extracted text: ' + text);

    if (!text) {
        return chatResponse('✨ I received your message but it was empty.');
    }

    var msgId = Utilities.getUuid();
    var senderName = user.displayName || user.name || 'Unknown';

    try {
        var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
        if (!sheet) {
            console.log('ERROR: Sheet tab "' + SHEET_NAME + '" not found!');
            return chatResponse('❌ Config error: Sheet tab "' + SHEET_NAME + '" not found.');
        }

        sheet.appendRow([
            msgId,
            new Date().toISOString(),
            senderName,
            text,
            'pending',
            ''
        ]);
        console.log('Wrote message to sheet, id: ' + msgId);
    } catch (e) {
        console.log('ERROR writing to sheet: ' + e.message);
        return chatResponse('❌ Sheet error: ' + e.message);
    }

    // Wait for the local agent to fill in the response
    // Apps Script has a ~6 minute execution limit, but Chat expects fast responses.
    // We wait up to 55 seconds (just under the typical Chat API timeout).
    var response = waitForResponse(sheet, msgId, 55000);

    if (response) {
        console.log('Got response from agent: ' + response.substring(0, 100));
        return chatResponse(response);
    } else {
        console.log('Timed out waiting for agent response');
        return chatResponse('⏳ Alice is still thinking... (the response will appear shortly)');
    }
}

function onAddedToSpace(event) {
    return chatResponse('✨ Alice is online! Send me a message.');
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

function onRemovedFromSpace(event) {
    // nothing to clean up
}

// ============================================================
// Wait for agent response
// ============================================================

function waitForResponse(sheet, msgId, timeoutMs) {
    var start = Date.now();
    var pollInterval = 1000; // Check every 1 second

    while (Date.now() - start < timeoutMs) {
        Utilities.sleep(pollInterval);

        // Re-open the sheet on each poll to bypass SpreadsheetApp read cache
        // (the local agent writes via the Sheets REST API, which is a different API)
        SpreadsheetApp.flush();
        var freshSheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
        var data = freshSheet.getDataRange().getValues();

        for (var i = 1; i < data.length; i++) {
            if (data[i][0] === msgId && data[i][4] === 'done' && data[i][5]) {
                console.log('Found response after ' + (Date.now() - start) + 'ms');
                return data[i][5]; // response column
            }
        }
    }

    return null; // Timed out
}
