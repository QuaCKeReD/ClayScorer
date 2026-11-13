/* ClayScorer self-hosted server.
 *
 * One dependency-free Node process that:
 *   - serves the static app (APP_DIR),
 *   - stores signed-in users' round history in SQLite (DATA_DIR/clayscorer.db),
 *   - manages users (username + scrypt password hash, role 'admin' | 'user').
 *
 * Anonymous visitors still get the full offline app; server storage is only used once
 * someone signs in. See SELF_HOSTING.md for deployment.
 */
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCb);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8080);
const APP_DIR = path.resolve(process.env.APP_DIR || path.join(HERE, '..'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(HERE, '..', 'data'));
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
// Behind a reverse proxy (Caddy) every request comes from the proxy, so use X-Forwarded-For.
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const COOKIE = 'cs_session';
const MAX_BODY = 2 * 1024 * 1024;
const DISCIPLINES = new Set(['sporting', 'sportrap', 'compak', 'skeet']);
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/i;
const MIN_PASSWORD = 8;

// ---------- Database ----------

await mkdir(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'clayscorer.db'));
db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
    );
    -- One row per round; deleted rounds keep a tombstone so other devices learn about the delete.
    CREATE TABLE IF NOT EXISTS rounds (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        discipline TEXT NOT NULL,
        round_key TEXT NOT NULL,
        state TEXT,
        updated_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, discipline, round_key)
    );
`);

const q = {
    userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
    adminCount: db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`),
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    listUsers: db.prepare('SELECT id, username, display_name, role, created_at, updated_at FROM users ORDER BY username'),
    insertUser: db.prepare('INSERT INTO users (username, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    sessionUser: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteUserSessionsExcept: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    listRounds: db.prepare('SELECT round_key, state, updated_at, deleted FROM rounds WHERE user_id = ? AND discipline = ?'),
    getRound: db.prepare('SELECT updated_at FROM rounds WHERE user_id = ? AND discipline = ? AND round_key = ?'),
    // Upserts only win when they are newer than what the server already holds.
    upsertRound: db.prepare(`
        INSERT INTO rounds (user_id, discipline, round_key, state, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, discipline, round_key) DO UPDATE SET
            state = excluded.state, updated_at = excluded.updated_at, deleted = excluded.deleted
        WHERE excluded.updated_at > rounds.updated_at
    `)
};

// ---------- Passwords & sessions ----------

async function hashPassword(password) {
    const salt = randomBytes(16);
    const key = await scrypt(password, salt, 64);
    return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
    const [scheme, saltB64, keyB64] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
    const expected = Buffer.from(keyB64, 'base64');
    const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
    return timingSafeEqual(expected, actual);
}

const clientIp = (req) => (TRUST_PROXY && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function createSession(res, req, userId) {
    const token = randomBytes(32).toString('base64url');
    const maxAge = SESSION_DAYS * 86400;
    q.insertSession.run(sha256(token), userId, Date.now() + maxAge * 1000);
    setCookie(res, req, token, maxAge);
    return token;
}

function setCookie(res, req, value, maxAge) {
    const secure = COOKIE_SECURE || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

function sessionToken(req) {
    const match = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`));
    return match ? match.slice(COOKIE.length + 1) : null;
}

function currentUser(req) {
    const token = sessionToken(req);
    if (!token) return null;
    return q.sessionUser.get(sha256(token), Date.now()) || null;
}

const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role, createdAt: u.created_at, updatedAt: u.updated_at });

// Simple in-memory brake on password guessing: 10 failures per IP+username per 15 minutes.
const failures = new Map();
const FAIL_WINDOW = 15 * 60 * 1000;
function tooManyFailures(key) {
    const entry = failures.get(key);
    if (!entry || Date.now() - entry.first > FAIL_WINDOW) return false;
    return entry.count >= 10;
}
function recordFailure(key) {
    const entry = failures.get(key);
    if (!entry || Date.now() - entry.first > FAIL_WINDOW) failures.set(key, { first: Date.now(), count: 1 });
    else entry.count++;
}

// ---------- HTTP helpers ----------

class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

function sendJson(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
}

async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) throw new HttpError(413, 'Request too large');
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new HttpError(400, 'Invalid JSON'); }
}

function requireUser(req) {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'Sign in required');
    return user;
}

function requireAdmin(req) {
    const user = requireUser(req);
    if (user.role !== 'admin') throw new HttpError(403, 'Admins only');
    return user;
}

function validateUsername(username) {
    if (!USERNAME_RE.test(username || '')) throw new HttpError(400, 'Username must be 3–32 letters, numbers, dots, dashes or underscores');
}
function validatePassword(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters`);
}
function validateRole(role) {
    if (role !== 'admin' && role !== 'user') throw new HttpError(400, 'Role must be admin or user');
}
function validateDiscipline(d) {
    if (!DISCIPLINES.has(d)) throw new HttpError(404, 'Unknown discipline');
}

// ---------- API routes ----------

async function handleApi(req, res, url) {
    const { pathname } = url;
    const method = req.method;

    // Mutations must carry this header: browsers won't send it cross-site without a CORS
    // preflight (which we never grant), so it doubles as CSRF protection.
    if (method !== 'GET' && req.headers['x-clayscorer'] !== '1') throw new HttpError(403, 'Missing request header');

    if (pathname === '/api/health' && method === 'GET') return sendJson(res, 200, { ok: true });

    if (pathname === '/api/login' && method === 'POST') {
        const { username, password } = await readJson(req);
        const failKey = `${clientIp(req)}|${String(username).toLowerCase()}`;
        if (tooManyFailures(failKey)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
        const user = typeof username === 'string' ? q.userByName.get(username) : null;
        const ok = user && typeof password === 'string' && await verifyPassword(password, user.password_hash);
        if (!ok) {
            recordFailure(failKey);
            throw new HttpError(401, 'Wrong username or password');
        }
        failures.delete(failKey);
        createSession(res, req, user.id);
        return sendJson(res, 200, { user: publicUser(user) });
    }

    if (pathname === '/api/logout' && method === 'POST') {
        const token = sessionToken(req);
        if (token) q.deleteSession.run(sha256(token));
        setCookie(res, req, '', 0);
        return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/me' && method === 'GET') {
        const user = currentUser(req);
        return sendJson(res, 200, { user: user ? publicUser(user) : null, setupNeeded: q.userCount.get().n === 0 });
    }

    if (pathname === '/api/me/password' && method === 'POST') {
        const user = requireUser(req);
        const { currentPassword, newPassword } = await readJson(req);
        if (typeof currentPassword !== 'string' || !await verifyPassword(currentPassword, user.password_hash)) {
            throw new HttpError(400, 'Current password is wrong');
        }
        validatePassword(newPassword);
        db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(await hashPassword(newPassword), Date.now(), user.id);
        // Sign out every other device that knew the old password.
        q.deleteUserSessionsExcept.run(user.id, sha256(sessionToken(req)));
        return sendJson(res, 200, { ok: true });
    }

    // --- Rounds: /api/rounds/:discipline[/:roundKey] ---
    const roundsMatch = pathname.match(/^\/api\/rounds\/([a-z]+)(?:\/(.+))?$/);
    if (roundsMatch) {
        const user = requireUser(req);
        const discipline = roundsMatch[1];
        validateDiscipline(discipline);
        let roundKey = null;
        if (roundsMatch[2] !== undefined) {
            try { roundKey = decodeURIComponent(roundsMatch[2]); } catch { throw new HttpError(400, 'Bad round key'); }
        }

        if (!roundKey && method === 'GET') {
            const rounds = q.listRounds.all(user.id, discipline).map(r => ({
                roundKey: r.round_key,
                updatedAt: r.updated_at,
                deleted: !!r.deleted,
                state: r.deleted ? null : JSON.parse(r.state)
            }));
            return sendJson(res, 200, { rounds });
        }
        if (roundKey && method === 'PUT') {
            const { state, updatedAt } = await readJson(req);
            if (!state || typeof state !== 'object' || !Number.isFinite(updatedAt)) throw new HttpError(400, 'state and updatedAt are required');
            const result = q.upsertRound.run(user.id, discipline, roundKey, JSON.stringify(state), Math.trunc(updatedAt), 0);
            return sendJson(res, 200, { applied: result.changes > 0, serverUpdatedAt: q.getRound.get(user.id, discipline, roundKey)?.updated_at ?? null });
        }
        if (roundKey && method === 'DELETE') {
            const deletedAt = Number(url.searchParams.get('deletedAt')) || Date.now();
            const result = q.upsertRound.run(user.id, discipline, roundKey, null, Math.trunc(deletedAt), 1);
            return sendJson(res, 200, { applied: result.changes > 0 });
        }
        throw new HttpError(405, 'Method not allowed');
    }

    // --- Users (admin) ---
    if (pathname === '/api/users' && method === 'GET') {
        requireAdmin(req);
        return sendJson(res, 200, { users: q.listUsers.all().map(publicUser) });
    }
    if (pathname === '/api/users' && method === 'POST') {
        requireAdmin(req);
        const { username, displayName = '', password, role = 'user' } = await readJson(req);
        validateUsername(username);
        validatePassword(password);
        validateRole(role);
        if (q.userByName.get(username)) throw new HttpError(409, 'That username is already taken');
        const now = Date.now();
        const result = q.insertUser.run(username, String(displayName).slice(0, 60), await hashPassword(password), role, now, now);
        return sendJson(res, 201, { user: publicUser(q.userById.get(result.lastInsertRowid)) });
    }
    const userMatch = pathname.match(/^\/api\/users\/(\d+)$/);
    if (userMatch) {
        const admin = requireAdmin(req);
        const target = q.userById.get(Number(userMatch[1]));
        if (!target) throw new HttpError(404, 'User not found');
        const lastAdmin = target.role === 'admin' && q.adminCount.get().n <= 1;

        if (method === 'PATCH') {
            const body = await readJson(req);
            const sets = [];
            const values = [];
            if (body.username !== undefined && body.username !== target.username) {
                validateUsername(body.username);
                const clash = q.userByName.get(body.username);
                if (clash && clash.id !== target.id) throw new HttpError(409, 'That username is already taken');
                sets.push('username = ?'); values.push(body.username);
            }
            if (body.displayName !== undefined) { sets.push('display_name = ?'); values.push(String(body.displayName).slice(0, 60)); }
            if (body.role !== undefined && body.role !== target.role) {
                validateRole(body.role);
                if (lastAdmin) throw new HttpError(400, 'There must be at least one admin');
                sets.push('role = ?'); values.push(body.role);
            }
            if (body.password) {
                validatePassword(body.password);
                sets.push('password_hash = ?'); values.push(await hashPassword(body.password));
            }
            if (sets.length) {
                sets.push('updated_at = ?'); values.push(Date.now());
                db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values, target.id);
                // A reset password signs that user out everywhere (except the admin's own session).
                if (body.password) {
                    if (target.id === admin.id) q.deleteUserSessionsExcept.run(target.id, sha256(sessionToken(req)));
                    else q.deleteUserSessions.run(target.id);
                }
            }
            return sendJson(res, 200, { user: publicUser(q.userById.get(target.id)) });
        }
        if (method === 'DELETE') {
            if (target.id === admin.id) throw new HttpError(400, "You can't delete your own account");
            if (lastAdmin) throw new HttpError(400, 'There must be at least one admin');
            q.deleteUser.run(target.id);
            return sendJson(res, 200, { ok: true });
        }
        throw new HttpError(405, 'Method not allowed');
    }

    throw new HttpError(404, 'Not found');
}

// ---------- Static files ----------

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json'
};
// Never serve server code, data, archives or docs, even when APP_DIR is the repo root.
const BLOCKED_TOP = new Set(['server', 'data', '_archive', 'node_modules']);

async function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'Bad request'); }
    if (rel.endsWith('/')) rel += 'index.html';
    const parts = rel.split('/').filter(Boolean);
    if (parts.some(p => p.startsWith('.')) || BLOCKED_TOP.has(parts[0])) throw new HttpError(404, 'Not found');
    const type = TYPES[path.extname(rel).toLowerCase()];
    if (!type) throw new HttpError(404, 'Not found');
    const file = path.join(APP_DIR, ...parts);
    if (!file.startsWith(APP_DIR + path.sep)) throw new HttpError(404, 'Not found');
    let info;
    try { info = await stat(file); } catch { throw new HttpError(404, 'Not found'); }
    if (!info.isFile()) throw new HttpError(404, 'Not found');
    // The service worker does the offline caching; the browser should always revalidate.
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    res.end(await readFile(file));
}

// ---------- Server ----------

const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    try {
        // Collapse leading slashes so "//x" isn't parsed as a protocol-relative URL.
        let url;
        try { url = new URL(req.url.replace(/^\/+/, '/'), 'http://localhost'); }
        catch { throw new HttpError(400, 'Bad request'); }
        if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
        else await serveStatic(req, res, url);
    } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        if (status === 500) console.error(err);
        if (res.headersSent) return res.end();
        if (req.url.startsWith('/api/')) sendJson(res, status, { error: status === 500 ? 'Server error' : err.message });
        else { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(status === 404 ? 'Not found' : 'Error'); }
    }
});

async function bootstrapAdmin() {
    if (q.userCount.get().n > 0) return;
    const { ADMIN_USERNAME: username, ADMIN_PASSWORD: password } = process.env;
    if (!username || !password) {
        console.warn('[clayscorer] No users yet. Set ADMIN_USERNAME and ADMIN_PASSWORD and restart to create the first admin.');
        return;
    }
    validateUsername(username);
    validatePassword(password);
    const now = Date.now();
    q.insertUser.run(username, '', await hashPassword(password), 'admin', now, now);
    console.log(`[clayscorer] Created admin user "${username}".`);
}

await bootstrapAdmin();
q.purgeSessions.run(Date.now());
setInterval(() => q.purgeSessions.run(Date.now()), 6 * 3600 * 1000).unref();

server.listen(PORT, () => console.log(`[clayscorer] Serving ${APP_DIR} on :${PORT}, data in ${DATA_DIR}`));

const shutdown = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
