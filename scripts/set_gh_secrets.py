#!/usr/bin/env python3
"""set_gh_secrets.py — set encrypted Actions secrets on a GitHub repo (libsodium sealed box)."""
import base64, json, sys, urllib.request
from nacl import encoding, public

GH = "https://api.github.com"
TOKEN = __import__("os").environ.get("GITHUB_TOKEN", "")
OWNER, REPO = "Hisernberg", "spaceapps-2026-vault"

# All secret VALUES are read from the environment — never hardcode tokens here.
SECRETS = {
    name: __import__("os").environ.get(name, "")
    for name in ("FIRMS_MAP_KEY", "NASA_API_KEY", "HF_TOKEN")
}
SECRETS = {k: v for k, v in SECRETS.items() if v}

def req(url, method="GET", payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(r, timeout=30) as resp:
        body = resp.read().decode()
        return resp.status, (json.loads(body) if body.strip() else {})

status, pk = req(f"{GH}/repos/{OWNER}/{REPO}/actions/secrets/public-key")
pk_obj = public.PublicKey(pk["key"].encode(), encoding.Base64Encoder())
sealed = public.SealedBox(pk_obj)

for name, value in SECRETS.items():
    enc = sealed.encrypt(value.encode())
    st, _ = req(f"{GH}/repos/{OWNER}/{REPO}/actions/secrets/{name}", "PUT", {
        "encrypted_value": base64.b64encode(enc).decode(),
        "key_id": pk["key_id"],
    })
    print(f"{name}: HTTP {st} (201/204 = set)")
print("done — secrets are encrypted at rest, visible only to Actions runs.")
