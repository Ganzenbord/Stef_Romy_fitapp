'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

// Voor het laden van de server: tijdelijke data-map en vaste sleutels
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fit-e2e-'));
process.env.DATA_DIR = tmp;
process.env.SETUP_KEY = 'testkey123';
process.env.SESSION_SECRET = 'x'.repeat(64);

const { app } = require('../server');

let server, base;
test.before(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function client() {
  const jar = {};
  const call = async (method, url, body, { form, noCsrf } = {}) => {
    const headers = {};
    if (!noCsrf) headers['X-Requested-With'] = 'health-app';
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload });
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(';');
      const i = kv.indexOf('=');
      jar[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  };
  return call;
}

const pngForm = () => {
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
  const fd = new FormData();
  fd.append('date', '2026-10-11');
  fd.append('photo', new Blob([bytes], { type: 'image/png' }), 'x.png');
  return fd;
};

const jan = client();
const els = client();
const outsider = client();
let invite;

test('niet ingelogd: summary geeft 401', async () => {
  const r = await jan('GET', '/api/summary');
  assert.equal(r.status, 401);
});

test('CSRF: schrijvend verzoek zonder header wordt geweigerd', async () => {
  const r = await jan('POST', '/api/login', { email: 'a@b.nl', password: 'x' }, { noCsrf: true });
  assert.equal(r.status, 403);
});

test('registratie: verkeerde setup-sleutel faalt, zwak wachtwoord faalt', async () => {
  let r = await jan('POST', '/api/register', { name: 'Jan', email: 'jan@test.nl', password: 'langwachtwoord1', setupKey: 'fout' });
  assert.equal(r.status, 403);
  r = await jan('POST', '/api/register', { name: 'Jan', email: 'jan@test.nl', password: 'kort', setupKey: 'testkey123' });
  assert.equal(r.status, 400);
});

test('registratie: eerste gebruiker maakt huishouden', async () => {
  const r = await jan('POST', '/api/register', { name: 'Jan', email: 'Jan@Test.nl', password: 'langwachtwoord1', setupKey: 'testkey123' });
  assert.equal(r.status, 200);
  const s = await jan('GET', '/api/summary');
  assert.equal(s.status, 200);
  assert.equal(s.data.user.name, 'Jan');
  assert.equal(s.data.profile, null);
  invite = s.data.household.inviteCode;
  assert.match(invite, /^[0-9a-f]{10}$/);
});

test('tweede persoon sluit aan met code; derde wordt geweigerd; tweede huishouden kan niet', async () => {
  let r = await els('POST', '/api/register', { name: 'Els', email: 'els@test.nl', password: 'langwachtwoord2', inviteCode: 'bestaatniet' });
  assert.equal(r.status, 400);
  r = await els('POST', '/api/register', { name: 'Els', email: 'els@test.nl', password: 'langwachtwoord2', inviteCode: invite });
  assert.equal(r.status, 200);
  r = await outsider('POST', '/api/register', { name: 'Derde', email: 'derde@test.nl', password: 'langwachtwoord3', inviteCode: invite });
  assert.equal(r.status, 400);
  r = await outsider('POST', '/api/register', { name: 'Derde', email: 'derde@test.nl', password: 'langwachtwoord3', setupKey: 'testkey123' });
  assert.equal(r.status, 400); // er bestaat al een huishouden
});

test('login: fout wachtwoord 401, goed wachtwoord werkt, e-mail is hoofdletterongevoelig', async () => {
  const c = client();
  let r = await c('POST', '/api/login', { email: 'jan@test.nl', password: 'verkeerd-wachtwoord' });
  assert.equal(r.status, 401);
  r = await c('POST', '/api/login', { email: 'JAN@test.nl', password: 'langwachtwoord1' });
  assert.equal(r.status, 200);
});

test('profiel: ondergewicht-doel en minderjarige worden geweigerd', async () => {
  let r = await els('PUT', '/api/profile', { sex: 'female', birthDate: '1996-03-01', heightCm: 168, goalKg: 50, activity: 'light', ratePct: 0.5 });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /weigert/);
  r = await els('PUT', '/api/profile', { sex: 'female', birthDate: '2015-03-01', heightCm: 168, goalKg: 62, activity: 'light', ratePct: 0.5 });
  assert.equal(r.status, 400);
  r = await els('PUT', '/api/profile', { sex: 'female', birthDate: '1996-03-01', heightCm: 168, goalKg: 62, activity: 'light', ratePct: 3 });
  assert.equal(r.status, 400);
});

test('profielen + metingen: plan komt overeen met de rekentests', async () => {
  let r = await jan('PUT', '/api/profile', { sex: 'male', birthDate: '1996-01-01', heightCm: 180, goalKg: 80, activity: 'light', ratePct: 0.5 });
  assert.equal(r.status, 200);
  r = await els('PUT', '/api/profile', { sex: 'female', birthDate: '1996-03-01', heightCm: 168, goalKg: 62, activity: 'light', ratePct: 0.5 });
  assert.equal(r.status, 200);

  r = await jan('PUT', '/api/entries/2026-10-11', { weightKg: 90, waistCm: 95 });
  assert.equal(r.status, 200);
  r = await els('PUT', '/api/entries/2026-10-11', { weightKg: 70 });
  assert.equal(r.status, 200);

  const s = await jan('GET', '/api/summary');
  assert.equal(s.data.plan.ok, true);
  assert.ok(Math.abs(s.data.plan.targetKcal - 2090) <= 20, `jan kcal ${s.data.plan.targetKcal}`);
  const q = await els('GET', '/api/summary');
  assert.ok(Math.abs(q.data.plan.targetKcal - 1590) <= 20, `els kcal ${q.data.plan.targetKcal}`);
  assert.ok(q.data.plan.targetKcal >= q.data.plan.bmr, 'els boven BMR');
});

test('metingen: upsert behoudt niet-meegestuurd veld; validatie op bereik en toekomst', async () => {
  let r = await jan('PUT', '/api/entries/2026-10-11', { weightKg: 87.9 });
  assert.equal(r.status, 200);
  let s = await jan('GET', '/api/summary');
  const e = s.data.entries.find((x) => x.date === '2026-10-11');
  assert.equal(e.weightKg, 87.9);
  assert.equal(e.waistCm, 95, 'taille moet behouden blijven');

  assert.equal((await jan('PUT', '/api/entries/2026-10-11', { weightKg: 5 })).status, 400);
  assert.equal((await jan('PUT', '/api/entries/2026-10-11', { weightKg: 'abc' })).status, 400);
  assert.equal((await jan('PUT', '/api/entries/2026-10-11', {})).status, 400);
  assert.equal((await jan('PUT', '/api/entries/2099-01-01', { weightKg: 80 })).status, 400);
  assert.equal((await jan('PUT', '/api/entries/geen-datum', { weightKg: 80 })).status, 400);
});

test('te snel afvallen geeft een waarschuwing in progress.note', async () => {
  const c = client();
  await c('POST', '/api/login', { email: 'jan@test.nl', password: 'langwachtwoord1' });
  // 10 dagen met ~0.2 kg/dag = 1.4 kg/week = 1.6% per week
  const t = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const dates = Array.from({ length: 10 }, (_, i) => new Date(Date.parse(t + 'T00:00:00Z') + (i - 10) * 86400000).toISOString().slice(0, 10));
  const w = [90.0, 89.8, 89.6, 89.4, 89.2, 89.0, 88.8, 88.6, 88.4, 88.2];
  for (let i = 0; i < dates.length; i++) await c('PUT', '/api/entries/' + dates[i], { weightKg: w[i] });
  const s = await c('GET', '/api/summary');
  assert.ok(s.data.progress.actualKgPerWeek < -1, `tempo ${s.data.progress.actualKgPerWeek}`);
  assert.match(s.data.progress.note || '', /sneller dan 1%/);
});

test('foto: upload, lijst en ophalen; partner en buitenstaander komen er niet bij', async () => {
  let r = await jan('POST', '/api/photos', undefined, { form: pngForm() });
  assert.equal(r.status, 200);
  const id = r.data.id;
  r = await jan('GET', '/api/photos');
  assert.equal(r.data.photos.length, 1);
  r = await jan('GET', '/api/photos/' + id);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');

  r = await els('GET', '/api/photos/' + id);
  assert.equal(r.status, 404, 'partner mag mijn foto niet zien');
  r = await els('GET', '/api/photos');
  assert.equal(r.data.photos.length, 0);
  r = await els('DELETE', '/api/photos/' + id);
  assert.equal(r.status, 404);
  r = await outsider('GET', '/api/photos/' + id);
  assert.equal(r.status, 401);

  // bestand staat onder de eigen gebruikersmap met willekeurige naam
  const files = fs.readdirSync(path.join(tmp, 'photos', '1'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f]{32}\.png$/);
});

test('foto: geen afbeelding of te groot wordt geweigerd', async () => {
  const fd = new FormData();
  fd.append('photo', new Blob([Buffer.from('dit is geen plaatje, maar tekst van voldoende lengte')], { type: 'image/png' }), 'x.png');
  let r = await jan('POST', '/api/photos', undefined, { form: fd });
  assert.equal(r.status, 400);

  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(9 * 1024 * 1024, 1)]);
  const fd2 = new FormData();
  fd2.append('photo', new Blob([big], { type: 'image/jpeg' }), 'big.jpg');
  r = await jan('POST', '/api/photos', undefined, { form: fd2 });
  assert.equal(r.status, 400);
});

test('foto verwijderen haalt ook het bestand weg', async () => {
  const list = (await jan('GET', '/api/photos')).data.photos;
  const r = await jan('DELETE', '/api/photos/' + list[0].id);
  assert.equal(r.status, 200);
  assert.equal(fs.readdirSync(path.join(tmp, 'photos', '1')).length, 0);
});

test('metingen van partner zijn niet zichtbaar in mijn summary', async () => {
  const q = await els('GET', '/api/summary');
  assert.ok(q.data.entries.every((e) => e.weightKg === 70 || e.weightKg === null));
  assert.equal(q.data.entries.length, 1);
});

test('statische bestanden en headers', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('x-powered-by'), null);
  const m = await fetch(base + '/manifest.webmanifest');
  assert.equal(m.status, 200);
  const nf = await fetch(base + '/api/bestaat-niet');
  assert.equal(nf.status, 404);
});

test('login-rate-limit grijpt in', async () => {
  const c = client();
  let last;
  for (let i = 0; i < 12; i++) last = await c('POST', '/api/login', { email: 'brute@test.nl', password: 'nope-nope-nope' });
  assert.equal(last.status, 429);
});
