const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID, createHash, pbkdf2Sync, timingSafeEqual } = require('node:crypto');

const STORE_FILE = path.join(__dirname, 'data', 'customer-accounts.json');
const PASSWORD_ITERATIONS = 100000;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;
let queue = Promise.resolve();
let initPromise;

function blankStore() { return { users: [], sessions: [], attempts: {} }; }
function token(bytes = 32) { return randomBytes(bytes).toString('base64url'); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function emailValue(value) { return typeof value === 'string' ? value.trim().slice(0, 200).toLowerCase() : ''; }
function clean(value, max = 120) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function validPassword(value) { return typeof value === 'string' && value.length >= 12 && value.length <= 128; }
function passwordHash(password) {
  const salt = randomBytes(16).toString('base64url');
  const derived = pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, 'sha256').toString('base64url');
  return `pbkdf2$${PASSWORD_ITERATIONS}$${salt}$${derived}`;
}
function passwordMatches(password, encoded) {
  const [kind, rounds, salt, expected] = String(encoded || '').split('$');
  if (kind !== 'pbkdf2' || Number(rounds) !== PASSWORD_ITERATIONS || !salt || !expected) return false;
  const actual = Buffer.from(pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, 'sha256').toString('base64url'));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...headers });
  res.end(JSON.stringify(data));
}
function cookieToken(req) {
  const entry = String(req.headers.cookie || '').split(';').map((item) => item.trim()).find((item) => item.startsWith('apria_customer='));
  try { return entry ? decodeURIComponent(entry.slice('apria_customer='.length)) : ''; } catch { return ''; }
}
function cookieHeader(req, value, age) {
  const secure = Boolean(req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https');
  return `apria_customer=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
}
function originMatches(req) {
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === String(req.headers.host || ''); } catch { return false; }
}
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 20000) { reject(new Error('Request is too large.')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Please submit valid JSON.')); } });
    req.on('error', reject);
  });
}
async function ensureStore() {
  if (!initPromise) initPromise = (async () => {
    await fs.promises.mkdir(path.dirname(STORE_FILE), { recursive: true });
    try {
      const parsed = JSON.parse(await fs.promises.readFile(STORE_FILE, 'utf8'));
      return { ...blankStore(), ...parsed };
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Customer account data could not be read.');
      const store = blankStore(); await save(store); return store;
    }
  })();
  await initPromise;
}
async function read() { await ensureStore(); await queue; return JSON.parse(await fs.promises.readFile(STORE_FILE, 'utf8')); }
async function update(callback) {
  await ensureStore(); let result;
  const operation = queue.then(async () => {
    const store = JSON.parse(await fs.promises.readFile(STORE_FILE, 'utf8'));
    result = await callback(store);
    await save(store);
  });
  queue = operation.catch(() => {}); await operation; return result;
}
async function save(store) {
  await fs.promises.mkdir(path.dirname(STORE_FILE), { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(store), { encoding: 'utf8', mode: 0o600 });
  await fs.promises.rename(temporary, STORE_FILE);
}
function safeUser(user) { return { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt }; }
async function session(req) {
  const raw = cookieToken(req); if (!raw) return null;
  const store = await read(), record = store.sessions.find((entry) => entry.tokenHash === hash(raw) && Date.parse(entry.expiresAt) > Date.now());
  if (!record) return null;
  const user = store.users.find((entry) => entry.id === record.userId);
  return user ? { user, record } : null;
}
function setSession(req, res, user, store) {
  const raw = token(), createdAt = new Date().toISOString(), expiresAt = new Date(Date.now() + SESSION_MS).toISOString();
  store.sessions = store.sessions.filter((entry) => Date.parse(entry.expiresAt) > Date.now());
  store.sessions.push({ tokenHash: hash(raw), userId: user.id, createdAt, expiresAt });
  res.setHeader('Set-Cookie', cookieHeader(req, raw, SESSION_MS / 1000));
  return { authenticated: true, user: safeUser(user), expiresAt };
}
function attemptKey(email, req, kind = 'login') { return hash(`${kind}|${email}|${req.socket.remoteAddress || 'unknown'}`); }
function blocked(store, key) {
  const row = store.attempts[key];
  return Boolean(row && Date.now() - row.startedAt < ATTEMPT_WINDOW_MS && row.failures >= MAX_FAILURES);
}
function recordFailure(store, key) {
  const now = Date.now(), previous = store.attempts[key];
  store.attempts[key] = !previous || now - previous.startedAt >= ATTEMPT_WINDOW_MS
    ? { failures: 1, startedAt: now }
    : { failures: previous.failures + 1, startedAt: previous.startedAt };
}
function validEmail(email) { return email.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

async function handleCustomerRequest(req, res, url) {
  if (!url.pathname.startsWith('/api/customer/')) return false;
  if (!originMatches(req)) { json(res, 403, { error: 'This request could not be verified.' }); return true; }
  const route = url.pathname.slice('/api/customer'.length).replace(/\/$/, '') || '/';
  try {
    if (route === '/session' && req.method === 'GET') {
      const auth = await session(req);
      json(res, 200, auth ? { authenticated: true, user: safeUser(auth.user), expiresAt: auth.record.expiresAt } : { authenticated: false });
      return true;
    }
    if (route === '/logout' && req.method === 'POST') {
      const auth = await session(req);
      if (auth) await update((store) => { store.sessions = store.sessions.filter((entry) => entry.tokenHash !== auth.record.tokenHash); });
      json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, '', 0) });
      return true;
    }
    if (!['/login', '/register'].includes(route) || req.method !== 'POST') { json(res, 405, { error: 'Method not allowed.' }); return true; }
    const input = await parseBody(req), email = emailValue(input.email), password = typeof input.password === 'string' ? input.password : '';
    if (!validEmail(email)) { json(res, 400, { error: 'Enter a valid email address.' }); return true; }
    if (route === '/register') {
      const name = clean(input.name);
      if (name.length < 2) { json(res, 400, { error: 'Enter your name (at least 2 characters).' }); return true; }
      if (!validPassword(password)) { json(res, 400, { error: 'Choose a password between 12 and 128 characters.' }); return true; }
      const key = attemptKey(email, req, 'register'), store = await read();
      if (blocked(store, key)) { json(res, 429, { error: 'Too many attempts. Please wait 15 minutes and try again.' }); return true; }
      let response;
      await update((current) => {
        if (current.users.some((user) => user.email === email)) { recordFailure(current, key); response = { status: 409, body: { error: 'An APRIA account already uses this email. Sign in instead.' } }; return; }
        const user = { id: randomUUID(), name, email, passwordHash: passwordHash(password), createdAt: new Date().toISOString() };
        current.users.push(user); delete current.attempts[key];
        response = { status: 201, body: setSession(req, res, user, current) };
      });
      json(res, response.status, response.body); return true;
    }
    const key = attemptKey(email, req), store = await read();
    if (blocked(store, key)) { json(res, 429, { error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' }); return true; }
    const user = store.users.find((entry) => entry.email === email);
    if (!user || !passwordMatches(password, user.passwordHash)) {
      await update((current) => recordFailure(current, key));
      json(res, 401, { error: 'Email or password is incorrect.' }); return true;
    }
    let result;
    await update((current) => { delete current.attempts[key]; result = setSession(req, res, user, current); });
    json(res, 200, result); return true;
  } catch (error) {
    json(res, error.message === 'Please submit valid JSON.' ? 400 : 500, { error: error.message === 'Please submit valid JSON.' ? error.message : 'Unable to complete your account request right now.' });
    return true;
  }
}

module.exports = { handleCustomerRequest };
