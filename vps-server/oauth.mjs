import { createHash, randomBytes } from 'node:crypto';

export function generatePkce() {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

export function buildGoogleAuthUrl({ clientId, redirectUri, state, codeChallenge }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleCode({ code, codeVerifier, clientId, clientSecret, redirectUri, fetchImpl = fetch }) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });

  const tokenRes = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    throw new Error(`Falha ao trocar código OAuth com o Google (${tokenRes.status}): ${text.slice(0, 200)}`);
  }

  const tokens = await tokenRes.json();
  if (!tokens.access_token) {
    throw new Error('Resposta do Google sem access_token.');
  }

  const profileRes = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!profileRes.ok) {
    const text = await profileRes.text().catch(() => '');
    throw new Error(`Falha ao consultar perfil Google (${profileRes.status}): ${text.slice(0, 200)}`);
  }

  const profile = await profileRes.json();
  if (!profile.sub || !profile.email) {
    throw new Error('Perfil Google incompleto.');
  }
  if (profile.email_verified !== true) {
    throw new Error('O e-mail da conta Google não está verificado.');
  }

  return {
    googleSub: String(profile.sub),
    email: String(profile.email).trim().toLowerCase(),
    name: String(profile.name ?? ''),
    picture: String(profile.picture ?? ''),
  };
}
