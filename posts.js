const { randomBytes } = require('node:crypto');
const { mkdirSync, writeFileSync, unlinkSync } = require('node:fs');
const path = require('node:path');

const CATEGORIES = ['Entulho', 'Madeira e móveis', 'Metal e ferro-velho', 'Papelão e papel', 'Plástico', 'Eletrônicos', 'Outro'];
const MAX_PHOTO_BYTES = 1500000;
const MAX_POSTS_PER_USER = 50;
const PHOTO_PATTERN = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;
const FILE_PATTERN = /^[a-f0-9]{32}\.jpg$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function oneLine(value, min, max) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
  return clean.length >= min && clean.length <= max ? clean : null;
}

function multiLine(value, max) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') return null;
  const clean = value.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').replace(/\n{3,}/g, '\n\n').trim();
  return clean.length <= max ? clean : null;
}

function parsePriceCents(value) {
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,6})(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] || '0').padEnd(2, '0'));
  return cents <= 10000000 ? cents : null;
}

function parsePhone(value) {
  if (typeof value !== 'string') return null;
  let digits = value.replace(/\D/g, '');
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) digits = digits.slice(2);
  if (digits.length < 10 || digits.length > 11 || digits[0] === '0') return null;
  return digits;
}

function parsePhoto(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_PHOTO_BYTES * 4 / 3) + 64) return null;
  const match = PHOTO_PATTERN.exec(value);
  if (!match) return null;
  const buffer = Buffer.from(match[1], 'base64');
  if (buffer.length < 200 || buffer.length > MAX_PHOTO_BYTES) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) return null;
  return buffer;
}

function createPostsTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL,
    price_cents INTEGER NOT NULL DEFAULT 0,
    bairro TEXT NOT NULL,
    address TEXT NOT NULL,
    contact TEXT NOT NULL,
    photo TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'aberto',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
}

function registerPosts(app, { db, uploadsDir, postLimiter }) {
  const root = path.resolve(uploadsDir);
  const removeFile = name => { try { unlinkSync(path.join(root, name)); } catch (error) {} };
  const fail = (res, status, error) => res.status(status).json({ error });
  const apiAuth = (req, res, next) =>
    req.session.userId ? next() : fail(res, 401, 'Sessão expirada. Entre novamente.');

  app.get('/api/posts', apiAuth, (req, res) => {
    const rows = db.prepare(`SELECT p.id, p.user_id, p.title, p.description, p.category, p.price_cents,
        p.bairro, p.address, p.contact, p.photo, p.status, p.created_at, u.name AS author
      FROM posts p JOIN users u ON u.id = p.user_id ORDER BY p.id DESC LIMIT 100`).all();
    res.json({
      posts: rows.map(row => ({
        id: row.id, title: row.title, description: row.description, category: row.category,
        priceCents: row.price_cents, bairro: row.bairro, address: row.address, contact: row.contact,
        photoUrl: `/uploads/${row.photo}`, status: row.status, createdAt: row.created_at,
        author: row.author, mine: row.user_id === req.session.userId
      }))
    });
  });

  app.post('/api/posts', apiAuth, postLimiter, (req, res) => {
    const body = req.body || {};
    const title = oneLine(body.title, 3, 80);
    const category = CATEGORIES.includes(body.category) ? body.category : null;
    const description = multiLine(body.description, 500);
    const priceCents = parsePriceCents(body.price);
    const bairro = oneLine(body.bairro, 2, 60);
    const address = oneLine(body.address, 5, 120);
    const contact = parsePhone(body.contact);
    const photo = parsePhoto(body.photo);
    if (!title) return fail(res, 400, 'Informe um título de 3 a 80 caracteres.');
    if (!category) return fail(res, 400, 'Escolha uma categoria.');
    if (description === null) return fail(res, 400, 'A descrição pode ter no máximo 500 caracteres.');
    if (priceCents === null) return fail(res, 400, 'Informe um valor válido (use 0 se não houver valor).');
    if (!bairro) return fail(res, 400, 'Informe o bairro.');
    if (!address) return fail(res, 400, 'Informe a rua e o número.');
    if (!contact) return fail(res, 400, 'Informe um telefone ou WhatsApp com DDD.');
    if (!photo) return fail(res, 400, 'Envie uma foto válida (JPG, até 1,5 MB).');

    const { total } = db.prepare('SELECT COUNT(*) AS total FROM posts WHERE user_id = ?').get(req.session.userId);
    if (total >= MAX_POSTS_PER_USER) {
      return fail(res, 400, `Você atingiu o limite de ${MAX_POSTS_PER_USER} postagens. Apague alguma para publicar outra.`);
    }

    const file = `${randomBytes(16).toString('hex')}.jpg`;
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, file), photo, { flag: 'wx' });
    try {
      const result = db.prepare(`INSERT INTO posts (user_id, title, description, category, price_cents, bairro, address, contact, photo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.session.userId, title, description, category, priceCents, bairro, address, contact, file);
      res.status(201).json({ id: Number(result.lastInsertRowid) });
    } catch (error) {
      removeFile(file);
      throw error;
    }
  });

  function ownPost(req, res) {
    if (!/^\d{1,9}$/.test(req.params.id)) { fail(res, 404, 'Postagem não encontrada.'); return null; }
    const post = db.prepare('SELECT id, user_id, photo FROM posts WHERE id = ?').get(Number(req.params.id));
    if (!post) { fail(res, 404, 'Postagem não encontrada.'); return null; }
    if (post.user_id !== req.session.userId) { fail(res, 403, 'Você só pode alterar as suas postagens.'); return null; }
    return post;
  }

  app.post('/api/posts/:id/status', apiAuth, (req, res) => {
    const post = ownPost(req, res);
    if (!post) return;
    const status = req.body && req.body.status;
    if (status !== 'aberto' && status !== 'coletado') return fail(res, 400, 'Situação inválida.');
    db.prepare('UPDATE posts SET status = ? WHERE id = ?').run(status, post.id);
    res.json({ ok: true });
  });

  app.post('/api/posts/:id/delete', apiAuth, (req, res) => {
    const post = ownPost(req, res);
    if (!post) return;
    db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
    removeFile(post.photo);
    res.json({ ok: true });
  });

  app.get('/uploads/:file', apiAuth, (req, res) => {
    if (!FILE_PATTERN.test(req.params.file)) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(req.params.file, { root, dotfiles: 'deny' }, error => {
      if (error && !res.headersSent) res.status(404).end();
    });
  });
}

module.exports = {
  registerPosts, createPostsTable, CATEGORIES,
  oneLine, multiLine, parsePriceCents, parsePhone, parsePhoto
};
