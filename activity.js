const { MATERIALS, POINTS, REWARDS } = require('./catalog');

const MAX_QTY = 10;

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
  CREATE INDEX IF NOT EXISTS redemptions_user ON redemptions(user_id, id);`);
}

function totals(db, userId) {
  const earned = db.prepare('SELECT COALESCE(SUM(points), 0) AS points, COUNT(*) AS count FROM disposals WHERE user_id = ?').get(userId);
  const spent = db.prepare('SELECT COALESCE(SUM(cost), 0) AS cost FROM redemptions WHERE user_id = ?').get(userId);
  return { earned: earned.points, count: earned.count, balance: earned.points - spent.cost };
}

function registerActivity(app, { db, disposalLimiter }) {
  const fail = (res, status, error) => res.status(status).json({ error });
  const apiAuth = (req, res, next) =>
    req.session.userId ? next() : fail(res, 401, 'Sessão expirada. Entre novamente.');

  app.get('/api/me', apiAuth, (req, res) => {
    const userId = req.session.userId;
    const user = db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
    if (!user) return fail(res, 401, 'Sessão expirada. Entre novamente.');
    const sums = totals(db, userId);
    const rank = sums.count === 0 ? null : 1 + db.prepare(
      'SELECT COUNT(*) AS higher FROM (SELECT SUM(points) AS total FROM disposals GROUP BY user_id) WHERE total > ?'
    ).get(sums.earned).higher;
    const participants = db.prepare('SELECT COUNT(DISTINCT user_id) AS total FROM disposals').get().total;
    const disposals = db.prepare(`SELECT id, material, qty, point, points, created_at FROM disposals
      WHERE user_id = ? ORDER BY id DESC LIMIT 500`).all(userId)
      .map(row => ({ id: row.id, material: row.material, qty: row.qty, point: row.point, points: row.points, createdAt: row.created_at }));
    const redemptions = db.prepare(`SELECT id, reward, cost, created_at FROM redemptions
      WHERE user_id = ? ORDER BY id DESC LIMIT 100`).all(userId)
      .map(row => ({ id: row.id, reward: row.reward, cost: row.cost, createdAt: row.created_at }));
    res.json({ name: user.name, balance: sums.balance, earned: sums.earned, count: sums.count, rank, participants, disposals, redemptions });
  });

  app.post('/api/disposals', apiAuth, disposalLimiter, (req, res) => {
    const body = req.body || {};
    const material = MATERIALS.find(item => item.id === body.material);
    const point = POINTS.find(item => item.id === body.point);
    const qty = typeof body.qty === 'number' || (typeof body.qty === 'string' && /^\d{1,2}$/.test(body.qty)) ? Number(body.qty) : NaN;
    if (!material) return fail(res, 400, 'Escolha o tipo de material.');
    if (!point) return fail(res, 400, 'Escolha o ponto de descarte.');
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return fail(res, 400, `A quantidade deve ser de 1 a ${MAX_QTY}.`);
    const earned = material.pts * qty;
    db.prepare(`INSERT INTO disposals (user_id, material_id, material, point_id, point, qty, points)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.session.userId, material.id, material.name, point.id, point.name, qty, earned);
    res.status(201).json({ earned, balance: totals(db, req.session.userId).balance });
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
}

module.exports = { registerActivity, createActivityTables };
