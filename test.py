import subprocess
import json
import sys

ids = ["19cfda561552cb00", "19cfd61ed91a677b", "19cfd5abc6ebabf3", "19cfd4660bb159fa", "19cfd363df0a2a34", "19cfcd382c313425"]

for mid in ids:
    cmd = f"gws gmail users messages get --params '{{\"userId\": \"me\", \"id\": \"{mid}\", \"format\": \"metadata\", \"metadataHeaders\": [\"From\", \"To\", \"Subject\", \"Date\"]}}'"
    try:
        out = subprocess.check_output(cmd, shell=True).decode('utf-8')
        data = json.loads(out)
        headers = {h['name']: h['value'] for h in data['payload']['headers']}
        snippet = data.get('snippet', '')
        print(f"ID: {mid}")
        print(f"From: {headers.get('From')}")
        print(f"To: {headers.get('To')}")
        print(f"Subject: {headers.get('Subject')}")
        print(f"Date: {headers.get('Date')}")
        print(f"Snippet: {snippet}")
        print("-" * 40)
    except Exception as e:
        print(f"Failed {mid}")

