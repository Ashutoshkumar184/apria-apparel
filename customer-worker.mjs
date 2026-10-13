const PASSWORD_HASH_ITERATIONS = 100000;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 8;

function clean(value, max = 120) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function emailValue(value) { return clean(value, 200).toLowerCase(); }
function validEmail(value) { return value.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function validPassword(value) { return typeof value === 'string' && value.length >= 12 && value.length <= 128; }
function b64url(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function randomToken(length = 32) { const bytes = new Uint8Array(length); crypto.getRandomValues(bytes); return b64url(bytes); }
async function sha256(value) { return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))); }
function timingSafeEqual(a, b) { if (a.length !== b.length) return false; let difference = 0; for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index); return difference === 0; }
async function passwordHash(password) {
  const salt = randomToken(16), key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: PASSWORD_HASH_ITERATIONS, hash: 'SHA-256' }, key, 256);
  return `pbkdf2$${PASSWORD_HASH_ITERATIONS}$${salt}$${b64url(bits)}`;
}
async function passwordMatches(password, encoded) {
  const [kind, rounds, salt, expected] = String(encoded || '').split('$');
  if (kind !== 'pbkdf2' || Number(rounds) !== PASSWORD_HASH_ITERATIONS || !salt || !expected) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: PASSWORD_HASH_ITERATIONS, hash: 'SHA-256' }, key, 256);
  return timingSafeEqual(b64url(bits), expected);
}
function json(status, body, headers = {}) { return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...headers } }); }
function cookieToken(request) {
  const entry = String(request.headers.get('Cookie') || '').split(';').map((item) => item.trim()).find((item) => item.startsWith('apria_customer='));
  try { return entry ? decodeURIComponent(entry.slice('apria_customer='.length)) : ''; } catch { return ''; }
}
function setCookie(token, maxAge) { return `apria_customer=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`; }
function originMatches(request) {
  const origin = request.headers.get('Origin'); if (!origin) return true;
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}
async function jsonBody(request) {
  const raw = await request.text(); if (raw.length > 20000) throw new Error('Request is too large.');
  try { return JSON.parse(raw || '{}'); } catch { throw new Error('Please submit valid JSON.'); }
}
function safeCustomer(row) { return { id: row.id, name: row.name, email: row.email, createdAt: row.created_at }; }
async function customerSession(request, env) {
  const raw = cookieToken(request); if (!raw) return null;
  const session = await env.DB.prepare('SELECT * FROM customer_sessions WHERE token_hash = ? AND expires_at > ?').bind(await sha256(raw), new Date().toISOString()).first();
  if (!session) return null;
  const user = await env.DB.prepare('SELECT * FROM customer_users WHERE id = ?').bind(session.user_id).first();
  return user ? { user, session } : null;
}
async function sessionResponse(env, request, user) {
  const token = randomToken(), createdAt = new Date().toISOString(), expiresAt = new Date(Date.now() + SESSION_MS).toISOString();
  await env.DB.prepare('DELETE FROM customer_sessions WHERE expires_at <= ?').bind(createdAt).run();
  await env.DB.prepare('INSERT INTO customer_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256(token), user.id, createdAt, expiresAt).run();
  return json(200, { authenticated: true, user: safeCustomer(user), expiresAt }, { 'Set-Cookie': setCookie(token, SESSION_MS / 1000) });
}
async function rateLimit(env, request, email, action) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown', attemptKey = await sha256(`${action}|${email}|${ip}`), now = new Date();
  const row = await env.DB.prepare('SELECT failures, window_started_at FROM customer_login_attempts WHERE attempt_key = ?').bind(attemptKey).first();
  const fresh = !row || now.getTime() - Date.parse(row.window_started_at) >= ATTEMPT_WINDOW_MS;
  return { key: attemptKey, row, fresh, blocked: !fresh && Number(row.failures) >= MAX_LOGIN_FAILURES, startedAt: fresh ? now.toISOString() : row.window_started_at };
}
async function recordFailure(env, attempt) {
  const failures = attempt.fresh ? 1 : Number(attempt.row.failures) + 1;
  await env.DB.prepare('INSERT INTO customer_login_attempts (attempt_key, failures, window_started_at) VALUES (?, ?, ?) ON CONFLICT(attempt_key) DO UPDATE SET failures = excluded.failures, window_started_at = excluded.window_started_at').bind(attempt.key, failures, attempt.startedAt).run();
}

export async function handleCustomerRequest(request, env, url) {
  if (!url.pathname.startsWith('/api/customer/')) return null;
  if (!originMatches(request)) return json(403, { error: 'This request could not be verified.' });
  const route = url.pathname.slice('/api/customer'.length).replace(/\/$/, '') || '/';
  try {
    if (route === '/session' && request.method === 'GET') {
      const auth = await customerSession(request, env);
      return json(200, auth ? { authenticated: true, user: safeCustomer(auth.user), expiresAt: auth.session.expires_at } : { authenticated: false });
    }
    if (route === '/logout' && request.method === 'POST') {
      const auth = await customerSession(request, env);
      if (auth) await env.DB.prepare('DELETE FROM customer_sessions WHERE token_hash = ?').bind(auth.session.token_hash).run();
      return json(200, { ok: true }, { 'Set-Cookie': setCookie('', 0) });
    }
    if (!['/login', '/register'].includes(route) || request.method !== 'POST') return json(405, { error: 'Method not allowed.' });
    const input = await jsonBody(request), email = emailValue(input.email), password = typeof input.password === 'string' ? input.password : '';
    if (!validEmail(email)) return json(400, { error: 'Enter a valid email address.' });
    if (route === '/register') {
      const name = clean(input.name, 120);
      if (name.length < 2) return json(400, { error: 'Enter your name (at least 2 characters).' });
      if (!validPassword(password)) return json(400, { error: 'Choose a password between 12 and 128 characters.' });
      const attempt = await rateLimit(env, request, email, 'register');
      if (attempt.blocked) return json(429, { error: 'Too many attempts. Please wait 15 minutes and try again.' });
      const existing = await env.DB.prepare('SELECT id FROM customer_users WHERE email = ? COLLATE NOCASE').bind(email).first();
      if (existing) { await recordFailure(env, attempt); return json(409, { error: 'An APRIA account already uses this email. Sign in instead.' }); }
      const id = crypto.randomUUID(), createdAt = new Date().toISOString(), passwordHashValue = await passwordHash(password);
      await env.DB.prepare('INSERT INTO customer_users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, email, name, passwordHashValue, createdAt).run();
      await env.DB.prepare('DELETE FROM customer_login_attempts WHERE attempt_key = ?').bind(attempt.key).run();
      return sessionResponse(env, request, { id, email, name, created_at: createdAt });
    }
    const attempt = await rateLimit(env, request, email, 'login');
    if (attempt.blocked) return json(429, { error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' });
    const user = await env.DB.prepare('SELECT * FROM customer_users WHERE email = ? COLLATE NOCASE').bind(email).first();
    if (!user || !(await passwordMatches(password, user.password_hash))) {
      await recordFailure(env, attempt);
      return json(401, { error: 'Email or password is incorrect.' });
    }
    await env.DB.prepare('DELETE FROM customer_login_attempts WHERE attempt_key = ?').bind(attempt.key).run();
    return sessionResponse(env, request, user);
  } catch (error) {
    return json(error.message === 'Please submit valid JSON.' ? 400 : 500, { error: error.message === 'Please submit valid JSON.' ? error.message : 'Unable to complete your account request right now.' });
  }
}
