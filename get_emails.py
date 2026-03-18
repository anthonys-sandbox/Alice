import json
import base64
import sys

def get_body(payload):
    if 'data' in payload['body']:
        return base64.urlsafe_b64decode(payload['body']['data']).decode('utf-8')
    elif 'parts' in payload:
        for part in payload['parts']:
            if part['mimeType'] == 'text/plain':
                return get_body(part)
    return ""

for filename in sys.argv[1:]:
    with open(filename) as f:
        data = json.load(f)
        headers = {h['name']: h['value'] for h in data['payload']['headers']}
        print(f"--- EMAIL {data['id']} ---")
        print("Date:", headers.get('Date'))
        print("Subject:", headers.get('Subject'))
        print("From:", headers.get('From'))
        print("To:", headers.get('To'))
        print("Body:", get_body(data['payload'])[:500])
