const { randomInt, createHash, timingSafeEqual } = require('node:crypto');
const { MATERIALS, POINTS, REWARDS } = require('./catalog');

const MAX_QTY = 10;
const MAX_FINAL_QTY = 50;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const INVITE_LENGTH = 10;
const CODE_HOURS = 24;
const INVITE_DAYS = 7;
const MAX_PENDING = 3;
const MAX_OPEN_INVITES = 30;
const DAILY_VALIDATION_LIMIT = 5;
const REJECT_REASONS = ['Material diferente do declarado', 'Material não aceito neste ponto', 'Quantidade não confere', 'Outro motivo'];

const sqlTime = date => date.toISOString().slice(0, 19).replace('T', ' ');
const addMs = (date, ms) => new Date(date.getTime() + ms);
const makeCode = length => Array.from({ length }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
const normalizeCode = value => (typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '');
const digest = value => createHash('sha256').update(String(value)).digest();
const safeEqual = (a, b) => timingSafeEqual(digest(a), digest(b));
const shortName = name => {
  const parts = String(name).trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
};
const csvCell = value => {
  let text = String(value === null || value === undefined ? '' : value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
};

function addColumn(db, table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function createActivityTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS disposals (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    material_id TEXT NOT NULL, material TEXT NOT NULL,
    point_id TEXT NOT NULL, point TEXT NOT NULL,
    qty INTEGER NOT NULL, points INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS disposals_user ON disposals(user_id, id);
  CREATE TABLE IF NOT EXISTS redemptions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    reward_id TEXT NOT NULL, reward TEXT NOT NULL, cost INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS redemptions_user ON redemptions(user_id, id);
  CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    point_id TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL,
    used_by INTEGER, used_at TEXT
  );`);
  addColumn(db, 'disposals', 'status', "TEXT NOT NULL DEFAULT 'validado'");
  addColumn(db, 'disposals', 'code', 'TEXT');
  addColumn(db, 'disposals', 'expires_at', 'TEXT');
  addColumn(db, 'disposals', 'final_material_id', 'TEXT');
  addColumn(db, 'disposals', 'final_material', 'TEXT');
  addColumn(db, 'disposals', 'final_qty', 'INTEGER');
  addColumn(db, 'disposals', 'validated_by', 'INTEGER');
  addColumn(db, 'disposals', 'validated_at', 'TEXT');
  addColumn(db, 'disposals', 'reject_reason', 'TEXT');
  addColumn(db, 'users', 'role', "TEXT NOT NULL DEFAULT 'morador'");
  addColumn(db, 'users', 'point_id', 'TEXT');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS disposals_code ON disposals(code) WHERE code IS NOT NULL;
    CREATE INDEX IF NOT EXISTS disposals_point_status ON disposals(point_id, status);`);
}

function totals(db, userId) {
  const earned = db.prepare(`SELECT COALESCE(SUM(points), 0) AS points, COUNT(*) AS count
    FROM disposals WHERE user_id = ? AND status = 'validado'`).get(userId);
  const spent = db.prepare('SELECT COALESCE(SUM(cost), 0) AS cost FROM redemptions WHERE user_id = ?').get(userId);
  return { earned: earned.points, count: earned.count, balance: earned.points - spent.cost };
}

function registerActivity(app, { db, disposalLimiter, staffLimiter, claimLimiter, adminCode, now = () => new Date() }) {
  const secret = typeof adminCode === 'string' && adminCode.length >= 12 ? adminCode : null;
  const fail = (res, status, error) => res.status(status).json({ error });
  const apiAuth = (req, res, next) =>
    req.session.userId ? next() : fail(res, 401, 'Sessão expirada. Entre novamente.');
  const loadUser = userId => db.prepare('SELECT id, name, email, role, point_id FROM users WHERE id = ?').get(userId);
  const pointName = id => (POINTS.find(item => item.id === id) || {}).name || null;
  const effectiveStatus = (row, nowSql) =>
    row.status === 'pendente' && row.expires_at <= nowSql ? 'expirado' : row.status;

  function staffOnly(req, res, next) {
    const user = loadUser(req.session.userId);
    if (!user) return fail(res, 401, 'Sessão expirada. Entre novamente.');
    if (user.role !== 'funcionario' && user.role !== 'admin') return fail(res, 403, 'Acesso restrito à equipe.');
    req.staff = user;
    next();
  }
  function adminOnly(req, res, next) {
    const user = loadUser(req.session.userId);
    if (!user) return fail(res, 401, 'Sessão expirada. Entre novamente.');
    if (user.role !== 'admin') return fail(res, 403, 'Acesso restrito ao administrador.');
    req.staff = user;
    next();
  }

  app.get('/api/me', apiAuth, (req, res) => {
    const user = loadUser(req.session.userId);
    if (!user) return fail(res, 401, 'Sessão expirada. Entre novamente.');
    const sums = totals(db, user.id);
    const rank = sums.count === 0 ? null : 1 + db.prepare(`SELECT COUNT(*) AS higher FROM
      (SELECT SUM(points) AS total FROM disposals WHERE status = 'validado' GROUP BY user_id) WHERE total > ?`).get(sums.earned).higher;
    const participants = db.prepare("SELECT COUNT(DISTINCT user_id) AS total FROM disposals WHERE status = 'validado'").get().total;
    const nowSql = sqlTime(now());
    const disposals = db.prepare(`SELECT id, material_id, material, qty, point, points, status, code, expires_at,
        final_material, final_qty, validated_at, reject_reason, created_at
      FROM disposals WHERE user_id = ? ORDER BY id DESC LIMIT 500`).all(user.id).map(row => {
      const status = effectiveStatus(row, nowSql);
      return {
        id: row.id, materialId: row.material_id, material: row.material, qty: row.qty, point: row.point, points: row.points,
        status, code: status === 'pendente' ? row.code : null, expiresAt: row.expires_at,
        finalMaterial: row.final_material, finalQty: row.final_qty, validatedAt: row.validated_at,
        rejectReason: row.reject_reason, createdAt: row.created_at
      };
    });
    const redemptions = db.prepare(`SELECT id, reward, cost, created_at FROM redemptions
      WHERE user_id = ? ORDER BY id DESC LIMIT 100`).all(user.id)
      .map(row => ({ id: row.id, reward: row.reward, cost: row.cost, createdAt: row.created_at }));
    res.json({
      name: user.name, role: user.role, pointId: user.point_id, pointName: pointName(user.point_id),
      balance: sums.balance, earned: sums.earned, count: sums.count, rank, participants, disposals, redemptions
    });
  });

  app.post('/api/disposals', apiAuth, disposalLimiter, (req, res) => {
    const body = req.body || {};
    const material = MATERIALS.find(item => item.id === body.material);
    const point = POINTS.find(item => item.id === body.point);
    const qty = typeof body.qty === 'number' || (typeof body.qty === 'string' && /^\d{1,2}$/.test(body.qty)) ? Number(body.qty) : NaN;
    if (!material) return fail(res, 400, 'Escolha o tipo de material.');
    if (!point) return fail(res, 400, 'Escolha o ponto de descarte.');
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return fail(res, 400, `A quantidade deve ser de 1 a ${MAX_QTY}.`);
    const moment = now();
    const { total } = db.prepare("SELECT COUNT(*) AS total FROM disposals WHERE user_id = ? AND status = 'pendente' AND expires_at > ?")
      .get(req.session.userId, sqlTime(moment));
    if (total >= MAX_PENDING) {
      return fail(res, 400, `Você já tem ${MAX_PENDING} códigos aguardando validação. Use ou cancele algum antes de gerar outro.`);
    }
    const expiresAt = sqlTime(addMs(moment, CODE_HOURS * 3600000));
    let code = null, inserted = null;
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      code = makeCode(CODE_LENGTH);
      try {
        inserted = db.prepare(`INSERT INTO disposals (user_id, material_id, material, point_id, point, qty, points, status, code, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, 'pendente', ?, ?, ?)`)
          .run(req.session.userId, material.id, material.name, point.id, point.name, qty, code, expiresAt, sqlTime(moment));
      } catch (error) {
        if (!/UNIQUE/.test(String(error.message))) throw error;
      }
    }
    if (!inserted) throw new Error('Não foi possível gerar um código único.');
    res.status(201).json({ id: Number(inserted.lastInsertRowid), code, expiresAt, estimatedPoints: material.pts * qty });
  });

  app.post('/api/disposals/:id/cancel', apiAuth, (req, res) => {
    if (!/^\d{1,9}$/.test(req.params.id)) return fail(res, 404, 'Descarte não encontrado.');
    const result = db.prepare("UPDATE disposals SET status = 'cancelado' WHERE id = ? AND user_id = ? AND status = 'pendente'")
      .run(Number(req.params.id), req.session.userId);
    if (!result.changes) return fail(res, 404, 'Descarte não encontrado ou já finalizado.');
    res.json({ ok: true });
  });

  app.post('/api/redemptions', apiAuth, (req, res) => {
    const reward = REWARDS.find(item => item.id === (req.body && req.body.reward));
    if (!reward) return fail(res, 400, 'Recompensa não encontrada.');
    const { balance } = totals(db, req.session.userId);
    if (balance < reward.cost) return fail(res, 400, `Pontos insuficientes: faltam ${reward.cost - balance}.`);
    db.prepare('INSERT INTO redemptions (user_id, reward_id, reward, cost) VALUES (?, ?, ?, ?)')
      .run(req.session.userId, reward.id, reward.name, reward.cost);
    res.status(201).json({ balance: balance - reward.cost });
  });

  app.post('/api/team/claim', apiAuth, claimLimiter, (req, res) => {
    const user = loadUser(req.session.userId);
    if (!user) return fail(res, 401, 'Sessão expirada. Entre novamente.');
    if (user.role !== 'morador') return fail(res, 400, 'Você já tem acesso da equipe.');
    const raw = req.body && typeof req.body.code === 'string' ? req.body.code.trim() : '';
    if (!raw) return fail(res, 400, 'Digite o código de acesso.');
    if (secret && safeEqual(raw, secret)) {
      db.prepare("UPDATE users SET role = 'admin', point_id = NULL WHERE id = ?").run(user.id);
      return res.json({ role: 'admin' });
    }
    const invite = db.prepare('SELECT code, point_id FROM invites WHERE code = ? AND used_by IS NULL AND expires_at > ?')
      .get(normalizeCode(raw), sqlTime(now()));
    if (!invite) return fail(res, 400, 'Código inválido ou expirado.');
    const used = db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL')
      .run(user.id, sqlTime(now()), invite.code);
    if (!used.changes) return fail(res, 400, 'Código inválido ou expirado.');
    db.prepare("UPDATE users SET role = 'funcionario', point_id = ? WHERE id = ?").run(invite.point_id, user.id);
    res.json({ role: 'funcionario', pointId: invite.point_id });
  });

  function findActionable(req, res, rawCode) {
    const code = normalizeCode(rawCode);
    if (code.length !== CODE_LENGTH) { fail(res, 400, `Digite o código de ${CODE_LENGTH} caracteres.`); return null; }
    const row = db.prepare(`SELECT d.id, d.user_id, d.material_id, d.material, d.qty, d.point_id, d.point, d.status, d.expires_at,
        d.created_at, d.validated_at, u.name AS resident
      FROM disposals d JOIN users u ON u.id = d.user_id WHERE d.code = ?`).get(code);
    if (!row) { fail(res, 404, 'Código não encontrado.'); return null; }
    const status = effectiveStatus(row, sqlTime(now()));
    if (status === 'validado') { fail(res, 400, 'Este código já foi validado.'); return null; }
    if (status === 'recusado') { fail(res, 400, 'Este código já foi recusado.'); return null; }
    if (status === 'cancelado') { fail(res, 400, 'Este código foi cancelado pelo morador.'); return null; }
    if (status === 'expirado') { fail(res, 400, 'Este código expirou. Peça ao morador para gerar outro.'); return null; }
    if (req.staff.role === 'funcionario' && row.point_id !== req.staff.point_id) {
      fail(res, 403, `Este código é para outro ponto: ${row.point}.`); return null;
    }
    if (row.user_id === req.staff.id) { fail(res, 400, 'Você não pode validar o seu próprio descarte.'); return null; }
    return { code, row };
  }

  app.post('/api/staff/lookup', apiAuth, staffLimiter, staffOnly, (req, res) => {
    const found = findActionable(req, res, req.body && req.body.code);
    if (!found) return;
    const { code, row } = found;
    res.json({
      code, resident: shortName(row.resident), materialId: row.material_id, material: row.material, qty: row.qty,
      point: row.point, createdAt: row.created_at, expiresAt: row.expires_at
    });
  });

  app.post('/api/staff/validate', apiAuth, staffLimiter, staffOnly, (req, res) => {
    const body = req.body || {};
    if (body.action !== 'validar' && body.action !== 'recusar') return fail(res, 400, 'Ação inválida.');
    const found = findActionable(req, res, body.code);
    if (!found) return;
    const { row } = found;
    const moment = now();
    const stamp = sqlTime(moment);
    if (body.action === 'recusar') {
      const reason = REJECT_REASONS.includes(body.reason) ? body.reason : 'Outro motivo';
      const result = db.prepare("UPDATE disposals SET status = 'recusado', reject_reason = ?, validated_by = ?, validated_at = ? WHERE id = ? AND status = 'pendente'")
        .run(reason, req.staff.id, stamp, row.id);
      if (!result.changes) return fail(res, 400, 'Este código já foi processado.');
      return res.json({ ok: true, status: 'recusado' });
    }
    const material = MATERIALS.find(item => item.id === (body.material || row.material_id));
    const qty = typeof body.qty === 'number' || (typeof body.qty === 'string' && /^\d{1,2}$/.test(body.qty)) ? Number(body.qty) : NaN;
    if (!material) return fail(res, 400, 'Escolha o material confirmado.');
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_FINAL_QTY) return fail(res, 400, `A quantidade deve ser de 1 a ${MAX_FINAL_QTY}.`);
    const since = sqlTime(addMs(moment, -86400000));
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM disposals
      WHERE user_id = ? AND status = 'validado' AND COALESCE(validated_at, created_at) > ?`).get(row.user_id, since);
    if (total >= DAILY_VALIDATION_LIMIT) {
      return fail(res, 400, `Este morador já atingiu o limite de ${DAILY_VALIDATION_LIMIT} validações nas últimas 24 horas.`);
    }
    const points = material.pts * qty;
    const result = db.prepare(`UPDATE disposals SET status = 'validado', final_material_id = ?, final_material = ?, final_qty = ?,
        points = ?, validated_by = ?, validated_at = ? WHERE id = ? AND status = 'pendente'`)
      .run(material.id, material.name, qty, points, req.staff.id, stamp, row.id);
    if (!result.changes) return fail(res, 400, 'Este código já foi processado.');
    res.json({ ok: true, status: 'validado', points });
  });

  app.get('/api/staff/recent', apiAuth, staffOnly, (req, res) => {
    const base = `SELECT d.id, d.status, d.point, d.material, d.qty, d.final_material, d.final_qty, d.points, d.reject_reason,
        d.validated_at, u.name AS resident, v.name AS validator
      FROM disposals d JOIN users u ON u.id = d.user_id LEFT JOIN users v ON v.id = d.validated_by
      WHERE d.status IN ('validado', 'recusado') AND d.validated_at IS NOT NULL`;
    const rows = req.staff.role === 'admin'
      ? db.prepare(`${base} ORDER BY d.validated_at DESC, d.id DESC LIMIT 30`).all()
      : db.prepare(`${base} AND d.point_id = ? ORDER BY d.validated_at DESC, d.id DESC LIMIT 30`).all(req.staff.point_id);
    res.json({
      items: rows.map(row => ({
        id: row.id, status: row.status, point: row.point, resident: shortName(row.resident), validator: row.validator,
        material: row.final_material || row.material, qty: row.final_qty || row.qty, points: row.points,
        rejectReason: row.reject_reason, validatedAt: row.validated_at
      }))
    });
  });

  app.get('/api/admin/overview', apiAuth, adminOnly, (req, res) => {
    const moment = now();
    const stats = db.prepare(`SELECT point_id,
        COALESCE(SUM(CASE WHEN status = 'validado' THEN 1 ELSE 0 END), 0) AS validated,
        COALESCE(SUM(CASE WHEN status = 'validado' THEN COALESCE(final_qty, qty) ELSE 0 END), 0) AS items,
        COALESCE(SUM(CASE WHEN status = 'validado' THEN points ELSE 0 END), 0) AS points,
        COALESCE(SUM(CASE WHEN status = 'recusado' THEN 1 ELSE 0 END), 0) AS refused
      FROM disposals WHERE created_at >= ? GROUP BY point_id`).all(sqlTime(addMs(moment, -30 * 86400000)));
    const staff = db.prepare("SELECT id, name, email, point_id FROM users WHERE role = 'funcionario' ORDER BY name").all();
    const invites = db.prepare(`SELECT code, point_id, expires_at FROM invites
      WHERE used_by IS NULL AND expires_at > ? ORDER BY created_at DESC, rowid DESC`).all(sqlTime(moment));
    res.json({
      points: POINTS.map(point => {
        const row = stats.find(item => item.point_id === point.id) || {};
        return { id: point.id, name: point.name, validated: row.validated || 0, items: row.items || 0, points: row.points || 0, refused: row.refused || 0 };
      }),
      staff: staff.map(item => ({ id: item.id, name: item.name, email: item.email, pointId: item.point_id, pointName: pointName(item.point_id) })),
      invites: invites.map(item => ({ code: item.code, pointId: item.point_id, pointName: pointName(item.point_id), expiresAt: item.expires_at }))
    });
  });

  app.post('/api/admin/invites', apiAuth, adminOnly, (req, res) => {
    const point = POINTS.find(item => item.id === (req.body && req.body.point));
    if (!point) return fail(res, 400, 'Escolha o ponto do funcionário.');
    const moment = now();
    const { total } = db.prepare('SELECT COUNT(*) AS total FROM invites WHERE used_by IS NULL AND expires_at > ?').get(sqlTime(moment));
    if (total >= MAX_OPEN_INVITES) return fail(res, 400, 'Há convites demais em aberto. Aguarde alguns expirarem.');
    const expiresAt = sqlTime(addMs(moment, INVITE_DAYS * 86400000));
    let code = null, created = false;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      code = makeCode(INVITE_LENGTH);
      try {
        db.prepare('INSERT INTO invites (code, point_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(code, point.id, req.staff.id, sqlTime(moment), expiresAt);
        created = true;
      } catch (error) {
        if (!/UNIQUE|PRIMARY/.test(String(error.message))) throw error;
      }
    }
    if (!created) throw new Error('Não foi possível gerar um convite único.');
    res.status(201).json({ code, pointId: point.id, pointName: point.name, expiresAt });
  });

  app.post('/api/admin/staff/:id/revoke', apiAuth, adminOnly, (req, res) => {
    if (!/^\d{1,9}$/.test(req.params.id)) return fail(res, 404, 'Funcionário não encontrado.');
    const result = db.prepare("UPDATE users SET role = 'morador', point_id = NULL WHERE id = ? AND role = 'funcionario'")
      .run(Number(req.params.id));
    if (!result.changes) return fail(res, 404, 'Funcionário não encontrado.');
    res.json({ ok: true });
  });

  app.get('/api/admin/export.csv', apiAuth, adminOnly, (req, res) => {
    const rows = db.prepare(`SELECT d.id, COALESCE(d.validated_at, d.created_at) AS moment, d.point, u.name AS resident,
        COALESCE(d.final_material, d.material) AS material, COALESCE(d.final_qty, d.qty) AS qty, d.points, v.name AS staff
      FROM disposals d JOIN users u ON u.id = d.user_id LEFT JOIN users v ON v.id = d.validated_by
      WHERE d.status = 'validado' ORDER BY d.id DESC LIMIT 5000`).all();
    const lines = [['ID', 'Validado em (UTC)', 'Ponto', 'Morador', 'Material', 'Quantidade', 'Pontos', 'Funcionário']]
      .concat(rows.map(row => [row.id, row.moment, row.point, row.resident, row.material, row.qty, row.points, row.staff || '']));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="descartes-validados.csv"');
    res.send('\ufeff' + lines.map(line => line.map(csvCell).join(';')).join('\r\n') + '\r\n');
  });
}

module.exports = { registerActivity, createActivityTables, normalizeCode, shortName, csvCell, REJECT_REASONS };
