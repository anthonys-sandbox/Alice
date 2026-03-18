import json
import urllib.request

req = urllib.request.Request("http://localhost:8080/v1/emails?query=newer_than:3d")
try:
    with urllib.request.urlopen(req) as response:
        print(response.read().decode())
except Exception as e:
    pass
