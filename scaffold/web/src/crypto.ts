function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export function getWorkspacePassphrase(workspace: string): string {
  const key = `sb_e2ee_passphrase:${workspace}`;
  const stored = sessionStorage.getItem(key);
  if (stored && stored.length > 0) return stored;
  return `switchboard-e2ee-${workspace}`;
}

export function setWorkspacePassphrase(workspace: string, passphrase: string): void {
  const key = `sb_e2ee_passphrase:${workspace}`;
  if (passphrase.trim()) {
    sessionStorage.setItem(key, passphrase.trim());
  } else {
    sessionStorage.removeItem(key);
  }
}

export async function deriveWorkspaceKey(
  workspace: string,
  passphrase: string
): Promise<{ key: CryptoKey; keyId: string }> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const salt = enc.encode(`switchboard-notes-v1:${workspace}`);
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100_000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`${workspace}:${passphrase}`));
  const keyId = Array.from(new Uint8Array(digest).slice(0, 4))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return { key, keyId };
}

export async function encryptNote(
  key: CryptoKey,
  plaintext: string
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    ciphertext: toBase64(new Uint8Array(encrypted)),
    iv: toBase64(iv),
  };
}

export async function decryptNote(
  key: CryptoKey,
  ciphertext: string,
  iv: string
): Promise<string | null> {
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(iv) },
      key,
      fromBase64(ciphertext)
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}
