const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../server');
const token = response => response.text.match(/name="csrf" value="([^"]+)"/)[1];

test('cadastro, validação, login, proteção CSRF e logout', async t => {
  const app = createApp({ databasePath: ':memory:', secret: 'test-secret-with-at-least-32-characters' });
  t.after(() => app.locals.db.close());
  const browser = request.agent(app);
  await browser.get('/painel').expect(302).expect('Location', '/login');
  let page = await browser.get('/cadastro').expect(200);
  await browser.post('/cadastro').type('form').send({ name: 'Ana', email: 'ana@example.com', password: 'senha longa de teste' }).expect(403);
  await browser.post('/cadastro').type('form').send({ csrf: token(page), name: 'Ana', email: 'ana@example.com', password: 'curta' }).expect(400);
  await browser.post('/cadastro').type('form').send({ csrf: token(page), name: '<script>alert(1)</script>', email: 'ANA@example.com', password: 'senha longa de teste' }).expect(302).expect('Location', '/painel');
  const user = app.locals.db.prepare('SELECT * FROM users').get();
  assert.equal(user.email, 'ana@example.com');
  assert.notEqual(user.password_hash, 'senha longa de teste');
  page = await browser.get('/painel').expect(200);
  assert.ok(page.text.includes('&lt;script&gt;'));
  assert.ok(!page.text.includes('<script>alert(1)</script>'));
  await browser.post('/logout').type('form').send({ csrf: token(page) }).expect(302);
  await browser.get('/painel').expect(302);
  page = await browser.get('/login').expect(200);
  await browser.post('/login').type('form').send({ csrf: token(page), email: 'ana@example.com', password: 'errada' }).expect(401);
  await browser.post('/login').type('form').send({ csrf: token(page), email: "' OR 1=1 --", password: 'senha longa de teste' }).expect(401);
  await browser.post('/login').type('form').send({ csrf: token(page), email: 'ana@example.com', password: 'senha longa de teste' }).expect(302);
  await browser.get('/painel').expect(200);
  const other = request.agent(app);
  const form = await other.get('/cadastro');
  await other.post('/cadastro').type('form').send({ csrf: token(form), name: 'Outra Ana', email: 'ana@example.com', password: 'outra senha longa' }).expect(409);
});

test('limita tentativas de autenticação', async t => {
  const app = createApp({ databasePath: ':memory:' });
  t.after(() => app.locals.db.close());
  const browser = request.agent(app);
  const page = await browser.get('/login');
  for (let i = 0; i < 20; i++) {
    await browser.post('/login').type('form').send({ csrf: token(page), email: 'invalido', password: 'x' }).expect(401);
  }
  await browser.post('/login').type('form').send({ csrf: token(page), email: 'invalido', password: 'x' }).expect(429);
});
