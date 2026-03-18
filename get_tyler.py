import os
import json
import base64
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

def main():
    if not os.path.exists('token.json'):
        print("No token.json found")
        return
        
    creds = Credentials.from_authorized_user_file('token.json', ['https://mail.google.com/'])
    service = build('gmail', 'v1', credentials=creds)
    
    results = service.users().messages().list(userId='me', q='tyler_barnes@hillspet.com', maxResults=15).execute()
    messages = results.get('messages', [])
    
    for msg in messages:
        try:
            m = service.users().messages().get(userId='me', id=msg['id'], format='full').execute()
            
            headers = m['payload']['headers']
            subject = next((h['value'] for h in headers if h['name'] == 'Subject'), 'No Subject')
            date = next((h['value'] for h in headers if h['name'] == 'Date'), 'No Date')
            from_hdr = next((h['value'] for h in headers if h['name'] == 'From'), 'No From')
            
            print(f"---")
            print(f"Date: {date}")
            print(f"From: {from_hdr}")
            print(f"Subject: {subject}")
            
            if 'parts' in m['payload']:
                parts = m['payload']['parts']
                for part in parts:
                    if part['mimeType'] == 'text/plain':
                        data = part['body'].get('data')
                        if data:
                            text = base64.urlsafe_b64decode(data).decode('utf-8')
                            print(text[:300]) # first 300 chars
            else:
                data = m['payload']['body'].get('data')
                if data:
                    text = base64.urlsafe_b64decode(data).decode('utf-8')
                    print(text[:300])
        except Exception as e:
            pass

if __name__ == '__main__':
    main()
