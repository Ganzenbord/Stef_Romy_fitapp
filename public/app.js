'use strict';
// Fit: persoonlijke gezondheidsapp voor twee personen. Alle UI wordt met DOM-calls opgebouwd (geen innerHTML met gebruikersdata).

const root = document.getElementById('app');
const state = {
  summary: null, tab: 'progress', authMode: 'login', photos: [], editProfile: false, viewer: null,
  pday: { st: 'idle', d: null },
  food: { date: null, day: null, dayState: 'idle', add: null, msg: '' },
  sport: { date: null, workouts: null, state: 'idle', adding: false, recent: null, recentState: 'idle' },
  schema: { week: null, entries: null, state: 'idle', editing: null },
};

// ---------- helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const svg = (tag, attrs) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
};
const fmt = (n, d = 1) => (n === null || n === undefined ? '–' : n.toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d }));
const parseNum = (s) => {
  const t = String(s || '').trim().replace(',', '.');
  return t === '' ? null : Number(t);
};
const dateNL = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
const addDaysToIso = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

// Berekent de maandag van de week voor een datum
function isoWeekStart(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

const DAY_LABELS = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];
const DAY_LABELS_FULL = ['Maandag', 'Dinsdag', 'Woensdag', 'Donderdag', 'Vrijdag', 'Zaterdag', 'Zondag'];

async function api(method, url, body, isForm) {
  const opts = { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'health-app' } };
  if (body && !isForm) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body) opts.body = body;
  const res = await fetch(url, opts);
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (res.status === 401 && url !== '/api/login') {
    state.summary = null;
    render();
  }
  if (!res.ok) throw new Error(data.error || 'Er ging iets mis.');
  return data;
}

async function load() {
  try {
    state.summary = await api('GET', '/api/summary');
  } catch (_) {
    state.summary = null;
  }
  render();
}

function errBox() {
  return h('div', { class: 'error', role: 'alert' });
}
const showErr = (box, e) => { box.textContent = e.message || String(e); };

function field(label, input) {
  return h('div', {}, h('label', {}, label), input);
}

// ---------- auth ----------
function renderAuth() {
  const mode = state.authMode;
  const err = errBox();
  const name = h('input', { type: 'text', autocomplete: 'name', maxlength: '40' });
  const email = h('input', { type: 'email', autocomplete: 'email', inputmode: 'email', required: true });
  const pw = h('input', { type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', required: true });
  const key = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off' });
  const btn = h('button', { type: 'submit' }, mode === 'login' ? 'Inloggen' : 'Account maken');

  const form = h(
    'form',
    {
      class: 'card',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        btn.disabled = true;
        try {
          if (mode === 'login') await api('POST', '/api/login', { email: email.value, password: pw.value });
          else
            await api('POST', '/api/register', {
              name: name.value, email: email.value, password: pw.value,
              setupKey: mode === 'setup' ? key.value : undefined,
              inviteCode: mode === 'join' ? key.value : undefined,
            });
          await load();
        } catch (e2) {
          showErr(err, e2);
        } finally {
          btn.disabled = false;
        }
      },
    },
    mode !== 'login' && field('Naam', name),
    field('E-mail', email),
    field(mode === 'login' ? 'Wachtwoord' : 'Wachtwoord (minimaal 10 tekens)', pw),
    mode === 'setup' && field('Setup-sleutel (staat in de serverlog)', key),
    mode === 'join' && field('Uitnodigingscode (van je partner)', key),
    btn,
    err
  );

  const link = (label, m) => h('button', { type: 'button', class: 'ghost', onclick: () => { state.authMode = m; render(); } }, label);
  root.replaceChildren(
    h('div', { class: 'auth' },
      h('h1', {}, 'Fit'),
      h('p', { class: 'sub' }, 'Jullie voeding, training en voortgang op één plek.'),
      form,
      mode !== 'login' && link('Ik heb al een account', 'login'),
      mode === 'login' && link('Eerste keer? Maak het huishouden aan', 'setup'),
      mode === 'login' && link('Mijn partner heeft me uitgenodigd', 'join'))
  );
}

// ---------- profiel ----------
const ACTIVITY_LABELS = {
  sedentary: 'Zittend werk, nauwelijks sport',
  light: 'Zittend werk + 1 tot 4 korte sessies per week',
  moderate: 'Zittend werk + 4 tot 5 stevige sessies per week',
};
const RATE_LABELS = [
  ['0.25', 'Rustig (0,25% per week)'],
  ['0.5', 'Standaard (0,5% per week), aanbevolen'],
  ['0.75', 'Stevig (0,75% per week)'],
  ['1', 'Maximaal (1,0% per week)'],
];

function renderProfileForm(onboarding) {
  const p = state.summary.profile || {};
  const err = errBox();
  const sex = h('select', {}, [['male', 'Man'], ['female', 'Vrouw']].map(([v, l]) => h('option', { value: v, selected: p.sex === v }, l)));
  const birth = h('input', { type: 'date', value: p.birthDate || '', required: true });
  const height = h('input', { type: 'text', inputmode: 'decimal', value: p.heightCm ?? '', placeholder: 'cm', required: true });
  const weight = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'kg', required: onboarding });
  const goal = h('input', { type: 'text', inputmode: 'decimal', value: p.goalKg ?? '', placeholder: 'kg', required: true });
  const act = h('select', {}, Object.entries(ACTIVITY_LABELS).map(([v, l]) => h('option', { value: v, selected: (p.activity || 'light') === v }, l)));
  const rate = h('select', {}, RATE_LABELS.map(([v, l]) => h('option', { value: v, selected: String(p.ratePct ?? 0.5) === v }, l)));
  const avoid = h('input', { type: 'text', value: p.avoid || '', maxlength: '200', placeholder: 'bijv. lever, spruitjes' });
  const btn = h('button', { type: 'submit' }, 'Opslaan');

  const form = h('form', {
    class: 'card',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      btn.disabled = true;
      try {
        await api('PUT', '/api/profile', {
          sex: sex.value, birthDate: birth.value, heightCm: parseNum(height.value), goalKg: parseNum(goal.value),
          activity: act.value, ratePct: Number(rate.value), avoid: avoid.value,
        });
        const w = parseNum(weight.value);
        if (onboarding && w !== null) await api('PUT', '/api/entries/' + state.summary.today, { weightKg: w });
        state.editProfile = false;
        await load();
      } catch (e2) {
        showErr(err, e2);
      } finally {
        btn.disabled = false;
      }
    },
  },
    field('Geslacht (voor de calorieformule)', sex),
    field('Geboortedatum', birth),
    h('div', { class: 'row' }, field('Lengte (cm)', height), onboarding ? field('Gewicht nu (kg)', weight) : null, field('Streef (kg)', goal)),
    field('Activiteit', act),
    field('Tempo', rate),
    field('Niet eten (optioneel, met kommas)', avoid),
    h('p', { class: 'hint' }, 'Wat je niet eet gebruik ik bij weekmenus. De app weigert streefgewichten met een BMI onder 18,5 en eet-doelen onder je BMR. Dat is bewust.'),
    btn,
    !onboarding && h('button', { type: 'button', class: 'ghost', onclick: () => { state.editProfile = false; render(); } }, 'Annuleren'),
    err);

  root.replaceChildren(h('div', { class: 'auth' }, h('h1', {}, onboarding ? 'Jouw doel' : 'Profiel aanpassen'),
    h('p', { class: 'sub' }, onboarding ? `Hoi ${state.summary.user.name}. Hiermee reken ik je dagdoel uit.` : ''), form));
}

// ---------- tabs ----------
function renderApp() {
  const s = state.summary;
  if (!s.profile) return renderProfileForm(true);
  if (state.editProfile) return renderProfileForm(false);

  const tabs = [['progress', 'Voortgang'], ['food', 'Eten'], ['sport', 'Sport'], ['schema', 'Schema'], ['plan', 'Plan']];
  let body;
  if (state.food.add) {
    body = addView();
  } else {
    const tabFns = { progress: tabProgress, food: tabFood, sport: tabSport, schema: tabSchema, plan: tabPlan };
    body = (tabFns[state.tab] || tabProgress)();
  }
  root.replaceChildren(
    body,
    h('nav', { class: 'tabs', 'aria-label': 'Hoofdmenu' },
      tabs.map(([k, l]) => h('button', { type: 'button', 'aria-current': state.tab === k && !state.food.add ? 'page' : null,
        onclick: () => { state.tab = k; state.food.add = null; render(); } }, l)))
  );
  if (state.viewer) root.append(viewer());
}

function measureCard() {
  const s = state.summary;
  const todayEntry = s.entries.find((e) => e.date === s.today) || {};
  const err = errBox();
  const w = h('input', { type: 'text', inputmode: 'decimal', value: todayEntry.weightKg ?? '', placeholder: 'kg', 'aria-label': 'Gewicht in kg' });
  const t = h('input', { type: 'text', inputmode: 'decimal', value: todayEntry.waistCm ?? '', placeholder: 'cm', 'aria-label': 'Taille in cm' });
  const btn = h('button', { type: 'submit' }, 'Opslaan');
  return h('form', {
    class: 'card',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      btn.disabled = true;
      try {
        await api('PUT', '/api/entries/' + s.today, { weightKg: parseNum(w.value), waistCm: parseNum(t.value) });
        await load();
      } catch (e2) {
        showErr(err, e2);
        btn.disabled = false;
      }
    },
  },
    h('h2', {}, 'Meting van ' + dateNL(s.today)),
    h('div', { class: 'row' }, field('Gewicht (kg)', w), field('Taille (cm)', t)),
    btn,
    h('p', { class: 'hint' }, 'Weeg elke ochtend na het toilet, voor het eten. Eén dag zegt niets; het 7-daags gemiddelde telt. Taille: 1x per week, op dezelfde plek (navelhoogte).'),
    err);
}

function recentCard() {
  const s = state.summary;
  const recent = [...s.entries].reverse().slice(0, 7);
  if (!recent.length) return null;
  return h('div', { class: 'card' }, h('h3', {}, 'Laatste metingen'),
    h('ul', { class: 'list' }, recent.map((e) => h('li', {},
      h('div', {}, h('strong', {}, dateNL(e.date)), h('div', { class: 'meta' }, [e.weightKg !== null ? fmt(e.weightKg) + ' kg' : null, e.waistCm !== null ? 'taille ' + fmt(e.waistCm) + ' cm' : null].filter(Boolean).join(' · '))),
      h('button', { type: 'button', class: 'danger small', 'aria-label': 'Verwijder ' + e.date, onclick: async () => { if (confirm('Meting van ' + dateNL(e.date) + ' verwijderen?')) { try { await api('DELETE', '/api/entries/' + e.date); } catch (_) {} await load(); } } }, 'Wis')))));
}

async function loadPday() {
  const p = state.pday;
  p.st = 'loading';
  try {
    p.d = await api('GET', '/api/day?date=' + state.summary.today);
    p.st = 'ok';
  } catch (_) {
    p.st = 'error';
  }
  render();
}

function foodTodayCard() {
  const s = state.summary;
  const p = state.pday;
  if (p.st === 'idle') loadPday();
  if (p.st !== 'ok') {
    return h('div', { class: 'card' }, h('h3', {}, 'Eten vandaag'),
      p.st === 'error' ? h('button', { type: 'button', class: 'ghost', onclick: () => { p.st = 'idle'; render(); } }, 'Opnieuw proberen') : h('p', { class: 'meta' }, 'Laden…'));
  }
  const t = p.d.totals;
  const tg = p.d.target;
  const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': tg ? Math.min(100, Math.round((t.kcal / tg.kcal) * 100)) : 0 }, h('div', {}));
  bar.firstChild.style.width = (tg ? Math.min(100, (t.kcal / tg.kcal) * 100) : 0) + '%';
  const add = (key) => () => { state.food.date = s.today; state.food.dayState = 'idle'; openPick(key, 'progress'); };
  return h('div', { class: 'card' }, h('h3', {}, 'Eten vandaag'),
    h('div', { class: 'big' }, fmt(t.kcal, 0), h('small', {}, tg ? ` van ${fmt(tg.kcal, 0)} kcal` : ' kcal')),
    tg && bar,
    h('p', { class: 'hint' }, tg ? (t.kcal <= tg.kcal ? `Nog ${fmt(tg.kcal - t.kcal, 0)} kcal over.` : `${fmt(t.kcal - tg.kcal, 0)} kcal boven je dagdoel.`) : 'Vul je gewicht in voor een dagdoel.'),
    h('div', { class: 'stats' },
      stat(fmt(t.protein, 0) + (tg ? ` / ${tg.protein}` : '') + ' g', 'Eiwit'),
      stat(fmt(t.carbs, 0) + (tg ? ` / ${tg.carbs}` : '') + ' g', 'Koolhydraten'),
      stat(fmt(t.fat, 0) + (tg ? ` / ${tg.fat}` : '') + ' g', 'Vet')),
    h('div', { class: 'quick' }, MEALS.map(([key, label]) => h('button', { type: 'button', class: 'ghost small', onclick: add(key) }, '+ ' + label))),
    h('button', { type: 'button', class: 'ghost', onclick: () => { state.tab = 'food'; state.food.date = s.today; state.food.dayState = 'idle'; render(); } }, 'Dagoverzicht en gisteren kopiëren'));
}

function chart(entries, goalKg) {
  const pts = entries.filter((e) => e.weightKg !== null).slice(-90);
  const W = 340, H = 190, L = 34, R = 8, T = 10, B = 22;
  const el = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Gewichtsverloop met 7-daags gemiddelde en streefgewicht' });
  if (!pts.length) return el;
  const t = (d) => Date.parse(d + 'T00:00:00Z');
  const t0 = t(pts[0].date);
  const t1 = Math.max(t(pts[pts.length - 1].date), t0 + 7 * 86400000);
  const vals = pts.flatMap((p) => [p.weightKg, p.avgKg]).concat(goalKg);
  let lo = Math.floor(Math.min(...vals) - 1), hi = Math.ceil(Math.max(...vals) + 1);
  if (hi - lo < 4) { hi += 2; lo -= 2; }
  const x = (d) => L + ((t(d) - t0) / (t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const step = Math.max(1, Math.round((hi - lo) / 4));
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    el.append(svg('line', { class: 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    const lab = svg('text', { class: 'axis', x: L - 5, y: y(v) + 3, 'text-anchor': 'end' });
    lab.textContent = v;
    el.append(lab);
  }
  el.append(svg('line', { class: 'goal', x1: L, x2: W - R, y1: y(goalKg), y2: y(goalKg) }));
  pts.forEach((p) => el.append(svg('circle', { class: 'dot', cx: x(p.date), cy: y(p.weightKg), r: 3 })));
  if (pts.length > 1) el.append(svg('polyline', { class: 'avg', points: pts.map((p) => `${x(p.date).toFixed(1)},${y(p.avgKg).toFixed(1)}`).join(' ') }));
  [pts[0], pts[pts.length - 1]].forEach((p, i) => {
    const lab = svg('text', { class: 'axis', x: x(p.date), y: H - 6, 'text-anchor': i === 0 ? 'start' : 'end' });
    lab.textContent = new Date(p.date + 'T00:00:00').toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
    el.append(lab);
  });
  return el;
}

function tabProgress() {
  const s = state.summary;
  const pr = s.progress;
  const head = [h('h1', {}, 'Voortgang'), measureCard()];
  if (!pr) {
    return h('div', {}, head, h('div', { class: 'card' }, h('p', {}, 'Vul hierboven je gewicht in, dan verschijnen je voortgang en dagdoel.')), foodTodayCard(), photosCard());
  }
  const total = pr.startKg - s.profile.goalKg;
  const frac = total > 0 ? Math.min(1, Math.max(0, (pr.startKg - pr.currentAvgKg) / total)) : 0;
  const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(frac * 100) }, h('div', {}));
  bar.firstChild.style.width = Math.round(frac * 100) + '%';
  const planned = s.plan && s.plan.ok && s.plan.mode === 'lose' ? -s.plan.kgPerWeek : null;

  const waists = s.entries.filter((e) => e.waistCm !== null);
  const waistCard = waists.length
    ? h('div', { class: 'card' }, h('h3', {}, 'Taille'),
        h('div', { class: 'stats' },
          h('div', { class: 'stat' }, h('div', { class: 'v' }, fmt(waists[waists.length - 1].waistCm) + ' cm'), h('div', { class: 'l' }, 'Laatste meting')),
          h('div', { class: 'stat' }, h('div', { class: 'v' }, (waists.length > 1 ? (waists[waists.length - 1].waistCm - waists[0].waistCm > 0 ? '+' : '') + fmt(waists[waists.length - 1].waistCm - waists[0].waistCm) : '–') + ' cm'), h('div', { class: 'l' }, 'Sinds eerste meting'))))
    : null;

  return h('div', {}, head,
    pr.note && h('div', { class: 'notice', role: 'status' }, pr.note),
    h('div', { class: 'card' },
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('div', { class: 'v' }, fmt(pr.startKg)), h('div', { class: 'l' }, 'Start (kg)')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, fmt(pr.currentAvgKg)), h('div', { class: 'l' }, 'Nu, 7-daags gemiddelde')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, (pr.changeKg > 0 ? '+' : '') + fmt(pr.changeKg)), h('div', { class: 'l' }, 'Verandering (kg)')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, fmt(Math.max(0, pr.remainingKg))), h('div', { class: 'l' }, `Tot ${fmt(s.profile.goalKg)} kg`))),
      bar,
      h('p', { class: 'hint' }, pr.actualKgPerWeek === null
        ? 'Het werkelijke tempo verschijnt na ongeveer een week metingen.'
        : `Werkelijk tempo (laatste 2 weken): ${fmt(pr.actualKgPerWeek, 2)} kg/week` + (planned !== null ? ` · plan: ${fmt(planned, 2)} kg/week` : ''))),
    foodTodayCard(),
    h('div', { class: 'card' }, h('h3', {}, 'Gewicht'), chart(s.entries, s.profile.goalKg),
      h('div', { class: 'legend' }, h('span', {}, h('i', { class: 'a' }), '7-daags gemiddelde'), h('span', {}, h('i', { class: 'w' }), 'Dagwaarde'), h('span', {}, h('i', { class: 'g' }), 'Streef'))),
    waistCard,
    photosCard(),
    recentCard());
}

// ---------- foto's ----------
async function resizeToJpeg(file, max = 1600) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.85));
  } catch (_) {
    return file;
  }
}

function photosCard() {
  const err = errBox();
  const input = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: async () => {
    const f = input.files[0];
    if (!f) return;
    err.textContent = '';
    try {
      const blob = await resizeToJpeg(f);
      const fd = new FormData();
      fd.append('date', state.summary.today);
      fd.append('photo', blob, 'foto.jpg');
      await api('POST', '/api/photos', fd, true);
      await loadPhotos();
    } catch (e) { showErr(err, e); }
  } });
  const grid = h('div', { class: 'photos' }, state.photos.map((p) => h('figure', {},
    h('img', { src: '/api/photos/' + p.id, alt: 'Foto van ' + p.date, loading: 'lazy', onclick: () => { state.viewer = p; render(); } }),
    h('figcaption', {}, dateNL(p.date)))));
  if (!state.photosLoaded) loadPhotos();
  return h('div', { class: 'card' }, h('h3', {}, "Foto's"),
    h('p', { class: 'hint' }, "Alleen jij ziet je foto's. Maak ze steeds in hetzelfde licht, dezelfde houding en op dezelfde afstand, bijvoorbeeld elke 2 weken."),
    state.photos.length ? grid : h('p', { class: 'meta' }, "Nog geen foto's."),
    h('button', { type: 'button', class: 'ghost', onclick: () => input.click() }, 'Foto toevoegen'), input, err);
}

async function loadPhotos() {
  state.photosLoaded = true;
  try {
    state.photos = (await api('GET', '/api/photos')).photos;
  } catch (_) {}
  render();
}

function viewer() {
  const p = state.viewer;
  return h('div', { class: 'viewer', role: 'dialog', 'aria-label': 'Foto' },
    h('img', { src: '/api/photos/' + p.id, alt: 'Foto van ' + p.date }),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'ghost', onclick: () => { state.viewer = null; render(); } }, 'Sluiten'),
      h('button', { type: 'button', class: 'danger', onclick: async () => {
        if (!confirm('Deze foto definitief verwijderen?')) return;
        await api('DELETE', '/api/photos/' + p.id);
        state.viewer = null;
        await loadPhotos();
      } }, 'Verwijderen')));
}

// ---------- plan ----------
function tabPlan() {
  const s = state.summary;
  const pl = s.plan;
  let planCard;
  if (!pl) planCard = h('div', { class: 'card' }, h('p', {}, 'Voer eerst je gewicht in bij Voortgang, dan reken ik je dagdoel uit.'));
  else if (!pl.ok) planCard = h('div', { class: 'card' }, h('div', { class: 'notice' }, pl.errors.join(' ')));
  else
    planCard = h('div', { class: 'card' },
      h('h3', {}, pl.mode === 'lose' ? 'Dagdoel om af te vallen' : 'Dagdoel om je gewicht te houden'),
      h('div', { class: 'big' }, fmt(pl.targetKcal, 0), h('small', {}, ' kcal')),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('div', { class: 'v' }, pl.proteinG + ' g'), h('div', { class: 'l' }, 'Eiwit')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, pl.carbsG + ' g'), h('div', { class: 'l' }, 'Koolhydraten')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, pl.fatG + ' g'), h('div', { class: 'l' }, 'Vet')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, pl.mode === 'lose' ? '~' + pl.weeks + ' wkn' : '–'), h('div', { class: 'l' }, pl.mode === 'lose' ? `${fmt(pl.kgPerWeek, 2)} kg/week` : 'Onderhoud'))),
      pl.warnings.map((w) => h('div', { class: 'notice' }, w)),
      h('p', { class: 'hint' }, `Onderhoud ≈ ${fmt(pl.maintenanceKcal, 0)} kcal · BMR ≈ ${fmt(pl.bmr, 0)} kcal · BMI ${fmt(pl.bmi)} → ${fmt(pl.goalBmi)}. Dit zijn schattingen (Mifflin-St Jeor); je lichaam wijkt af. Stuur bij op het 7-daags gemiddelde, niet op één dag. Niet bedoeld als medisch advies.`));

  const hh = s.household;
  const logout = h('button', { type: 'button', class: 'ghost', onclick: async () => {
    await api('POST', '/api/logout');
    state.summary = null; state.photosLoaded = false; state.photos = []; state.tab = 'progress';
    state.pday = { st: 'idle', d: null };
    state.food = { date: null, day: null, dayState: 'idle', add: null, msg: '' };
    state.sport = { date: null, workouts: null, state: 'idle', adding: false, recent: null, recentState: 'idle' };
    state.schema = { week: null, entries: null, state: 'idle', editing: null };
    render();
  } }, 'Uitloggen');

  return h('div', {}, h('h1', {}, 'Plan'), planCard,
    h('div', { class: 'card' }, h('h3', {}, 'Profiel'),
      h('p', {}, `${fmt(s.profile.heightCm, 0)} cm · streef ${fmt(s.profile.goalKg)} kg · ${ACTIVITY_LABELS[s.profile.activity]}`),
      s.profile.avoid && h('p', { class: 'meta' }, 'Niet eten: ' + s.profile.avoid),
      h('button', { type: 'button', class: 'ghost', onclick: () => { state.editProfile = true; render(); } }, 'Profiel aanpassen')),
    h('div', { class: 'card' }, h('h3', {}, 'Account'),
      h('p', {}, h('strong', {}, s.user.name), h('br', {}), h('span', { class: 'meta' }, s.user.email))),
    h('div', { class: 'card' }, h('h3', {}, 'Huishouden'),
      h('p', {}, hh.members.join(' & ')),
      h('p', { class: 'hint' }, 'Uitnodigingscode', hh.members.length < 2 ? ' (deel met je partner)' : '', ': ',
        h('strong', {}, hh.inviteCode),
        h('button', {
          type: 'button', class: 'ghost', style: 'margin-left:8px;padding:2px 10px;font-size:0.85em;',
          onclick: () => { try { navigator.clipboard.writeText(hh.inviteCode); } catch (_) {} }
        }, 'Kopieer'))),
    logout);
}

// ---------- barcode scanner ----------
function openBarcodeScanner(onResult) {
  // ZXing (geladen via CDN in index.html) werkt op alle browsers incl. iOS Safari.
  // Foto-fallback via <input capture> werkt ook over HTTP — geen getUserMedia nodig.

  function decodeFromImage(file, status, overlay, retry) {
    status.textContent = 'Barcode herkennen…';
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = async () => {
      try {
        const reader = new ZXingBrowser.BrowserMultiFormatReader();
        const result = await reader.decodeFromImageUrl(url);
        URL.revokeObjectURL(url);
        overlay.remove();
        onResult(result.getText());
      } catch (_) {
        URL.revokeObjectURL(url);
        status.textContent = 'Geen barcode gevonden. Probeer opnieuw (houd de camera stil en zorg voor goed licht).';
        retry();
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); status.textContent = 'Fout bij laden afbeelding.'; retry(); };
    img.src = url;
  }

  function startPhotoMode(overlay, status) {
    status.textContent = 'Tik op de knop om een foto te maken van de barcode';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.style.display = 'none';
    overlay.appendChild(input);

    const shootBtn = h('button', { type: 'button', style: 'background:var(--accent);color:var(--accent-ink);border:none;border-radius:12px;padding:12px 24px;font-size:1em;', onclick: () => { input.value = ''; input.click(); } }, '📷 Foto maken');
    overlay.appendChild(shootBtn);

    const retry = () => shootBtn.style.display = '';
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      shootBtn.style.display = 'none';
      decodeFromImage(file, status, overlay, retry);
    });
  }

  const status = h('p', { class: 'scanner-status' }, 'Camera starten…');
  const video = h('video', { autoplay: true, muted: true, playsinline: true });
  let codeReader = null;
  let liveActive = false;

  const closeBtn = h('button', { type: 'button', class: 'ghost', style: 'color:#fff;border-color:rgba(255,255,255,0.3);', onclick: () => {
    if (codeReader && liveActive) try { codeReader.reset(); } catch (_) {}
    overlay.remove();
  } }, 'Annuleren');

  const wrap = h('div', { class: 'scanner-wrap' }, video, h('div', { class: 'scanner-frame' }));
  const overlay = h('div', { class: 'scanner-overlay' }, wrap, status, closeBtn);
  document.body.appendChild(overlay);

  (async () => {
    // Probeer live video via ZXing (vereist HTTPS of localhost)
    if (typeof ZXingBrowser === 'undefined') {
      wrap.style.display = 'none';
      status.textContent = 'Scanner laadt nog. Probeer het opnieuw.';
      return;
    }
    try {
      const devices = await ZXingBrowser.BrowserCodeReader.listVideoInputDevices();
      if (!devices.length) throw new Error('no camera');
      // Kies achtercamera
      const back = devices.find((d) => /back|rear|environment/i.test(d.label)) || devices[devices.length - 1];
      codeReader = new ZXingBrowser.BrowserMultiFormatReader();
      liveActive = true;
      status.textContent = 'Richt op een barcode…';
      codeReader.decodeFromVideoDevice(back.deviceId, video, (result, err) => {
        if (result) {
          liveActive = false;
          try { codeReader.reset(); } catch (_) {}
          overlay.remove();
          onResult(result.getText());
        }
      });
    } catch (_) {
      // Live mislukt (HTTP / geen toestemming / geen camera) → foto-modus
      wrap.style.display = 'none';
      startPhotoMode(overlay, status);
    }
  })();
}

// ---------- eten ----------
const MEALS = [['breakfast', 'Ontbijt'], ['lunch', 'Lunch'], ['dinner', 'Diner'], ['snack', 'Tussendoor']];
const MEAL_MAP = Object.fromEntries(MEALS);
const addDays = (iso, n) => addDaysToIso(iso, n);
const scaleP = (p, g) => ({
  kcal: Math.round((p.kcal * g) / 100),
  protein: Math.round((p.protein * g) / 10) / 10,
  carbs: Math.round((p.carbs * g) / 10) / 10,
  fat: Math.round((p.fat * g) / 10) / 10,
});
const stat = (v, l) => h('div', { class: 'stat' }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));
const foodName = (f) => (f.brand ? `${f.name} (${f.brand})` : f.name);

async function loadDay() {
  const f = state.food;
  const date = f.date;
  try {
    const d = await api('GET', '/api/day?date=' + date);
    if (f.date === date) {
      f.day = d;
      f.dayState = 'ok';
    }
  } catch (e) {
    f.dayState = 'error';
    f.msg = e.message;
  }
  render();
}
const reloadDay = () => { state.food.dayState = 'idle'; state.pday.st = 'idle'; render(); };
const shiftDay = (n) => {
  const f = state.food;
  f.date = addDays(f.date, n);
  f.day = null;
  f.dayState = 'idle';
  f.msg = '';
  render();
};

function tabFood() {
  const s = state.summary;
  const f = state.food;
  if (!f.date) f.date = s.today;
  if (f.add) return addView();
  if (f.dayState === 'idle') {
    f.dayState = 'loading';
    loadDay();
  }
  const isToday = f.date === s.today;
  const nav = h('div', { class: 'row datenav' },
    h('button', { type: 'button', class: 'ghost small', 'aria-label': 'Vorige dag', onclick: () => shiftDay(-1) }, '‹'),
    h('strong', { class: 'center' }, isToday ? 'Vandaag' : dateNL(f.date)),
    h('button', { type: 'button', class: 'ghost small', 'aria-label': 'Volgende dag', disabled: isToday, onclick: () => shiftDay(1) }, '›'));
  const head = [h('h1', {}, 'Eten'), nav, f.msg && h('div', { class: 'notice', role: 'status' }, f.msg)];

  if (f.dayState === 'error') return h('div', {}, head, h('button', { type: 'button', class: 'ghost', onclick: reloadDay }, 'Opnieuw proberen'));
  if (f.dayState !== 'ok') return h('div', {}, head, h('p', { class: 'meta' }, 'Laden…'));

  const d = f.day;
  const t = d.totals;
  const tg = d.target;
  const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': tg ? Math.min(100, Math.round((t.kcal / tg.kcal) * 100)) : 0 }, h('div', {}));
  bar.firstChild.style.width = (tg ? Math.min(100, (t.kcal / tg.kcal) * 100) : 0) + '%';
  const totals = h('div', { class: 'card' },
    h('div', { class: 'big' }, fmt(t.kcal, 0), h('small', {}, tg ? ` van ${fmt(tg.kcal, 0)} kcal` : ' kcal')),
    tg && bar,
    h('p', { class: 'hint' }, tg ? (t.kcal <= tg.kcal ? `Nog ${fmt(tg.kcal - t.kcal, 0)} kcal over vandaag.` : `${fmt(t.kcal - tg.kcal, 0)} kcal boven je dagdoel.`) : 'Vul je gewicht in bij Voortgang voor een dagdoel.'),
    h('div', { class: 'stats' },
      stat(fmt(t.protein, 0) + (tg ? ` / ${tg.protein}` : '') + ' g', 'Eiwit'),
      stat(fmt(t.carbs, 0) + (tg ? ` / ${tg.carbs}` : '') + ' g', 'Koolhydraten'),
      stat(fmt(t.fat, 0) + (tg ? ` / ${tg.fat}` : '') + ' g', 'Vet')));

  const meals = MEALS.map(([key, label]) => {
    const items = d.entries.filter((e) => e.meal === key);
    const kc = items.reduce((a, e) => a + e.kcal, 0);
    return h('div', { class: 'card', 'data-meal': key },
      h('div', { class: 'row between' }, h('h3', {}, label), h('span', { class: 'meta' }, items.length ? fmt(kc, 0) + ' kcal' : '')),
      items.length ? h('ul', { class: 'list' }, items.map((e) => h('li', {},
        h('button', { type: 'button', class: 'rowbtn', onclick: () => { f.add = { meal: key, mode: 'amount', sel: { logId: e.id, name: e.name, per100: e.per100, grams: e.grams, servingG: null } }; render(); } },
          h('span', {}, h('strong', {}, e.name), h('div', { class: 'meta' }, fmt(e.grams, 0) + ' g')),
          h('span', { class: 'meta' }, fmt(e.kcal, 0) + ' kcal')),
        h('button', { type: 'button', class: 'danger small', 'aria-label': 'Verwijder ' + e.name, onclick: async () => {
          try { await api('DELETE', '/api/log/' + e.id); } catch (err) { f.msg = err.message; }
          reloadDay();
        } }, 'Wis')))) : null,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'ghost', onclick: () => openPick(key) }, '+ Toevoegen'),
        !items.length && h('button', { type: 'button', class: 'ghost', onclick: async () => {
          f.msg = '';
          try {
            const r = await api('POST', '/api/log/copy', { fromDate: addDays(f.date, -1), toDate: f.date, meal: key });
            if (!r.copied) f.msg = 'Gisteren staat hier niets.';
          } catch (err) { f.msg = err.message; }
          reloadDay();
        } }, 'Kopieer gisteren')));
  });
  return h('div', {}, head, totals, meals);
}

function openPick(meal, from) {
  const a = { meal, from: from || null, mode: 'pick', q: '', foods: null, online: null, msg: '', sel: null };
  state.food.add = a;
  render();
  loadFoods(a);
}

async function loadFoods(a) {
  const q = a.q;
  try {
    const r = await api('GET', '/api/foods?q=' + encodeURIComponent(q));
    if (a.q === q) a.foods = r.foods;
  } catch (e) {
    a.msg = e.message;
  }
  if (state.food.add === a && a.paint) a.paint();
}

function addView() {
  const f = state.food;
  const a = f.add;
  const mealLabel = MEALS.find((m) => m[0] === a.meal)[1];
  const close = () => { f.add = null; f.dayState = 'idle'; state.pday.st = 'idle'; if (a.from) state.tab = a.from; render(); };
  if (a.mode === 'amount') return amountView(a, mealLabel, close);
  if (a.mode === 'new') return newFoodView(a, mealLabel);
  return pickView(a, mealLabel, close);
}

function selectFood(a, fd, extra) {
  a.sel = {
    foodId: fd.id,
    name: foodName(fd),
    per100: { kcal: fd.kcal100, protein: fd.protein100, carbs: fd.carbs100, fat: fd.fat100 },
    servingG: fd.servingG || null,
    grams: fd.servingG || 100,
    warnings: (extra && extra.warnings) || [],
  };
  a.mode = 'amount';
  render();
}

function pickView(a, mealLabel, close) {
  const resultsBox = h('div', { class: 'card' });
  const onlineBox = h('div', {});
  const msg = h('div', { class: 'error', role: 'alert' }, a.msg || '');

  const row = (title, sub, right, onclick, pill) => h('li', {},
    h('button', { type: 'button', class: 'rowbtn', onclick },
      h('span', {}, h('strong', {}, title), sub && h('div', { class: 'meta' }, sub), pill && h('span', { class: 'pill' }, pill)),
      h('span', { class: 'meta' }, right)));

  const paint = () => {
    msg.textContent = a.msg || '';
    resultsBox.replaceChildren(
      h('h3', {}, a.q ? 'Gevonden' : 'Vaak gebruikt'),
      a.foods === null ? h('p', { class: 'meta' }, 'Laden…')
        : a.foods.length ? h('ul', { class: 'list' }, a.foods.map((fd) => row(fd.name, fd.brand, fmt(fd.kcal100, 0) + ' kcal/100 g', () => selectFood(a, fd))))
        : h('p', { class: 'meta' }, a.q ? 'Niets gevonden. Zoek online of maak een eigen product.' : 'Nog geen producten. Zoek online of maak een eigen product.'));
    const o = a.online;
    onlineBox.replaceChildren(...[
      o && o.busy ? h('p', { class: 'meta' }, 'Zoeken…') : null,
      o && o.results ? h('div', { class: 'card' },
        h('h3', {}, 'Open Food Facts'),
        o.results.length ? h('ul', { class: 'list' }, o.results.map((c) => row(c.name, c.brand, fmt(c.kcal100, 0) + ' kcal/100 g', () => pickOnline(a, c), c.warnings && c.warnings.length ? 'controleer waarden' : null)))
          : h('p', { class: 'meta' }, 'Niets gevonden bij Open Food Facts.'),
        h('p', { class: 'hint' }, 'Bron: Open Food Facts (ODbL). Waarden komen van gebruikers en kunnen fout zijn; controleer het etiket.')) : null,
    ].filter(Boolean));
  };
  a.paint = paint;

  let timer;
  const q = h('input', { type: 'text', value: a.q, placeholder: 'Zoek in jullie producten', autocomplete: 'off', 'aria-label': 'Zoek product', oninput: () => {
    clearTimeout(timer);
    timer = setTimeout(() => { a.q = q.value.trim(); loadFoods(a); }, 250);
  } });
  const barcode = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'Barcode', autocomplete: 'off', 'aria-label': 'Barcode' });

  const online = async (fn) => {
    a.msg = '';
    a.online = { busy: true };
    paint();
    try { a.online = await fn(); } catch (e) { a.online = null; a.msg = e.message; }
    paint();
  };

  const view = h('div', {},
    h('div', { class: 'row between' }, h('h1', {}, mealLabel), h('button', { type: 'button', class: 'ghost small', onclick: close }, 'Sluiten')),
    q, msg, resultsBox,
    h('button', { type: 'button', class: 'ghost', onclick: () => {
      const term = q.value.trim();
      if (term.length < 2) { a.msg = 'Typ eerst minstens 2 letters in het zoekveld.'; paint(); return; }
      online(async () => ({ results: (await api('POST', '/api/off/search', { q: term })).results }));
    } }, 'Zoek online (Open Food Facts)'),
    h('div', { class: 'row' }, barcode,
      h('button', { type: 'button', class: 'ghost small', onclick: () => {
        openBarcodeScanner((code) => {
          barcode.value = code;
          online(async () => { const r = await api('POST', '/api/off/barcode', { barcode: code }); return { results: r.result ? [r.result] : [] }; });
        });
      } }, '📷'),
      h('button', { type: 'button', class: 'ghost small', onclick: () => {
        const code = barcode.value.trim();
        online(async () => { const r = await api('POST', '/api/off/barcode', { barcode: code }); return { results: r.result ? [r.result] : [] }; });
      } }, 'Opzoeken')),
    onlineBox,
    h('button', { type: 'button', onclick: () => { a.mode = 'new'; a.msg = ''; render(); } }, 'Nieuw eigen product'));
  paint();
  return view;
}

async function pickOnline(a, cand) {
  try {
    const r = await api('POST', '/api/foods', { ...cand, source: 'off' });
    selectFood(a, { id: r.id, name: cand.name, brand: cand.brand, kcal100: cand.kcal100, protein100: cand.protein100, carbs100: cand.carbs100, fat100: cand.fat100, servingG: cand.servingG }, { warnings: [...(cand.warnings || []), ...(r.warnings || [])].filter((w, i, arr) => arr.indexOf(w) === i) });
  } catch (e) {
    a.msg = e.message;
    if (a.paint) a.paint();
  }
}

function newFoodView(a, mealLabel) {
  const err = errBox();
  const inp = (ph, mode = 'decimal') => h('input', { type: 'text', inputmode: mode, placeholder: ph });
  const name = h('input', { type: 'text', maxlength: '80', placeholder: 'bijv. Havermout', autocomplete: 'off' });
  const brand = h('input', { type: 'text', maxlength: '60', placeholder: 'optioneel', autocomplete: 'off' });
  const kcal = inp('kcal'), prot = inp('g'), carb = inp('g'), fat = inp('g'), serv = inp('g, optioneel');
  const btn = h('button', { type: 'submit' }, 'Opslaan en kiezen');
  const form = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    btn.disabled = true;
    const body = { name: name.value, brand: brand.value, kcal100: parseNum(kcal.value), protein100: parseNum(prot.value), carbs100: parseNum(carb.value), fat100: parseNum(fat.value), servingG: parseNum(serv.value), servingLabel: 'portie', source: 'own' };
    try {
      const r = await api('POST', '/api/foods', body);
      selectFood(a, { id: r.id, name: body.name.trim(), brand: body.brand.trim() || null, kcal100: body.kcal100, protein100: body.protein100, carbs100: body.carbs100, fat100: body.fat100, servingG: body.servingG }, { warnings: r.warnings });
    } catch (e2) {
      showErr(err, e2);
      btn.disabled = false;
    }
  } },
    field('Naam', name), field('Merk', brand),
    h('p', { class: 'hint' }, 'Waarden per 100 gram, zoals op het etiket.'),
    h('div', { class: 'row' }, field('Calorieën (kcal)', kcal), field('Eiwit (g)', prot)),
    h('div', { class: 'row' }, field('Koolhydraten (g)', carb), field('Vet (g)', fat)),
    field('Eén portie is (g)', serv),
    btn,
    h('button', { type: 'button', class: 'ghost', onclick: () => { a.mode = 'pick'; render(); loadFoods(a); } }, 'Terug'),
    err);
  return h('div', {}, h('h1', {}, 'Nieuw product'), h('p', { class: 'sub' }, mealLabel), form);
}

function amountView(a, mealLabel, close) {
  const f = state.food;
  const sel = a.sel;
  const edit = !!sel.logId;
  const err = errBox();
  const btn = h('button', { type: 'submit' }, edit ? 'Opslaan' : 'Toevoegen');
  const grams = h('input', { type: 'text', inputmode: 'decimal', value: String(sel.grams), 'aria-label': 'Gram' });
  const prev = h('div', { class: 'stats' });
  const upd = () => {
    const g = parseNum(grams.value);
    const ok = g !== null && Number.isFinite(g) && g >= 1 && g <= 5000;
    const s = ok ? scaleP(sel.per100, g) : null;
    prev.replaceChildren(stat(ok ? fmt(s.kcal, 0) : '–', 'kcal'), stat(ok ? fmt(s.protein, 1) : '–', 'Eiwit (g)'), stat(ok ? fmt(s.carbs, 1) : '–', 'Koolh. (g)'), stat(ok ? fmt(s.fat, 1) : '–', 'Vet (g)'));
    btn.disabled = !ok;
  };
  grams.addEventListener('input', upd);
  upd();
  const form = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    const g = parseNum(grams.value);
    btn.disabled = true;
    err.textContent = '';
    try {
      if (edit) await api('PUT', '/api/log/' + sel.logId, { grams: g });
      else await api('POST', '/api/log', { date: f.date, meal: a.meal, foodId: sel.foodId, grams: g });
      close();
    } catch (e2) {
      showErr(err, e2);
      btn.disabled = false;
    }
  } },
    field('Hoeveel gram?', grams),
    sel.servingG && h('button', { type: 'button', class: 'ghost small', onclick: () => { grams.value = String(sel.servingG); upd(); } }, `1 portie (${fmt(sel.servingG, 0)} g)`),
    prev, btn,
    h('button', { type: 'button', class: 'ghost', onclick: () => { if (edit) close(); else { a.mode = 'pick'; render(); loadFoods(a); } } }, 'Terug'),
    err);
  return h('div', {}, h('h1', {}, sel.name), h('p', { class: 'sub' }, mealLabel + (edit ? ' (aanpassen)' : '')),
    (sel.warnings || []).map((w) => h('div', { class: 'notice' }, w)), form);
}

// ---------- sport ----------
const INTENSITY_LABELS = { light: 'Licht', moderate: 'Matig', hard: 'Zwaar' };

async function loadWorkouts(date) {
  const sp = state.sport;
  sp.date = date;
  sp.state = 'loading';
  sp.workouts = null;
  try {
    const r = await api('GET', '/api/workouts?date=' + date);
    sp.workouts = r.workouts;
    sp.state = 'ok';
  } catch (_) {
    sp.state = 'error';
  }
  render();
}

async function loadRecentWorkouts() {
  const sp = state.sport;
  sp.recentState = 'loading';
  try {
    const r = await api('GET', '/api/workouts/recent?days=30');
    sp.recent = r.workouts;
    sp.recentState = 'ok';
  } catch (_) {
    sp.recentState = 'error';
  }
  render();
}

function tabSport() {
  const s = state.summary;
  const sp = state.sport;
  const today = s.today;

  if (!sp.date || sp.date !== today) {
    loadWorkouts(today);
    if (sp.recentState === 'idle') loadRecentWorkouts();
    return h('div', {}, h('h1', {}, 'Sport'), h('p', { class: 'meta' }, 'Laden…'));
  }

  if (sp.state === 'error') return h('div', {}, h('h1', {}, 'Sport'), h('button', { type: 'button', class: 'ghost', onclick: () => loadWorkouts(today) }, 'Opnieuw proberen'));

  const todayCard = workoutDayCard(today, sp.workouts || []);

  // Recente trainingen (laatste 30 dagen, gegroepeerd per dag)
  let recentCard = null;
  if (sp.recentState === 'ok' && sp.recent && sp.recent.length) {
    const byDate = {};
    sp.recent.forEach((w) => {
      if (!byDate[w.date]) byDate[w.date] = [];
      byDate[w.date].push(w);
    });
    const dateKeys = Object.keys(byDate).filter((d) => d !== today).sort().reverse().slice(0, 14);
    recentCard = dateKeys.length ? h('div', { class: 'card' }, h('h3', {}, 'Afgelopen trainingen'),
      h('ul', { class: 'list' }, dateKeys.map((d) => {
        const ws = byDate[d];
        const totalMin = ws.reduce((a, w) => a + (w.durationMin || 0), 0);
        const totalKcal = ws.reduce((a, w) => a + (w.kcalBurned || 0), 0);
        return h('li', {},
          h('div', {}, h('strong', {}, dateNL(d)),
            h('div', { class: 'meta' }, ws.map((w) => w.type + (w.durationMin ? ' ' + w.durationMin + ' min' : '')).join(' · '))),
          h('div', { class: 'meta' }, [totalMin ? totalMin + ' min' : null, totalKcal ? '~' + totalKcal + ' kcal' : null].filter(Boolean).join(' · ')));
      }))) : null;
  }

  return h('div', {}, h('h1', {}, 'Sport'), todayCard, recentCard,
    sp.recentState === 'loading' && h('p', { class: 'meta' }, 'Laden…'));
}

function workoutDayCard(date, workouts) {
  const sp = state.sport;
  const err = errBox();

  const workoutList = workouts.length ? h('ul', { class: 'list' }, workouts.map((w) => {
    const parts = [w.type];
    if (w.durationMin) parts.push(w.durationMin + ' min');
    if (w.intensity) parts.push(INTENSITY_LABELS[w.intensity] || w.intensity);
    if (w.kcalBurned) parts.push('~' + w.kcalBurned + ' kcal');
    return h('li', {},
      h('div', {}, h('strong', {}, w.type), h('div', { class: 'meta' }, parts.slice(1).join(' · ')),
        w.notes && h('div', { class: 'meta' }, w.notes)),
      h('button', { type: 'button', class: 'danger small', 'aria-label': 'Verwijder training', onclick: async () => {
        try { await api('DELETE', '/api/workouts/' + w.id); } catch (e) { showErr(err, e); return; }
        await loadWorkouts(date);
        if (sp.recentState === 'ok') loadRecentWorkouts();
      } }, 'Wis'));
  })) : h('p', { class: 'meta' }, 'Nog geen training vandaag.');

  // Formulier voor nieuwe workout
  if (!sp.adding) {
    return h('div', { class: 'card' },
      h('h2', {}, 'Training van ' + (date === state.summary.today ? 'vandaag' : dateNL(date))),
      workoutList,
      err,
      h('button', { type: 'button', class: 'ghost', onclick: () => { sp.adding = true; render(); } }, '+ Training toevoegen'));
  }

  const typeIn = h('input', { type: 'text', placeholder: 'bijv. hardlopen, fietsen, zwemmen', maxlength: '60', autocomplete: 'off' });
  const durIn = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'min', 'aria-label': 'Duur in minuten' });
  const intensityIn = h('select', {},
    h('option', { value: '' }, 'Niet opgeven'),
    h('option', { value: 'light' }, 'Licht'),
    h('option', { value: 'moderate' }, 'Matig'),
    h('option', { value: 'hard' }, 'Zwaar'));
  const kcalIn = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'kcal (optioneel)', 'aria-label': 'Verbrande calorieën' });
  const notesIn = h('input', { type: 'text', placeholder: 'Notitie (optioneel)', maxlength: '200' });
  const btn = h('button', { type: 'submit' }, 'Opslaan');

  const form = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    btn.disabled = true;
    try {
      await api('POST', '/api/workouts', {
        date,
        type: typeIn.value.trim(),
        durationMin: parseNum(durIn.value),
        intensity: intensityIn.value || null,
        kcalBurned: parseNum(kcalIn.value),
        notes: notesIn.value.trim() || null,
      });
      sp.adding = false;
      await loadWorkouts(date);
      if (sp.recentState === 'ok') loadRecentWorkouts();
    } catch (e2) {
      showErr(err, e2);
      btn.disabled = false;
    }
  } },
    h('h2', {}, 'Training van ' + (date === state.summary.today ? 'vandaag' : dateNL(date))),
    workoutList,
    h('h3', {}, 'Nieuwe training'),
    field('Sport / activiteit', typeIn),
    h('div', { class: 'row' }, field('Duur (min)', durIn), field('Intensiteit', intensityIn)),
    h('div', { class: 'row' }, field('Verbrande kcal', kcalIn), field('Notitie', notesIn)),
    btn,
    h('button', { type: 'button', class: 'ghost', onclick: () => { sp.adding = false; render(); } }, 'Annuleren'),
    err);

  return form;
}

// ---------- voedingsschema ----------
async function loadSchema(weekRef) {
  const sc = state.schema;
  sc.state = 'loading';
  try {
    const r = await api('GET', '/api/meal-plan?week=' + weekRef);
    sc.week = r.weekStart;
    sc.entries = r.entries;
    sc.state = 'ok';
  } catch (_) {
    sc.state = 'error';
  }
  render();
}

function tabSchema() {
  const s = state.summary;
  const sc = state.schema;

  if (!sc.week) {
    loadSchema(s.today);
    return h('div', {}, h('h1', {}, 'Schema'), h('p', { class: 'meta' }, 'Laden…'));
  }
  if (sc.state === 'loading') return h('div', {}, h('h1', {}, 'Schema'), h('p', { class: 'meta' }, 'Laden…'));
  if (sc.state === 'error') return h('div', {}, h('h1', {}, 'Schema'), h('button', { type: 'button', class: 'ghost', onclick: () => loadSchema(sc.week || s.today) }, 'Opnieuw proberen'));

  const thisWeek = isoWeekStart(s.today);
  const isCurrentWeek = sc.week === thisWeek;
  const prevWeekDate = addDaysToIso(sc.week, -7);
  const nextWeekDate = addDaysToIso(sc.week, 7);

  // Week navigatie
  const weekLabel = (() => {
    const end = addDaysToIso(sc.week, 6);
    const from = new Date(sc.week + 'T00:00:00Z').toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
    const to = new Date(end + 'T00:00:00Z').toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
    return from + ' – ' + to;
  })();

  const nav = h('div', { class: 'row datenav' },
    h('button', { type: 'button', class: 'ghost small', onclick: () => loadSchema(prevWeekDate) }, '‹'),
    h('strong', { class: 'center' }, isCurrentWeek ? 'Deze week' : weekLabel),
    h('button', { type: 'button', class: 'ghost small', onclick: () => loadSchema(nextWeekDate) }, '›'));

  // Indexeer entries op day+meal
  const entryMap = {};
  (sc.entries || []).forEach((e) => { entryMap[e.day + ':' + e.meal] = e; });

  const avoid = (s.profile && s.profile.avoid) ? s.profile.avoid.toLowerCase() : '';

  const err = errBox();

  // Schema editing
  if (sc.editing) {
    const ed = sc.editing;
    const dishIn = h('input', { type: 'text', value: ed.dish || '', maxlength: '100', placeholder: 'bijv. Havermout met banaan', autocomplete: 'off' });
    const notesIn = h('input', { type: 'text', value: ed.notes || '', maxlength: '200', placeholder: 'Notitie (optioneel)', autocomplete: 'off' });
    const btn = h('button', { type: 'submit' }, 'Opslaan');
    const form = h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      btn.disabled = true;
      try {
        await api('PUT', '/api/meal-plan', { week: sc.week, day: ed.day, meal: ed.meal, dish: dishIn.value, notes: notesIn.value });
        sc.editing = null;
        await loadSchema(sc.week);
      } catch (e2) {
        showErr(err, e2);
        btn.disabled = false;
      }
    } },
      h('h3', {}, DAY_LABELS_FULL[ed.day] + ' — ' + MEAL_MAP[ed.meal]),
      field('Gerecht', dishIn),
      field('Notitie', notesIn),
      avoid && h('p', { class: 'hint' }, 'Let op: niet eten: ' + avoid),
      btn,
      h('button', { type: 'button', class: 'ghost', onclick: () => { sc.editing = null; render(); } }, 'Annuleren'),
      err);
    return h('div', {}, h('h1', {}, 'Schema'), nav, form);
  }

  // Weekraster
  const days = DAY_LABELS.map((label, dayIdx) => {
    const dayDate = addDaysToIso(sc.week, dayIdx);
    const isToday = dayDate === s.today;
    const slots = MEALS.map(([mealKey, mealLabel]) => {
      const entry = entryMap[dayIdx + ':' + mealKey];
      return h('div', { class: 'schema-slot' },
        h('div', { class: 'schema-meal-label' }, mealLabel),
        entry
          ? h('div', { class: 'row between' },
              h('button', { type: 'button', class: 'rowbtn schema-dish', onclick: () => { sc.editing = { day: dayIdx, meal: mealKey, dish: entry.dish, notes: entry.notes }; render(); } },
                entry.dish, entry.notes && h('div', { class: 'meta' }, entry.notes)),
              h('button', { type: 'button', class: 'danger small', 'aria-label': 'Verwijder gerecht', onclick: async () => {
                try { await api('DELETE', '/api/meal-plan/' + entry.id); } catch (e2) { showErr(err, e2); return; }
                await loadSchema(sc.week);
              } }, '×'))
          : h('button', { type: 'button', class: 'ghost small schema-add', onclick: () => { sc.editing = { day: dayIdx, meal: mealKey, dish: '', notes: '' }; render(); } }, '+ Invullen'));
    });
    return h('div', { class: 'card schema-day' + (isToday ? ' schema-today' : '') },
      h('h3', {}, label + (isToday ? ' (vandaag)' : ''), h('span', { class: 'meta' }, ' ' + new Date(dayDate + 'T00:00:00Z').toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }))),
      slots);
  });

  const copyBtn = h('button', { type: 'button', class: 'ghost', onclick: async () => {
    if (!confirm('Schema van vorige week kopiëren naar deze week? Bestaande items blijven staan.')) return;
    try {
      const r = await api('POST', '/api/meal-plan/copy', { toWeek: sc.week });
      if (!r.copied) alert('Vorige week heeft geen schema.');
      else await loadSchema(sc.week);
    } catch (e2) { showErr(err, e2); }
  } }, 'Kopieer vorige week');

  return h('div', {}, h('h1', {}, 'Schema'), nav, err, days, copyBtn);
}

// ---------- render ----------
function render() {
  if (!state.summary) return renderAuth();
  renderApp();
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ── Thema-toggle ──────────────────────────────────────────────
(function () {
  // Pas opgeslagen thema toe (index.html doet dit ook vroeg via inline script)
  const saved = (() => { try { return localStorage.getItem('fit-theme') || 'dark'; } catch (_) { return 'dark'; } })();
  document.documentElement.setAttribute('data-theme', saved);

  const btn = document.createElement('button');
  btn.id = 'theme-toggle';
  btn.setAttribute('aria-label', 'Wissel thema');

  function refresh() {
    const t = document.documentElement.getAttribute('data-theme') || 'dark';
    btn.textContent = t === 'pink' ? '🌑' : '🌸';
    btn.title = t === 'pink' ? 'Naar donker thema' : 'Naar roze thema';
  }

  btn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = cur === 'pink' ? 'dark' : 'pink';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('fit-theme', next); } catch (_) {}
    refresh();
  });

  refresh();
  document.body.appendChild(btn);
})();

load();
