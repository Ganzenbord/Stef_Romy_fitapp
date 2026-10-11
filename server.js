'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const cookieSession = require('cookie-session');
const multer = require('multer');

// Optioneel .env naast server.js (staat in .gitignore). Bestaande omgevingsvariabelen winnen.
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (_) { /* geen .env, of oudere Node: dan werken gewone omgevingsvariabelen */ }

const { db, DATA_DIR } = require('./lib/db');
const calc = require('./lib/calc');
const food = require('./lib/food');
const off = require('./lib/off');

const app = express();
const IS_PROD = process.env.NODE_ENV === 'production';
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ---------- secrets ----------
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, 'session.secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}
const SETUP_KEY = process.env.SETUP_KEY || crypto.randomBytes(6).toString('hex');

// ---------- helpers ----------
const todayNL = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const ageFrom = (birth) => {
  const b = new Date(birth + 'T00:00:00Z');
  const t = new Date(todayNL() + 'T00:00:00Z');
  let a = t.getUTCFullYear() - b.getUTCFullYear();
  const m = t.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && t.getUTCDate() < b.getUTCDate())) a--;
  return a;
};
const fail = (res, code, msg) => res.status(code).json({ error: msg });

// Berekent de maandag van de week van een gegeven datum (YYYY-MM-DD)
const weekStart = (dateStr) => {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0=Sunday, 1=Monday...
  const diff = (day === 0 ? -6 : 1 - day); // verschil naar maandag
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
};

// ---------- middleware ----------
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  next();
});
app.use(express.json({ limit: '50kb' }));
app.use(
  cookieSession({
    name: 'hs',
    keys: [loadSecret()],
    maxAge: 90 * 24 * 3600 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
  })
);

// CSRF: alle schrijvende API-calls moeten een eigen header meesturen (kan een andere site niet zetten)
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'health-app') return fail(res, 403, 'Ongeldig verzoek.');
  next();
});

// Eenvoudige rate limit voor login/registratie
const attempts = new Map();
function limited(key, max = 10, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const rec = (attempts.get(key) || []).filter((t) => now - t < windowMs);
  if (rec.length >= max) {
    attempts.set(key, rec);
    return true;
  }
  rec.push(now);
  attempts.set(key, rec);
  return false;
}

const requireAuth = (req, res, next) => {
  const id = req.session && req.session.uid;
  if (!id) return fail(res, 401, 'Niet ingelogd.');
  const user = db.prepare('SELECT id, household_id, name, email FROM users WHERE id = ?').get(id);
  if (!user) {
    req.session = null;
    return fail(res, 401, 'Niet ingelogd.');
  }
  req.user = user;
  next();
};

// ---------- auth ----------
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);

app.post('/api/register', (req, res) => {
  if (limited('reg:' + req.ip, 10)) return fail(res, 429, 'Te veel pogingen. Probeer het later opnieuw.');
  const name = String(req.body.name || '').trim().slice(0, 40);
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const inviteCode = String(req.body.inviteCode || '').trim().toLowerCase();
  const setupKey = String(req.body.setupKey || '').trim();

  if (!name) return fail(res, 400, 'Naam ontbreekt.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'Ongeldig e-mailadres.');
  if (password.length < 10) return fail(res, 400, 'Wachtwoord moet minimaal 10 tekens zijn.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return fail(res, 400, 'Registratie niet mogelijk met deze gegevens.');

  let household;
  if (inviteCode) {
    household = db.prepare('SELECT * FROM households WHERE invite_code = ?').get(inviteCode);
    if (!household) return fail(res, 400, 'Ongeldige uitnodigingscode.');
    const members = db.prepare('SELECT COUNT(*) c FROM users WHERE household_id = ?').get(household.id).c;
    if (members >= 2) return fail(res, 400, 'Dit huishouden zit vol (maximaal 2 personen).');
  } else {
    const exists = db.prepare('SELECT COUNT(*) c FROM households').get().c;
    if (exists > 0) return fail(res, 400, 'Gebruik een uitnodigingscode om je aan te sluiten.');
    const a = Buffer.from(setupKey);
    const b = Buffer.from(SETUP_KEY);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail(res, 403, 'Ongeldige setup-sleutel.');
  }

  const hash = bcrypt.hashSync(password, 12);
  const tx = db.transaction(() => {
    if (!household) {
      const code = crypto.randomBytes(5).toString('hex');
      const r = db.prepare('INSERT INTO households (invite_code) VALUES (?)').run(code);
      household = { id: r.lastInsertRowid, invite_code: code };
    }
    return db.prepare('INSERT INTO users (household_id, name, email, pass_hash) VALUES (?,?,?,?)').run(household.id, name, email, hash)
      .lastInsertRowid;
  });
  const uid = tx();
  req.session = { uid };
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (limited('login:' + req.ip + ':' + email, 8)) return fail(res, 429, 'Te veel pogingen. Probeer het later opnieuw.');
  const user = db.prepare('SELECT id, pass_hash FROM users WHERE email = ?').get(email);
  const ok = bcrypt.compareSync(password, user ? user.pass_hash : DUMMY_HASH);
  if (!user || !ok) return fail(res, 401, 'E-mail of wachtwoord klopt niet.');
  req.session = { uid: user.id };
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

// ---------- profiel ----------
const profileOut = (p) =>
  p
    ? {
        sex: p.sex,
        birthDate: p.birth_date,
        heightCm: p.height_cm,
        goalKg: p.goal_kg,
        activity: p.activity,
        ratePct: p.rate_pct,
        avoid: p.avoid || '',
      }
    : null;

app.put('/api/profile', requireAuth, (req, res) => {
  const b = req.body || {};
  const p = {
    sex: b.sex,
    birthDate: b.birthDate,
    heightCm: num(b.heightCm),
    goalKg: num(b.goalKg),
    activity: b.activity || 'light',
    ratePct: num(b.ratePct) ?? 0.5,
    avoid: String(b.avoid || '').trim().replace(/\s+/g, ' ').slice(0, 200),
  };
  if (!isDate(p.birthDate)) return fail(res, 400, 'Ongeldige geboortedatum.');
  const age = ageFrom(p.birthDate);
  const errors = calc.validate({ sex: p.sex, age, heightCm: p.heightCm, weightKg: 70, goalKg: p.goalKg, activity: p.activity });
  if (errors.length) return fail(res, 400, errors[0]);
  if (!(p.ratePct >= 0.25 && p.ratePct <= 1)) return fail(res, 400, 'Tempo moet tussen 0,25 en 1,0% per week liggen.');

  // Doel-check tegen de veiligheidsgrenzen (BMI-ondergrens e.d.)
  const check = calc.plan({ sex: p.sex, age, heightCm: p.heightCm, weightKg: Math.max(p.goalKg + 1, 40), goalKg: p.goalKg, activity: p.activity, ratePct: p.ratePct });
  if (!check.ok) return fail(res, 400, check.errors[0]);

  db.prepare(
    `INSERT INTO profiles (user_id, sex, birth_date, height_cm, goal_kg, activity, rate_pct, avoid, updated_at)
     VALUES (?,?,?,?,?,?,?,?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET sex=excluded.sex, birth_date=excluded.birth_date, height_cm=excluded.height_cm,
       goal_kg=excluded.goal_kg, activity=excluded.activity, rate_pct=excluded.rate_pct, avoid=excluded.avoid, updated_at=excluded.updated_at`
  ).run(req.user.id, p.sex, p.birthDate, p.heightCm, p.goalKg, p.activity, p.ratePct, p.avoid);
  res.json({ ok: true });
});

// ---------- metingen ----------
app.put('/api/entries/:date', requireAuth, (req, res) => {
  const date = req.params.date;
  if (!isDate(date)) return fail(res, 400, 'Ongeldige datum.');
  const t = new Date(todayNL() + 'T00:00:00Z').getTime() + 86400000; // morgen is de grens
  if (Date.parse(date + 'T00:00:00Z') > t) return fail(res, 400, 'Datum ligt in de toekomst.');
  const weight = num(req.body.weightKg);
  const waist = num(req.body.waistCm);
  if (weight === null && waist === null) return fail(res, 400, 'Vul gewicht of taille in.');
  if (weight !== null && !(weight >= 30 && weight <= 300)) return fail(res, 400, 'Gewicht moet tussen 30 en 300 kg liggen.');
  if (waist !== null && !(waist >= 40 && waist <= 200)) return fail(res, 400, 'Taille moet tussen 40 en 200 cm liggen.');
  if (Number.isNaN(weight) || Number.isNaN(waist)) return fail(res, 400, 'Ongeldig getal.');

  db.prepare(
    `INSERT INTO entries (user_id, date, weight_kg, waist_cm) VALUES (?,?,?,?)
     ON CONFLICT(user_id, date) DO UPDATE SET
       weight_kg = COALESCE(excluded.weight_kg, entries.weight_kg),
       waist_cm = COALESCE(excluded.waist_cm, entries.waist_cm)`
  ).run(req.user.id, date, weight, waist);
  res.json({ ok: true });
});

app.delete('/api/entries/:date', requireAuth, (req, res) => {
  if (!isDate(req.params.date)) return fail(res, 400, 'Ongeldige datum.');
  db.prepare('DELETE FROM entries WHERE user_id = ? AND date = ?').run(req.user.id, req.params.date);
  res.json({ ok: true });
});

// ---------- samenvatting ----------
function slopePerWeek(points) {
  // points: [{date, value}], lineaire regressie over de dagen
  if (points.length < 4) return null;
  const t0 = Date.parse(points[0].date + 'T00:00:00Z');
  const xs = points.map((p) => (Date.parse(p.date + 'T00:00:00Z') - t0) / 86400000);
  if (xs[xs.length - 1] < 7) return null;
  const n = points.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = points.reduce((s, p) => s + p.value, 0) / n;
  let num_ = 0;
  let den = 0;
  points.forEach((p, i) => {
    num_ += (xs[i] - mx) * (p.value - my);
    den += (xs[i] - mx) ** 2;
  });
  return den === 0 ? null : (num_ / den) * 7;
}

app.get('/api/summary', requireAuth, (req, res) => {
  const uid = req.user.id;
  const profileRow = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(uid);
  const rows = db.prepare('SELECT date, weight_kg, waist_cm FROM entries WHERE user_id = ? ORDER BY date').all(uid);

  const weights = calc.movingAverage(rows.filter((r) => r.weight_kg !== null).map((r) => ({ date: r.date, value: r.weight_kg })), 7);
  const avgByDate = Object.fromEntries(weights.map((w) => [w.date, w.avg]));
  const entries = rows.map((r) => ({ date: r.date, weightKg: r.weight_kg, waistCm: r.waist_cm, avgKg: avgByDate[r.date] ?? null }));

  const household = db.prepare('SELECT invite_code FROM households WHERE id = ?').get(req.user.household_id);
  const members = db.prepare('SELECT name FROM users WHERE household_id = ? ORDER BY id').all(req.user.household_id).map((m) => m.name);

  let plan = null;
  let progress = null;
  if (profileRow && weights.length) {
    const last = weights[weights.length - 1];
    plan = calc.plan({
      sex: profileRow.sex,
      age: ageFrom(profileRow.birth_date),
      heightCm: profileRow.height_cm,
      weightKg: last.avg,
      goalKg: profileRow.goal_kg,
      activity: profileRow.activity,
      ratePct: profileRow.rate_pct,
    });
    const startKg = weights[0].value;
    const recent = weights.filter((w) => Date.parse(last.date + 'T00:00:00Z') - Date.parse(w.date + 'T00:00:00Z') <= 14 * 86400000).map((w) => ({ date: w.date, value: w.value }));
    const actual = slopePerWeek(recent);
    let note = null;
    if (actual !== null && actual < 0 && Math.abs(actual) > last.avg * 0.01 + 0.05) {
      note = 'Je verliest sneller dan 1% lichaamsgewicht per week. Dat is sneller dan verstandig; eet meer of vraag advies.';
    }
    progress = {
      startKg,
      currentAvgKg: last.avg,
      changeKg: Math.round((last.avg - startKg) * 100) / 100,
      remainingKg: Math.round((last.avg - profileRow.goal_kg) * 100) / 100,
      actualKgPerWeek: actual === null ? null : Math.round(actual * 100) / 100,
      note,
    };
  }

  res.json({
    user: { id: uid, name: req.user.name, email: req.user.email },
    household: { inviteCode: household.invite_code, members },
    profile: profileOut(profileRow),
    plan,
    progress,
    entries,
    today: todayNL(),
  });
});

// ---------- foto's (privé per account) ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const sniff = (b) => {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ['image/jpeg', 'jpg'];
  if (b.length > 12 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ['image/png', 'png'];
  if (b.length > 12 && b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return ['image/webp', 'webp'];
  return null;
};

app.post('/api/photos', requireAuth, (req, res) => {
  upload.single('photo')(req, res, (err) => {
    if (err) return fail(res, 400, err.code === 'LIMIT_FILE_SIZE' ? 'Foto is te groot (max 8 MB).' : 'Upload mislukt.');
    if (!req.file) return fail(res, 400, 'Geen foto ontvangen.');
    const kind = sniff(req.file.buffer);
    if (!kind) return fail(res, 400, 'Alleen JPEG, PNG of WebP.');
    const date = isDate(req.body.date) ? req.body.date : todayNL();
    const dir = path.join(DATA_DIR, 'photos', String(req.user.id));
    fs.mkdirSync(dir, { recursive: true });
    const file = crypto.randomBytes(16).toString('hex') + '.' + kind[1];
    fs.writeFileSync(path.join(dir, file), req.file.buffer, { mode: 0o600 });
    const r = db.prepare('INSERT INTO photos (user_id, date, file, mime) VALUES (?,?,?,?)').run(req.user.id, date, file, kind[0]);
    res.json({ ok: true, id: r.lastInsertRowid });
  });
});

app.get('/api/photos', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, date FROM photos WHERE user_id = ? ORDER BY date DESC, id DESC').all(req.user.id);
  res.json({ photos: rows });
});

app.get('/api/photos/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM photos WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!row) return fail(res, 404, 'Niet gevonden.');
  const p = path.join(DATA_DIR, 'photos', String(req.user.id), row.file);
  if (!fs.existsSync(p)) return fail(res, 404, 'Niet gevonden.');
  res.set({ 'Content-Type': row.mime, 'Cache-Control': 'private, max-age=3600' });
  res.sendFile(p);
});

app.delete('/api/photos/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM photos WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!row) return fail(res, 404, 'Niet gevonden.');
  try {
    fs.unlinkSync(path.join(DATA_DIR, 'photos', String(req.user.id), row.file));
  } catch (_) {}
  db.prepare('DELETE FROM photos WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// ---------- v0.2: voeding ----------
function currentPlan(uid) {
  const prof = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(uid);
  if (!prof) return null;
  const rows = db.prepare('SELECT date, weight_kg FROM entries WHERE user_id = ? AND weight_kg IS NOT NULL ORDER BY date').all(uid);
  if (!rows.length) return null;
  const w = calc.movingAverage(rows.map((r) => ({ date: r.date, value: r.weight_kg })), 7);
  const plan = calc.plan({
    sex: prof.sex,
    age: ageFrom(prof.birth_date),
    heightCm: prof.height_cm,
    weightKg: w[w.length - 1].avg,
    goalKg: prof.goal_kg,
    activity: prof.activity,
    ratePct: prof.rate_pct,
  });
  return plan.ok ? plan : null;
}

const foodOut = (f) => ({
  id: f.id,
  name: f.name,
  brand: f.brand,
  barcode: f.barcode,
  kcal100: f.kcal100,
  protein100: f.protein100,
  carbs100: f.carbs100,
  fat100: f.fat100,
  servingG: f.serving_g,
  servingLabel: f.serving_label,
  source: f.source,
  uses: f.uses ?? 0,
});
const likeEscape = (s) => s.replace(/[\\%_]/g, (m) => '\\' + m);
const MAX_FOODS = 5000;

app.get('/api/foods', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  const params = [req.user.id, req.user.household_id];
  let where = 'f.household_id = ?';
  if (q) {
    where += " AND (f.name LIKE ? ESCAPE '\\' OR f.brand LIKE ? ESCAPE '\\')";
    const like = '%' + likeEscape(q) + '%';
    params.push(like, like);
  }
  const rows = db
    .prepare(
      `SELECT f.*, COUNT(l.id) AS uses, MAX(l.date) AS last
       FROM foods f LEFT JOIN log l ON l.food_id = f.id AND l.user_id = ?
       WHERE ${where} GROUP BY f.id ORDER BY uses DESC, last DESC, f.name LIMIT 40`
    )
    .all(...params);
  res.json({ foods: rows.map(foodOut) });
});

app.post('/api/foods', requireAuth, (req, res) => {
  const v = food.validateFood(req.body || {});
  if (!v.ok) return fail(res, 400, v.errors[0]);
  const f = v.value;
  const hh = req.user.household_id;
  if (f.barcode) {
    const ex = db.prepare('SELECT id FROM foods WHERE household_id = ? AND barcode = ?').get(hh, f.barcode);
    if (ex) return res.json({ id: ex.id, existing: true, warnings: [] });
  }
  if (db.prepare('SELECT COUNT(*) c FROM foods WHERE household_id = ?').get(hh).c >= MAX_FOODS) return fail(res, 400, 'Maximaal aantal producten bereikt.');
  const source = req.body.source === 'off' ? 'off' : 'own';
  const r = db
    .prepare(
      `INSERT INTO foods (household_id, name, brand, barcode, kcal100, protein100, carbs100, fat100, serving_g, serving_label, source, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(hh, f.name, f.brand, f.barcode, f.kcal100, f.protein100, f.carbs100, f.fat100, f.servingG, f.servingLabel, source, req.user.id);
  res.json({ id: Number(r.lastInsertRowid), warnings: v.warnings });
});

app.put('/api/foods/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id FROM foods WHERE id = ? AND household_id = ?').get(id, req.user.household_id);
  if (!row) return fail(res, 404, 'Niet gevonden.');
  const v = food.validateFood(req.body || {});
  if (!v.ok) return fail(res, 400, v.errors[0]);
  const f = v.value;
  try {
    db.prepare(
      `UPDATE foods SET name=?, brand=?, barcode=?, kcal100=?, protein100=?, carbs100=?, fat100=?, serving_g=?, serving_label=? WHERE id=?`
    ).run(f.name, f.brand, f.barcode, f.kcal100, f.protein100, f.carbs100, f.fat100, f.servingG, f.servingLabel, id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return fail(res, 400, 'Deze barcode hoort al bij een ander product.');
    throw e;
  }
  res.json({ ok: true, warnings: v.warnings });
});

app.delete('/api/foods/:id', requireAuth, (req, res) => {
  const r = db.prepare('DELETE FROM foods WHERE id = ? AND household_id = ?').run(Number(req.params.id), req.user.household_id);
  if (!r.changes) return fail(res, 404, 'Niet gevonden.');
  res.json({ ok: true }); // logregels blijven bestaan (food_id wordt leeg, de momentopname blijft)
});

// Open Food Facts (online). Resultaten worden pas opgeslagen als je ze kiest (POST /api/foods).
const offErr = (res, e) => {
  if (e instanceof off.OffError) return fail(res, e.status, e.message);
  throw e;
};

app.post('/api/off/search', requireAuth, async (req, res) => {
  const q = String(req.body.q || '').trim();
  if (q.length < 2 || q.length > 60) return fail(res, 400, 'Zoekterm moet 2 tot 60 tekens zijn.');
  try {
    const results = await off.search(q);
    const seen = new Set();
    res.json({ results: results.filter((r) => !r.barcode || !seen.has(r.barcode) && seen.add(r.barcode)) });
  } catch (e) {
    offErr(res, e);
  }
});

app.post('/api/off/barcode', requireAuth, async (req, res) => {
  try {
    res.json({ result: await off.barcode(String(req.body.barcode || '').trim()) });
  } catch (e) {
    offErr(res, e);
  }
});

// Logboek
const validDay = (d) => isDate(d) && Date.parse(d + 'T00:00:00Z') <= new Date(todayNL() + 'T00:00:00Z').getTime() + 86400000;
const logOut = (r) => {
  const s = food.scale({ kcal: r.kcal100, protein: r.protein100, carbs: r.carbs100, fat: r.fat100 }, r.grams);
  return { id: r.id, date: r.date, meal: r.meal, foodId: r.food_id, name: r.name, grams: r.grams, per100: { kcal: r.kcal100, protein: r.protein100, carbs: r.carbs100, fat: r.fat100 }, ...s };
};
const MAX_LOG_PER_DAY = 200;
const gramsOk = (g) => typeof g === 'number' && Number.isFinite(g) && g >= 1 && g <= 5000;

app.get('/api/day', requireAuth, (req, res) => {
  const date = req.query.date || todayNL();
  if (!validDay(date)) return fail(res, 400, 'Ongeldige datum.');
  const entries = db.prepare('SELECT * FROM log WHERE user_id = ? AND date = ? ORDER BY id').all(req.user.id, date).map(logOut);
  const plan = currentPlan(req.user.id);
  res.json({
    date,
    entries,
    totals: food.sumTotals(entries),
    target: plan ? { kcal: plan.targetKcal, protein: plan.proteinG, carbs: plan.carbsG, fat: plan.fatG } : null,
  });
});

app.post('/api/log', requireAuth, (req, res) => {
  const { date, meal } = req.body || {};
  const grams = num(req.body.grams);
  if (!validDay(date)) return fail(res, 400, 'Ongeldige datum.');
  if (!food.MEALS.includes(meal)) return fail(res, 400, 'Ongeldige maaltijd.');
  if (!gramsOk(grams)) return fail(res, 400, 'Hoeveelheid moet tussen 1 en 5000 gram liggen.');
  const f = db.prepare('SELECT * FROM foods WHERE id = ? AND household_id = ?').get(Number(req.body.foodId), req.user.household_id);
  if (!f) return fail(res, 404, 'Product niet gevonden.');
  if (db.prepare('SELECT COUNT(*) c FROM log WHERE user_id = ? AND date = ?').get(req.user.id, date).c >= MAX_LOG_PER_DAY) return fail(res, 400, 'Te veel regels voor één dag.');
  const r = db
    .prepare('INSERT INTO log (user_id, date, meal, food_id, name, grams, kcal100, protein100, carbs100, fat100) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(req.user.id, date, meal, f.id, f.brand ? `${f.name} (${f.brand})` : f.name, grams, f.kcal100, f.protein100, f.carbs100, f.fat100);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});

app.put('/api/log/:id', requireAuth, (req, res) => {
  const grams = num(req.body.grams);
  if (!gramsOk(grams)) return fail(res, 400, 'Hoeveelheid moet tussen 1 en 5000 gram liggen.');
  const meal = req.body.meal === undefined ? null : req.body.meal;
  if (meal !== null && !food.MEALS.includes(meal)) return fail(res, 400, 'Ongeldige maaltijd.');
  const r = db.prepare('UPDATE log SET grams = ?, meal = COALESCE(?, meal) WHERE id = ? AND user_id = ?').run(grams, meal, Number(req.params.id), req.user.id);
  if (!r.changes) return fail(res, 404, 'Niet gevonden.');
  res.json({ ok: true });
});

app.delete('/api/log/:id', requireAuth, (req, res) => {
  const r = db.prepare('DELETE FROM log WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!r.changes) return fail(res, 404, 'Niet gevonden.');
  res.json({ ok: true });
});

// Kopieer een maaltijd (of de hele dag) van een andere dag, bijvoorbeeld "zelfde als gisteren"
app.post('/api/log/copy', requireAuth, (req, res) => {
  const { fromDate, toDate, meal } = req.body || {};
  if (!validDay(fromDate) || !validDay(toDate) || fromDate === toDate) return fail(res, 400, 'Ongeldige datums.');
  if (meal !== undefined && !food.MEALS.includes(meal)) return fail(res, 400, 'Ongeldige maaltijd.');
  const rows = meal
    ? db.prepare('SELECT * FROM log WHERE user_id = ? AND date = ? AND meal = ? ORDER BY id').all(req.user.id, fromDate, meal)
    : db.prepare('SELECT * FROM log WHERE user_id = ? AND date = ? ORDER BY id').all(req.user.id, fromDate);
  const existing = db.prepare('SELECT COUNT(*) c FROM log WHERE user_id = ? AND date = ?').get(req.user.id, toDate).c;
  if (existing + rows.length > MAX_LOG_PER_DAY) return fail(res, 400, 'Te veel regels voor één dag.');
  const ins = db.prepare('INSERT INTO log (user_id, date, meal, food_id, name, grams, kcal100, protein100, carbs100, fat100) VALUES (?,?,?,?,?,?,?,?,?,?)');
  db.transaction(() => rows.forEach((r) => ins.run(req.user.id, toDate, r.meal, r.food_id, r.name, r.grams, r.kcal100, r.protein100, r.carbs100, r.fat100)))();
  res.json({ ok: true, copied: rows.length });
});

// ---------- v0.3: sport tracker ----------
const INTENSITIES = ['light', 'moderate', 'hard'];
const workoutOut = (w) => ({
  id: w.id,
  date: w.date,
  type: w.type,
  durationMin: w.duration_min,
  intensity: w.intensity,
  notes: w.notes,
  kcalBurned: w.kcal_burned,
});

app.get('/api/workouts', requireAuth, (req, res) => {
  const date = req.query.date || todayNL();
  if (!isDate(date)) return fail(res, 400, 'Ongeldige datum.');
  const rows = db.prepare('SELECT * FROM workouts WHERE user_id = ? AND date = ? ORDER BY id').all(req.user.id, date);
  res.json({ workouts: rows.map(workoutOut) });
});

// Recente workouts (laatste N dagen, voor historieoverzicht)
app.get('/api/workouts/recent', requireAuth, (req, res) => {
  const days = Math.min(Math.max(1, Number(req.query.days) || 30), 90);
  const since = new Date(todayNL() + 'T00:00:00Z');
  since.setUTCDate(since.getUTCDate() - days + 1);
  const sinceStr = since.toISOString().slice(0, 10);
  const rows = db.prepare('SELECT * FROM workouts WHERE user_id = ? AND date >= ? ORDER BY date DESC, id DESC').all(req.user.id, sinceStr);
  res.json({ workouts: rows.map(workoutOut) });
});

app.post('/api/workouts', requireAuth, (req, res) => {
  const b = req.body || {};
  const date = isDate(b.date) ? b.date : todayNL();
  if (Date.parse(date + 'T00:00:00Z') > new Date(todayNL() + 'T00:00:00Z').getTime() + 86400000) return fail(res, 400, 'Datum ligt in de toekomst.');
  const type = String(b.type || '').trim().slice(0, 60);
  if (!type) return fail(res, 400, 'Geef een type sport op.');
  const durationMin = b.durationMin !== undefined ? num(b.durationMin) : null;
  if (durationMin !== null && !(durationMin >= 1 && durationMin <= 600)) return fail(res, 400, 'Duur moet tussen 1 en 600 minuten liggen.');
  const intensity = b.intensity || null;
  if (intensity !== null && !INTENSITIES.includes(intensity)) return fail(res, 400, 'Ongeldige intensiteit.');
  const notes = b.notes ? String(b.notes).trim().slice(0, 200) : null;
  const kcalBurned = b.kcalBurned !== undefined ? num(b.kcalBurned) : null;
  if (kcalBurned !== null && !(kcalBurned >= 0 && kcalBurned <= 5000)) return fail(res, 400, 'Verbrande calorieën moet tussen 0 en 5000 liggen.');

  const r = db
    .prepare('INSERT INTO workouts (user_id, date, type, duration_min, intensity, notes, kcal_burned) VALUES (?,?,?,?,?,?,?)')
    .run(req.user.id, date, type, durationMin, intensity, notes, kcalBurned);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});

app.delete('/api/workouts/:id', requireAuth, (req, res) => {
  const r = db.prepare('DELETE FROM workouts WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!r.changes) return fail(res, 404, 'Niet gevonden.');
  res.json({ ok: true });
});

// ---------- v0.3: voedingsschema ----------
const MEAL_LABELS = { breakfast: 'Ontbijt', lunch: 'Lunch', dinner: 'Diner', snack: 'Tussendoor' };
const planEntryOut = (e) => ({
  id: e.id,
  weekStart: e.week_start,
  day: e.day,
  meal: e.meal,
  dish: e.dish,
  notes: e.notes,
});

app.get('/api/meal-plan', requireAuth, (req, res) => {
  // week=YYYY-MM-DD (een datum in de gewenste week) of niets voor de huidige week
  const ref = isDate(req.query.week) ? req.query.week : todayNL();
  const ws = weekStart(ref);
  const rows = db.prepare('SELECT * FROM meal_plans WHERE household_id = ? AND week_start = ? ORDER BY day, meal').all(req.user.household_id, ws);
  res.json({ weekStart: ws, entries: rows.map(planEntryOut) });
});

app.put('/api/meal-plan', requireAuth, (req, res) => {
  const b = req.body || {};
  const ref = isDate(b.week) ? b.week : todayNL();
  const ws = weekStart(ref);
  const day = Number(b.day);
  if (!Number.isInteger(day) || day < 0 || day > 6) return fail(res, 400, 'Dag moet 0 (ma) t/m 6 (zo) zijn.');
  const meal = b.meal;
  if (!food.MEALS.includes(meal)) return fail(res, 400, 'Ongeldige maaltijd.');
  const dish = String(b.dish || '').trim().slice(0, 100);
  if (!dish) return fail(res, 400, 'Geef een gerecht op.');
  const notes = b.notes ? String(b.notes).trim().slice(0, 200) : null;

  db.prepare(
    `INSERT INTO meal_plans (household_id, week_start, day, meal, dish, notes)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(household_id, week_start, day, meal) DO UPDATE SET dish=excluded.dish, notes=excluded.notes`
  ).run(req.user.household_id, ws, day, meal, dish, notes);
  res.json({ ok: true });
});

app.delete('/api/meal-plan/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM meal_plans WHERE id = ? AND household_id = ?').get(Number(req.params.id), req.user.household_id);
  if (!row) return fail(res, 404, 'Niet gevonden.');
  db.prepare('DELETE FROM meal_plans WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// Kopieer schema van vorige week naar de huidige week
app.post('/api/meal-plan/copy', requireAuth, (req, res) => {
  const b = req.body || {};
  const toRef = isDate(b.toWeek) ? b.toWeek : todayNL();
  const toWs = weekStart(toRef);
  // Vorige week = 7 dagen terug
  const prevDate = new Date(toWs + 'T00:00:00Z');
  prevDate.setUTCDate(prevDate.getUTCDate() - 7);
  const fromWs = prevDate.toISOString().slice(0, 10);

  const rows = db.prepare('SELECT * FROM meal_plans WHERE household_id = ? AND week_start = ?').all(req.user.household_id, fromWs);
  if (!rows.length) return res.json({ ok: true, copied: 0 });

  const ins = db.prepare(
    `INSERT OR IGNORE INTO meal_plans (household_id, week_start, day, meal, dish, notes)
     VALUES (?,?,?,?,?,?)`
  );
  db.transaction(() => rows.forEach((r) => ins.run(req.user.household_id, toWs, r.day, r.meal, r.dish, r.notes)))();
  res.json({ ok: true, copied: rows.length });
});

// ---------- statics ----------
app.use('/api', (req, res) => fail(res, 404, 'Niet gevonden.'));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, index: 'index.html' }));

// Foutafhandeling: nooit stacktraces naar de client
app.use((err, req, res, _next) => {
  console.error(err);
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'Ongeldige invoer.');
  fail(res, 500, 'Er ging iets mis.');
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';

  function onListening(proto, h, p) {
    console.log(`Health app op ${proto}://${h}:${p}`);
    if (db.prepare('SELECT COUNT(*) c FROM households').get().c === 0) {
      console.log(`Eerste registratie: setup-sleutel = ${SETUP_KEY}`);
    }
  }

  let server;
  const certFile = process.env.HTTPS_CERT;
  const keyFile  = process.env.HTTPS_KEY;
  if (certFile && keyFile && fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    const https = require('https');
    const creds = { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
    server = https.createServer(creds, app).listen(port, host, () => onListening('https', host, port));
    // HTTP → HTTPS redirect op poort 80
    const http = require('http');
    http.createServer((req, res) => {
      const loc = `https://${req.headers.host.replace(/:\d+$/, '')}${port !== 443 ? ':' + port : ''}${req.url}`;
      res.writeHead(301, { Location: loc });
      res.end();
    }).listen(80, host, () => console.log('HTTP → HTTPS redirect actief op :80'));
  } else {
    server = app.listen(port, host, () => onListening('http', host, port));
  }

  // Graceful shutdown: stop nieuwe verbindingen, checkpoint WAL, sluit db.
  // Zo gaat er nooit data verloren bij server-herstart of Ctrl+C.
  function gracefulShutdown(signal) {
    console.log(`\n[${signal}] server afsluiten...`);
    server.close(() => {
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.close();
        console.log('Database veilig afgesloten.');
      } catch (e) {
        console.error('Fout bij afsluiten database:', e.message);
      }
      process.exit(0);
    });
    // Forceer afsluiten na 5 seconden als verbindingen niet sluiten
    setTimeout(() => {
      console.error('Geforceerd afsluiten na timeout.');
      try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch (_) {}
      process.exit(1);
    }, 5000).unref();
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
}

module.exports = { app, SETUP_KEY };
