/**
 * Alice Chat Relay — Firestore Mode (Apps Script)
 *
 * Deploy this as the Google Chat App's event handler.
 * When someone sends a message to Alice in Google Chat,
 * this script writes it to Firestore. Alice's real-time
 * listener picks it up instantly (event-driven, no polling).
 *
 * SETUP:
 * 1. Create a Firebase project (free Spark plan is fine)
 * 2. Enable Firestore in the Firebase Console
 * 3. In Apps Script, add the Firebase library:
 *    - Go to Libraries → Add → ID: 1hguuh4Zx72XVC1Zldm_vTtcUUKUA6iBUOoGnJUWLfqDWx5WlOJHqYkrt
 *    - Or use the REST API directly (as shown below)
 * 4. Set your Firebase Project ID in Script Properties:
 *    - Project Settings → Script Properties → FIREBASE_PROJECT_ID
 * 5. Set GOOGLE_SA_KEY as a script property with the service account JSON
 *    (same service account used by Alice)
 * 6. Deploy as a Google Chat App
 *
 * Firestore collection: "alice-chat-relay"
 * Document schema: { sender, text, status, spaceName, timestamp }
 */

// Get config from script properties
function getConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    projectId: props.getProperty('FIREBASE_PROJECT_ID'),
    saKey: props.getProperty('GOOGLE_SA_KEY'),
  };
}

// Get Firestore access token from service account
function getFirestoreToken() {
  const config = getConfig();
  if (!config.saKey) throw new Error('GOOGLE_SA_KEY not set in Script Properties');

  const sa = JSON.parse(config.saKey);
  const token = ScriptApp.getOAuthToken(); // Uses the script's OAuth
  return token;
}

/**
 * Main entry point — called by Google Chat when a message arrives.
 */
function onMessage(event) {
  const config = getConfig();
  if (!config.projectId) {
    return { text: '❌ Firebase not configured. Set FIREBASE_PROJECT_ID in Script Properties.' };
  }

  const sender = event.user?.displayName || event.user?.email || 'Unknown';
  const text = event.message?.text || '';
  const spaceName = event.space?.name || '';

  // Generate unique message ID
  const msgId = 'msg_' + new Date().getTime().toString(36) + '_' + Math.random().toString(36).substr(2, 4);

  // Write to Firestore via REST API
  const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/alice-chat-relay/${msgId}`;

  const payload = {
    fields: {
      sender: { stringValue: sender },
      text: { stringValue: text },
      status: { stringValue: 'pending' },
      spaceName: { stringValue: spaceName },
      timestamp: { stringValue: new Date().toISOString() },
      response: { stringValue: '' },
    },
  };

  try {
    const response = UrlFetchApp.fetch(firestoreUrl, {
      method: 'PATCH',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });

    const code = response.getResponseCode();
    if (code >= 200 && code < 300) {
      // Message written — Alice will pick it up via real-time listener
      // Return an acknowledgment (Alice will send the real response via Chat API)
      return { text: '⏳ Thinking...' };
    } else {
      Logger.log('Firestore write failed: ' + response.getContentText());
      return { text: '❌ Failed to relay message. Error: ' + code };
    }
  } catch (err) {
    Logger.log('Error: ' + err.message);
    return { text: '❌ Error: ' + err.message };
  }
}

/**
 * Called when the bot is added to a space.
 */
function onAddToSpace(event) {
  return { text: "👋 Hi! I'm Alice, your AI assistant. Send me a message and I'll respond!" };
}

/**
 * Called when the bot is removed from a space.
 */
function onRemoveFromSpace(event) {
  Logger.log('Removed from space: ' + event.space?.name);
}
