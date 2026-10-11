'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fit-food-'));
process.env.DATA_DIR = tmp;
process.env.SETUP_KEY = 'testkey123';
process.env.SESSION_SECRET = 'y'.repeat(64);
delete process.env.OFF_CONTACT_EMAIL;

const { app } = require('../server');
const { db } = require('../lib/db');
const off = require('../lib/off');
const bcrypt = require('bcryptjs');

let server, base;
test.before(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function client() {
  const jar = {};
  return async (method, url, body) => {
    const headers = { 'X-Requested-With': 'health-app' };
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload });
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(';');
      const i = kv.indexOf('=');
      jar[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return { status: res.status, data: await res.json() };
  };
}

const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const yesterday = addDays(today, -1);

const jan = client();
const els = client();
const other = client();
let oats, yoghurt;

test('setup: twee personen, profielen en gewicht', async () => {
  let r = await jan('POST', '/api/register', { name: 'Jan', email: 'jan@test.nl', password: 'langwachtwoord1', setupKey: 'testkey123' });
  assert.equal(r.status, 200);
  const invite = (await jan('GET', '/api/summary')).data.household.inviteCode;
  r = await els('POST', '/api/register', { name: 'Els', email: 'els@test.nl', password: 'langwachtwoord2', inviteCode: invite });
  assert.equal(r.status, 200);

  r = await jan('PUT', '/api/profile', { sex: 'male', birthDate: '1996-01-01', heightCm: 180, goalKg: 80, activity: 'light', ratePct: 0.5, avoid: '  rode   biet ' });
  assert.equal(r.status, 200);
  assert.equal((await jan('GET', '/api/summary')).data.profile.avoid, 'rode biet');
  await els('PUT', '/api/profile', { sex: 'female', birthDate: '1996-03-01', heightCm: 168, goalKg: 62, activity: 'light', ratePct: 0.5 });
  await jan('PUT', '/api/entries/' + today, { weightKg: 90 });
  await els('PUT', '/api/entries/' + today, { weightKg: 70 });

  // Tweede huishouden direct in de database, om scheiding tussen huishoudens te testen
  const hh = db.prepare("INSERT INTO households (invite_code) VALUES ('otherhouse')").run().lastInsertRowid;
  db.prepare('INSERT INTO users (household_id, name, email, pass_hash) VALUES (?,?,?,?)').run(hh, 'Andere', 'andere@test.nl', bcrypt.hashSync('langwachtwoord3', 4));
  r = await other('POST', '/api/login', { email: 'andere@test.nl', password: 'langwachtwoord3' });
  assert.equal(r.status, 200);
});

test('producten: aanmaken met validatie, deelbaar binnen huishouden, niet daarbuiten', async () => {
  let r = await jan('POST', '/api/foods', { name: 'Havermout', kcal100: 370, protein100: 13, carbs100: 60, fat100: 7, servingG: 40, servingLabel: 'portie' });
  assert.equal(r.status, 200);
  oats = r.data.id;
  r = await jan('POST', '/api/foods', { name: 'Griekse yoghurt', brand: 'Merk', kcal100: 97, protein100: 9, carbs100: 4, fat100: 5 });
  yoghurt = r.data.id;

  assert.equal((await jan('POST', '/api/foods', { name: 'Fout', kcal100: -5, protein100: 1, carbs100: 1, fat100: 1 })).status, 400);
  assert.equal((await jan('POST', '/api/foods', { name: 'Fout', kcal100: 100, protein100: 90, carbs100: 90, fat100: 1 })).status, 400);
  r = await jan('POST', '/api/foods', { name: 'Raar', kcal100: 50, protein100: 10, carbs100: 10, fat100: 10 });
  assert.equal(r.status, 200);
  assert.equal(r.data.warnings.length, 1, 'macro/kcal-mismatch geeft een waarschuwing, geen fout');

  r = await els('GET', '/api/foods');
  assert.equal(r.data.foods.length, 3, 'partner ziet gedeelde producten');
  r = await other('GET', '/api/foods');
  assert.equal(r.data.foods.length, 0, 'ander huishouden ziet niets');
  r = await other('PUT', '/api/foods/' + oats, { name: 'Hack', kcal100: 1, protein100: 1, carbs100: 1, fat100: 1 });
  assert.equal(r.status, 404);
  r = await other('DELETE', '/api/foods/' + oats);
  assert.equal(r.status, 404);
  r = await other('POST', '/api/log', { date: today, meal: 'lunch', foodId: oats, grams: 50 });
  assert.equal(r.status, 404, 'kan geen product uit een ander huishouden loggen');
});

test('producten: zoeken (ook met % en _), barcode-dubbelen', async () => {
  assert.equal((await jan('GET', '/api/foods?q=haver')).data.foods.length, 1);
  assert.equal((await jan('GET', '/api/foods?q=merk')).data.foods[0].name, 'Griekse yoghurt', 'zoekt ook op merk');
  assert.equal((await jan('GET', '/api/foods?q=%25')).data.foods.length, 0, '% is geen wildcard');
  assert.equal((await jan('GET', '/api/foods?q=_____')).data.foods.length, 0, '_ is geen wildcard');

  let r = await jan('POST', '/api/foods', { name: 'Kwark', kcal100: 57, protein100: 10, carbs100: 4, fat100: 0.2, barcode: '8710400000000', source: 'off' });
  const id = r.data.id;
  r = await jan('POST', '/api/foods', { name: 'Kwark (nog een keer)', kcal100: 57, protein100: 10, carbs100: 4, fat100: 0.2, barcode: '8710400000000', source: 'off' });
  assert.equal(r.data.existing, true);
  assert.equal(r.data.id, id);
});

test('logboek: toevoegen, dagtotalen en dagdoel', async () => {
  let r = await jan('POST', '/api/log', { date: today, meal: 'breakfast', foodId: oats, grams: 45 });
  assert.equal(r.status, 200);
  await jan('POST', '/api/log', { date: today, meal: 'breakfast', foodId: yoghurt, grams: '150' });

  r = await jan('GET', '/api/day?date=' + today);
  assert.equal(r.data.entries.length, 2);
  // 45 g havermout: 167 kcal (166.5); 150 g yoghurt: 146 kcal (145.5) -> per regel afgerond, daarna opgeteld
  const kcals = r.data.entries.map((e) => e.kcal);
  assert.deepEqual(kcals, [167, 146]);
  assert.equal(r.data.totals.kcal, 313);
  assert.equal(r.data.entries[1].name, 'Griekse yoghurt (Merk)');

  const sum = await jan('GET', '/api/summary');
  assert.equal(r.data.target.kcal, sum.data.plan.targetKcal, 'dagdoel in Eten = dagdoel in Plan');
  assert.equal(r.data.target.protein, sum.data.plan.proteinG);
});

test('logboek: invoervalidatie', async () => {
  const ok = { date: today, meal: 'lunch', foodId: oats, grams: 50 };
  for (const bad of [{ grams: 0 }, { grams: 5001 }, { grams: 'abc' }, { grams: null }, { meal: 'brunch' }, { date: '2099-01-01' }, { date: 'x' }, { foodId: 99999 }]) {
    const r = await jan('POST', '/api/log', { ...ok, ...bad });
    assert.ok([400, 404].includes(r.status), `verwacht 400/404 voor ${JSON.stringify(bad)}, kreeg ${r.status}`);
  }
});

test('logboek: per persoon gescheiden, wijzigen en verwijderen alleen eigen regels', async () => {
  const day = (await jan('GET', '/api/day?date=' + today)).data;
  const id = day.entries[0].id;
  assert.equal((await els('GET', '/api/day?date=' + today)).data.entries.length, 0);
  assert.equal((await els('PUT', '/api/log/' + id, { grams: 10 })).status, 404);
  assert.equal((await els('DELETE', '/api/log/' + id)).status, 404);

  let r = await jan('PUT', '/api/log/' + id, { grams: 80 });
  assert.equal(r.status, 200);
  r = await jan('GET', '/api/day?date=' + today);
  assert.equal(r.data.entries[0].grams, 80);
  assert.equal(r.data.entries[0].kcal, 296); // 370 * 0.8
  r = await jan('PUT', '/api/log/' + id, { grams: 45 }); // terug, zonder afrondingsdrift
  r = await jan('GET', '/api/day?date=' + today);
  assert.equal(r.data.entries[0].kcal, 167);
  assert.equal((await jan('PUT', '/api/log/' + id, { grams: 0 })).status, 400);
});

test('momentopname: product aanpassen of verwijderen herschrijft eerdere logregels niet', async () => {
  let r = await jan('PUT', '/api/foods/' + oats, { name: 'Havermout', kcal100: 400, protein100: 14, carbs100: 62, fat100: 8 });
  assert.equal(r.status, 200);
  r = await jan('GET', '/api/day?date=' + today);
  assert.equal(r.data.entries[0].kcal, 167, 'oude logregel blijft op 370 kcal/100 g');
  r = await jan('POST', '/api/log', { date: today, meal: 'snack', foodId: oats, grams: 45 });
  r = await jan('GET', '/api/day?date=' + today);
  assert.equal(r.data.entries[2].kcal, 180, 'nieuwe logregel gebruikt de nieuwe waarden');

  r = await jan('DELETE', '/api/foods/' + yoghurt);
  assert.equal(r.status, 200);
  r = await jan('GET', '/api/day?date=' + today);
  const y = r.data.entries.find((e) => e.name.startsWith('Griekse'));
  assert.ok(y, 'logregel blijft bestaan');
  assert.equal(y.foodId, null);
  assert.equal(y.kcal, 146);
});

test('kopiëren: maaltijd van gisteren naar vandaag', async () => {
  await jan('POST', '/api/log', { date: yesterday, meal: 'dinner', foodId: oats, grams: 100 });
  await jan('POST', '/api/log', { date: yesterday, meal: 'dinner', foodId: oats, grams: 50 });
  await jan('POST', '/api/log', { date: yesterday, meal: 'lunch', foodId: oats, grams: 20 });

  let r = await jan('POST', '/api/log/copy', { fromDate: yesterday, toDate: today, meal: 'dinner' });
  assert.equal(r.data.copied, 2);
  r = await jan('GET', '/api/day?date=' + today);
  assert.equal(r.data.entries.filter((e) => e.meal === 'dinner').length, 2);

  assert.equal((await jan('POST', '/api/log/copy', { fromDate: today, toDate: today })).status, 400);
  assert.equal((await jan('POST', '/api/log/copy', { fromDate: yesterday, toDate: today, meal: 'brunch' })).status, 400);
  r = await jan('POST', '/api/log/copy', { fromDate: addDays(today, -5), toDate: today });
  assert.equal(r.data.copied, 0, 'niets te kopiëren is geen fout');
});

// ---------- Open Food Facts (met nagebootste netwerkantwoorden) ----------
const mockFetch = (handler) => {
  const calls = [];
  off.setFetch(async (url, opts) => {
    calls.push({ url: String(url), headers: opts && opts.headers });
    return handler(url);
  });
  return calls;
};
const okJson = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const prod = (code, name, kcal = 57) => ({ code, product_name: name, brands: 'Merk', nutriments: { 'energy-kcal_100g': kcal, proteins_100g: 10, carbohydrates_100g: 4, fat_100g: 0.2 } });

test('OFF: zonder OFF_CONTACT_EMAIL is online zoeken uitgeschakeld (503) en wordt er niets opgehaald', async () => {
  delete process.env.OFF_CONTACT_EMAIL;
  off.resetLimits();
  const calls = mockFetch(() => okJson({ products: [] }));
  const r = await jan('POST', '/api/off/search', { q: 'kwark' });
  assert.equal(r.status, 503);
  assert.match(r.data.error, /OFF_CONTACT_EMAIL/);
  assert.equal(calls.length, 0);
});

test('OFF: zoeken stuurt een eigen User-Agent, filtert onbruikbare producten en dubbelen', async () => {
  process.env.OFF_CONTACT_EMAIL = 'test@example.org';
  off.resetLimits();
  const calls = mockFetch(() =>
    okJson({
      products: [
        prod('8710400000001', 'Kwark mager'),
        prod('8710400000001', 'Kwark mager dubbel'),
        { code: '8710400000002', product_name: 'Zonder voedingswaarden', nutriments: {} },
        prod('8710400000003', 'Onzin', 5000),
      ],
    })
  );
  const r = await jan('POST', '/api/off/search', { q: 'kwark & zo' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.results.map((x) => x.name), ['Kwark mager']);
  assert.equal(calls.length, 1);
  assert.match(calls[0].headers['User-Agent'], /^FitHealthApp\/0\.2 \(test@example\.org\)$/);
  assert.ok(calls[0].url.includes('search_terms=kwark%20%26%20zo'), calls[0].url);
  assert.ok(calls[0].url.startsWith('https://nl.openfoodfacts.org/'));

  assert.equal((await jan('POST', '/api/off/search', { q: 'k' })).status, 400);
  assert.equal(calls.length, 1, 'ongeldige zoekterm bereikt het netwerk niet');
});

test('OFF: eigen limiet van 8 zoekopdrachten per minuut', async () => {
  off.resetLimits();
  mockFetch(() => okJson({ products: [] }));
  let last;
  for (let i = 0; i < 9; i++) last = await jan('POST', '/api/off/search', { q: 'havermout' });
  assert.equal(last.status, 429);
});

test('OFF: foutafhandeling bij netwerkfout en overbelasting', async () => {
  off.resetLimits();
  mockFetch(() => { throw new Error('ECONNRESET'); });
  let r = await jan('POST', '/api/off/search', { q: 'kwark' });
  assert.equal(r.status, 502);
  mockFetch(() => okJson({}, 503));
  r = await jan('POST', '/api/off/search', { q: 'kwark' });
  assert.equal(r.status, 503);
  mockFetch(() => ({ ok: true, status: 200, json: async () => { throw new Error('geen json'); } }));
  r = await jan('POST', '/api/off/search', { q: 'kwark' });
  assert.equal(r.status, 502);
});

test('OFF: barcode gevonden, niet gevonden, ongeldig', async () => {
  off.resetLimits();
  let calls = mockFetch(() => okJson({ status: 1, product: prod('8710400000009', 'Skyr') }));
  let r = await jan('POST', '/api/off/barcode', { barcode: '8710400000009' });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.name, 'Skyr');
  assert.ok(calls[0].url.includes('/api/v2/product/8710400000009.json'));

  mockFetch(() => okJson({ status: 0, status_verbose: 'product not found' }));
  r = await jan('POST', '/api/off/barcode', { barcode: '8710400000010' });
  assert.equal(r.data.result, null);

  r = await jan('POST', '/api/off/barcode', { barcode: '12ab' });
  assert.equal(r.status, 400);
});

test('OFF: kandidaat opslaan en loggen werkt als gewoon product', async () => {
  off.resetLimits();
  mockFetch(() => okJson({ status: 1, product: prod('8710400000011', 'Skyr naturel', 63) }));
  const cand = (await jan('POST', '/api/off/barcode', { barcode: '8710400000011' })).data.result;
  let r = await jan('POST', '/api/foods', { ...cand, source: 'off' });
  assert.equal(r.status, 200);
  r = await jan('POST', '/api/log', { date: today, meal: 'snack', foodId: r.data.id, grams: 200 });
  assert.equal(r.status, 200);
  const day = (await jan('GET', '/api/day?date=' + today)).data;
  assert.equal(day.entries[day.entries.length - 1].kcal, 126);
});

test('niet ingelogd: voedings-API geeft 401', async () => {
  const anon = client();
  for (const [m, u] of [['GET', '/api/foods'], ['GET', '/api/day'], ['POST', '/api/log'], ['POST', '/api/off/search']]) {
    assert.equal((await anon(m, u, m === 'POST' ? {} : undefined)).status, 401, `${m} ${u}`);
  }
});
