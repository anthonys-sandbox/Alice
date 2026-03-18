import json
import base64
import sys

def parse_email(file_path):
    try:
        with open(file_path, 'r') as f:
            data = json.load(f)
        
        headers = data.get('payload', {}).get('headers', [])
        subject = next((h['value'] for h in headers if h['name'] == 'Subject'), 'No Subject')
        sender = next((h['value'] for h in headers if h['name'] == 'From'), 'Unknown Sender')
        date = next((h['value'] for h in headers if h['name'] == 'Date'), 'Unknown Date')
        
        print(f"From: {sender}")
        print(f"Subject: {subject}")
        print(f"Date: {date}")
        print("-" * 20)
        
        print("Snippet:", data.get('snippet', 'No snippet found.'))
        
        def decode_part(part):
            if part.get('mimeType') == 'text/plain':
                body_data = part.get('body', {}).get('data', '')
                if body_data:
                    body_data += "=" * ((4 - len(body_data) % 4) % 4)
                    print(base64.urlsafe_b64decode(body_data).decode('utf-8'))
                    return True
            if 'parts' in part:
                for subpart in part['parts']:
                    if decode_part(subpart):
                        return True
            return False

        payload = data.get('payload', {})
        if not decode_part(payload):
            if payload.get('body', {}).get('data'):
                body_data = payload.get('body').get('data')
                body_data += "=" * ((4 - len(body_data) % 4) % 4)
                print(base64.urlsafe_b64decode(body_data).decode('utf-8'))
                
    except Exception as e:
        print(f"Error: {e}")

if __name__ == '__main__':
    parse_email(sys.argv[1])
