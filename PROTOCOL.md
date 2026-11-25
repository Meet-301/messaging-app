# Switchboard End-to-End Encrypted Private Notes (`PROTOCOL.md`)

Agents can leave private internal notes on a conversation for other agents in the same workspace. Notes are encrypted client-side in the browser using the Web Crypto API before being sent to the server, so the Switchboard server and database never see or store plaintext note content or encryption keys.

## 1. Key Holders & Key Derivation

- **Who holds the key:** Only authenticated agents' browsers in the workspace hold the workspace passphrase (stored in browser `sessionStorage` under `sb_e2ee_passphrase:<workspace>`) and the derived non-extractable `CryptoKey`.
- **What the server holds:** Nothing secret. The server never receives the passphrase or derived `AES-GCM-256` key.
- **Key Derivation (`scaffold/web/src/crypto.ts`):**
  1. The browser takes the workspace passphrase and derives a 256-bit `AES-GCM` key using `PBKDF2` (`SHA-256`, `100,000` iterations, salt `switchboard-notes-v1:<workspace>`).
  2. A short 8-hex-character `key_id` (`SHA-256("<workspace>:<passphrase>")` prefix) is computed locally to help the UI identify which key encrypted a note.
- **Encryption & Decryption:**
  - **Encrypt:** On note submission, the browser generates a fresh 12-byte random `iv` via `crypto.getRandomValues(new Uint8Array(12))` and encrypts the UTF-8 plaintext with `AES-GCM` (256-bit key, 128-bit authentication tag).
  - **Decrypt:** When loading conversation notes or receiving a `note.created` WebSocket frame, the browser decrypts `ciphertext` with `iv` and the local workspace `CryptoKey`. If the passphrase does not match, `AES-GCM` authentication fails and the UI displays an unreadable/wrong-key indicator.

## 2. What the Server Stores

In MongoDB (`notes` collection, defined in `scaffold/server/src/models.ts`) and in WebSocket `note.created` frames, the server stores **only**:

```json
{
  "workspace": "ws_acme",
  "contact": "+14155550101",
  "author_sub": "u_ben",
  "author_name": "Ben Ortiz",
  "ciphertext": "<base64-encoded AES-GCM ciphertext + auth tag>",
  "iv": "<base64-encoded 12-byte random nonce>",
  "alg": "AES-GCM-256",
  "key_id": "a1b2c3d4",
  "created_at": "2026-11-25T19:00:00.000Z"
}
```

- The `POST /api/conversations/:contact/notes` endpoint rejects requests without `ciphertext`, `iv`, and `alg === 'AES-GCM-256'` and never accepts or logs a `text` plaintext field.
- Private notes are never forwarded to Pigeon.

## 3. Three Attacks This Scheme Does NOT Stop

1. **Compromised Server Serving Malicious Client JavaScript:** Because the web app's JavaScript bundle is served over HTTP/HTTPS by the Switchboard server, a compromised server (or attacker who modifies the served JS) could inject code to exfiltrate the passphrase or decrypted note text directly from the agent's browser.
2. **Malicious or Compromised Workspace Member:** Any agent who legitimately holds the workspace passphrase (or whose session/browser is compromised via XSS or device theft) can decrypt all notes for that workspace and copy/exfiltrate the plaintext out-of-band. Key rotation requires re-encrypting or migrating to a new `key_id`.
3. **Metadata & Traffic Analysis:** The server and database still observe who wrote a note (`author_sub`, `author_name`), which workspace and customer `contact` it belongs to, when it was created (`created_at`), and the approximate length of the note from `ciphertext.length`.
