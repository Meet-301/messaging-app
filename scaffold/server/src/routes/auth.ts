import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import { getRedis } from '../redis.js';
import {
  createSession,
  deleteSession,
  parseCookies,
  SESSION_COOKIE_NAME,
  type WorkspaceMembership,
} from '../services/session.js';

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
}

interface JwkKey extends crypto.JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

let cachedDiscovery: OidcDiscovery | null = null;
let cachedJwks: JwkKey[] = [];

async function getOidcDiscovery(): Promise<OidcDiscovery> {
  if (cachedDiscovery) return cachedDiscovery;
  const res = await fetch(`${config.oidc.issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`OIDC discovery failed with ${res.status}`);
  }
  cachedDiscovery = (await res.json()) as OidcDiscovery;
  return cachedDiscovery;
}

async function getJwks(jwksUri: string, forceRefresh = false): Promise<JwkKey[]> {
  if (!forceRefresh && cachedJwks.length > 0) return cachedJwks;
  const res = await fetch(jwksUri, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    throw new Error(`JWKS fetch failed with ${res.status}`);
  }
  const data = (await res.json()) as { keys?: JwkKey[] };
  cachedJwks = Array.isArray(data.keys) ? data.keys : [];
  return cachedJwks;
}

async function verifyIdToken(
  idToken: string,
  discovery: OidcDiscovery
): Promise<Record<string, unknown>> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Malformed id_token');
  const [headB64, bodyB64, sigB64] = parts;

  const header = JSON.parse(Buffer.from(headB64, 'base64url').toString('utf8')) as {
    alg?: string;
    kid?: string;
  };
  const claims = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;

  let keys = await getJwks(discovery.jwks_uri);
  let jwk = header.kid ? keys.find((k) => k.kid === header.kid) : keys[0];
  if (!jwk) {
    keys = await getJwks(discovery.jwks_uri, true);
    jwk = header.kid ? keys.find((k) => k.kid === header.kid) : keys[0];
  }
  if (!jwk) throw new Error('Signing key not found in JWKS');

  const pubKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const verified = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${headB64}.${bodyB64}`),
    pubKey,
    Buffer.from(sigB64, 'base64url')
  );
  if (!verified) throw new Error('Invalid id_token signature');

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === 'number' && claims.exp < now - 30) {
    throw new Error('id_token expired');
  }
  if (claims.aud !== config.oidc.clientId) {
    throw new Error('id_token audience mismatch');
  }
  if (claims.iss !== discovery.issuer) {
    throw new Error('id_token issuer mismatch');
  }

  return claims;
}

export function createAuthRouter(): Router {
  const router = Router();

  router.get('/login', async (req: Request, res: Response) => {
    try {
      const discovery = await getOidcDiscovery();
      const state = crypto.randomBytes(16).toString('hex');
      const codeVerifier = crypto.randomBytes(32).toString('base64url');
      const codeChallenge = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');

      const host = req.get('host');
      const redirectUri =
        host === 'localhost:5173'
          ? 'http://localhost:5173/auth/callback'
          : config.oidc.redirectUri;

      await getRedis().set(
        `sb:oidc:state:${state}`,
        JSON.stringify({ codeVerifier, redirectUri }),
        'EX',
        300
      );

      const authUrl = new URL(discovery.authorization_endpoint);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', config.oidc.clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('scope', 'openid profile email');
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');

      return res.redirect(302, authUrl.toString());
    } catch (err) {
      console.error('[auth/login] error:', err);
      return res.status(500).json({ error: 'oidc discovery failed' });
    }
  });

  router.get('/callback', async (req: Request, res: Response) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const errParam = typeof req.query.error === 'string' ? req.query.error : '';

    if (errParam) {
      return res.status(400).json({ error: errParam });
    }
    if (!code || !state) {
      return res.status(400).json({ error: 'missing code or state' });
    }

    const stateKey = `sb:oidc:state:${state}`;
    const redis = getRedis();
    const savedRaw = await redis.getdel(stateKey);
    if (!savedRaw) {
      return res.status(400).json({ error: 'invalid or expired state' });
    }

    const { codeVerifier, redirectUri } = JSON.parse(savedRaw) as {
      codeVerifier: string;
      redirectUri: string;
    };

    try {
      const discovery = await getOidcDiscovery();
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: config.oidc.clientId,
        client_secret: config.oidc.clientSecret,
        code_verifier: codeVerifier,
      });

      const tokenRes = await fetch(discovery.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(8000),
      });

      if (!tokenRes.ok) {
        const text = await tokenRes.text();
        return res.status(401).json({ error: 'token exchange failed', detail: text });
      }

      const tokenData = (await tokenRes.json()) as {
        id_token?: string;
        access_token?: string;
      };

      let claims: Record<string, unknown>;
      if (tokenData.id_token) {
        claims = await verifyIdToken(tokenData.id_token, discovery);
      } else if (tokenData.access_token) {
        const uiRes = await fetch(discovery.userinfo_endpoint, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!uiRes.ok) return res.status(401).json({ error: 'userinfo failed' });
        claims = (await uiRes.json()) as Record<string, unknown>;
      } else {
        return res.status(401).json({ error: 'no id_token or access_token' });
      }

      const sub = typeof claims.sub === 'string' ? claims.sub : '';
      const name = typeof claims.name === 'string' ? claims.name : sub;
      const email = typeof claims.email === 'string' ? claims.email : '';
      const workspaces = Array.isArray(claims.workspaces)
        ? (claims.workspaces as WorkspaceMembership[])
        : [];

      if (!sub) {
        return res.status(401).json({ error: 'missing sub claim' });
      }

      const sid = await createSession({ sub, name, email, workspaces });
      res.cookie(SESSION_COOKIE_NAME, sid, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 86400 * 1000,
      });

      return res.redirect(302, '/');
    } catch (err) {
      console.error('[auth/callback] error:', err);
      return res.status(401).json({ error: 'authentication failed' });
    }
  });

  router.post('/logout', async (req: Request, res: Response) => {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies[SESSION_COOKIE_NAME];
    await deleteSession(sid);
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return res.status(200).json({ ok: true });
  });

  return router;
}
