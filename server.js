const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const derive = promisify(scrypt);
const DAY = 86400000;

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const key = await derive(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = await derive(password, salt, 64);
  return timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

class SQLiteStore extends session.Store {
  constructor(db) { super(); this.db = db; }
  get(id, callback) {
    try {
      const row = this.db.prepare('SELECT value FROM sessions WHERE id = ? AND expires > ?').get(id, Date.now());
      callback(null, row ? JSON.parse(row.value) : null);
    } catch (error) { callback(error); }
  }
  set(id, value, callback = () => {}) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
      this.db.prepare('INSERT OR REPLACE INTO sessions (id, value, expires) VALUES (?, ?, ?)')
        .run(id, JSON.stringify(value), value.cookie.expires ? new Date(value.cookie.expires).getTime() : Date.now() + DAY);
      callback(null);
    } catch (error) { callback(error); }
  }
  destroy(id, callback = () => {}) {
    try { this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id); callback(null); }
    catch (error) { callback(error); }
  }
  touch(id, value, callback) { this.set(id, value, callback); }
}

function createApp({ databasePath, secret = process.env.SESSION_SECRET } = {}) {
  const production = process.env.NODE_ENV === 'production';
  if (production && (!secret || secret.length < 32)) throw new Error('Defina SESSION_SECRET com pelo menos 32 caracteres.');
  if (!databasePath) {
    mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    databasePath = path.join(__dirname, 'data', 'login.sqlite');
  }
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL);`);
  const app = express();
  if (production) app.set('trust proxy', 1);
  app.locals.db = db;
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use((req, res, next) => {
    res.locals.nonce = randomBytes(16).toString('base64');
    next();
  });
  app.use(helmet({
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    contentSecurityPolicy: {
      directives: {
        scriptSrc: ["'self'", 'https://unpkg.com', (req, res) => `'nonce-${res.locals.nonce}'`],
        imgSrc: ["'self'", 'data:', 'https://unpkg.com', 'https://tile.openstreetmap.org', 'https://*.tile.openstreetmap.org']
      }
    }
  }));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));
  app.use(session({
    name: 'login.sid', secret: secret || randomBytes(32).toString('hex'),
    store: new SQLiteStore(db), resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, secure: production, sameSite: 'lax', maxAge: DAY }
  }));
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    req.session.csrf ||= randomBytes(32).toString('hex');
    res.locals.csrf = req.session.csrf;
    if (req.method === 'POST' && req.body.csrf !== req.session.csrf) {
      return res.status(403).send('Formulário expirado ou inválido. Recarregue a página.');
    }
    next();
  });
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20,
    standardHeaders: 'draft-8', legacyHeaders: false,
    message: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' });
  const page = (res, mode, error = null, values = {}, status = 200) =>
    res.status(status).render('auth', { mode, error, values });
  const authenticated = (req, res, next) => req.session.userId ? next() : res.redirect('/login');
  const guest = (req, res, next) => req.session.userId ? res.redirect('/painel') : next();
  app.get('/', (req, res) => res.redirect(req.session.userId ? '/painel' : '/login'));
  app.get('/login', guest, (req, res) => page(res, 'login'));
  app.get('/cadastro', guest, (req, res) => page(res, 'cadastro'));
  const emailOf = body => typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const validEmail = email => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  async function signIn(req, res, id) {
    await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.userId = id;
    await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    res.redirect('/painel');
  }
  app.post('/cadastro', guest, limiter, async (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const email = emailOf(req.body);
    const password = req.body.password;
    const values = { name, email };
    if (name.length < 2 || name.length > 80 || !validEmail(email) ||
        typeof password !== 'string' || password.length < 6 || password.length > 128) {
      return page(res, 'cadastro', 'Informe um nome de 2 a 80 caracteres, e-mail válido e senha de 6 a 128 caracteres.', values, 400);
    }
    const hash = await hashPassword(password);
    let result;
    try {
      result = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)').run(name, email, hash);
    } catch (error) {
      if (error.code === 'ERR_SQLITE_ERROR' && error.message.includes('UNIQUE constraint failed')) {
        return page(res, 'cadastro', 'Não foi possível cadastrar este e-mail. Tente entrar ou use outro e-mail.', values, 409);
      }
      throw error;
    }
    await signIn(req, res, Number(result.lastInsertRowid));
  });
  const dummyHash = hashPassword(randomBytes(32).toString('hex'));
  app.post('/login', guest, limiter, async (req, res) => {
    const email = emailOf(req.body);
    const password = req.body.password;
    if (!validEmail(email) || typeof password !== 'string' || password.length > 128) {
      return page(res, 'login', 'E-mail ou senha inválidos.', { email }, 401);
    }
    const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
    const valid = await verifyPassword(password, user ? user.password_hash : await dummyHash);
    if (!user || !valid) return page(res, 'login', 'E-mail ou senha inválidos.', { email }, 401);
    await signIn(req, res, user.id);
  });
  app.get('/painel', authenticated, (req, res) => {
    const user = db.prepare('SELECT id, name, email, created_at FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return req.session.destroy(() => res.redirect('/login'));
    res.render('dashboard', { user });
  });
  app.post('/logout', authenticated, (req, res, next) => {
    req.session.destroy(error => {
      if (error) return next(error);
      res.clearCookie('login.sid', { httpOnly: true, secure: production, sameSite: 'lax' });
      res.redirect('/login');
    });
  });
  app.use((req, res) => res.status(404).send('Página não encontrada.'));
  app.use((error, req, res, next) => {
    console.error(error);
    res.status(500).send('Não foi possível concluir a operação. Tente novamente.');
  });
  return app;
}

if (require.main === module) {
  const app = createApp();
  const port = process.env.PORT || 3080;
  app.listen(port, () => console.log(`Projeto Login: http://localhost:${port}`));
}
module.exports = { createApp };
