'use strict';

// Voedingsmiddelen: validatie, schaling en omzetting van Open Food Facts-producten.
// Waarden zijn altijd per 100 g. Een logregel bewaart een momentopname (kcal/macro's op het moment van loggen),
// zodat het later aanpassen van een product de geschiedenis niet herschrijft.

const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];
const MEAL_LABELS = { breakfast: 'Ontbijt', lunch: 'Lunch', dinner: 'Diner', snack: 'Tussendoor' };

const round = (n, d = 0) => {
  const k = 10 ** d;
  return Math.round(n * k) / k;
};

const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

const macroKcal = (p, c, f) => 4 * p + 4 * c + 9 * f;

function validateFood(input) {
  const errors = [];
  const warnings = [];
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  const brand = String(input.brand ?? '').trim().slice(0, 60) || null;
  const barcodeRaw = String(input.barcode ?? '').trim();
  const barcode = barcodeRaw === '' ? null : barcodeRaw;

  if (name.length < 1 || name.length > 80) errors.push('Naam is verplicht (maximaal 80 tekens).');
  if (barcode !== null && !/^\d{8,14}$/.test(barcode)) errors.push('Barcode moet 8 tot 14 cijfers zijn.');

  const kcal100 = toNum(input.kcal100);
  const protein100 = toNum(input.protein100);
  const carbs100 = toNum(input.carbs100);
  const fat100 = toNum(input.fat100);
  const named = [
    ['Calorieën', kcal100, 900],
    ['Eiwit', protein100, 100],
    ['Koolhydraten', carbs100, 100],
    ['Vet', fat100, 100],
  ];
  for (const [label, v, max] of named) {
    if (v === null || Number.isNaN(v)) errors.push(`${label} per 100 g ontbreekt of is geen getal.`);
    else if (v < 0 || v > max) errors.push(`${label} per 100 g moet tussen 0 en ${max} liggen.`);
  }

  let servingG = toNum(input.servingG);
  if (servingG !== null && (Number.isNaN(servingG) || servingG < 1 || servingG > 2000)) {
    errors.push('Portiegrootte moet tussen 1 en 2000 g liggen.');
  }
  if (servingG === null || Number.isNaN(servingG)) servingG = null;
  const servingLabel = String(input.servingLabel ?? '').trim().slice(0, 30) || null;

  if (!errors.length) {
    if (protein100 + carbs100 + fat100 > 101) errors.push('Eiwit + koolhydraten + vet kan niet meer dan 100 g per 100 g zijn.');
    const est = macroKcal(protein100, carbs100, fat100);
    const diff = Math.abs(kcal100 - est);
    if (diff > 40 && diff > 0.25 * Math.max(kcal100, est)) {
      warnings.push(`Calorieën (${round(kcal100)}) wijken af van wat de macro's geven (ongeveer ${round(est)}). Controleer het etiket.`);
    }
  }

  if (errors.length) return { ok: false, errors, warnings };
  return {
    ok: true,
    errors,
    warnings,
    value: { name, brand, barcode, kcal100, protein100, carbs100, fat100, servingG, servingLabel },
  };
}

function scale(per100, grams) {
  const k = grams / 100;
  return {
    kcal: round(per100.kcal * k),
    protein: round(per100.protein * k, 1),
    carbs: round(per100.carbs * k, 1),
    fat: round(per100.fat * k, 1),
  };
}

function sumTotals(rows) {
  const t = rows.reduce(
    (a, r) => ({ kcal: a.kcal + r.kcal, protein: a.protein + r.protein, carbs: a.carbs + r.carbs, fat: a.fat + r.fat }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  );
  return { kcal: round(t.kcal), protein: round(t.protein, 1), carbs: round(t.carbs, 1), fat: round(t.fat, 1) };
}

// Zet een Open Food Facts-product om naar onze vorm. Geeft null terug als essentiële velden ontbreken.
// Gebruikte velden: code, product_name, brands, serving_quantity en nutriments.
// energy-kcal_100g, proteins_100g, carbohydrates_100g, fat_100g (met terugval op energy_100g in kJ).
function parseOffProduct(p) {
  if (!p || typeof p !== 'object') return null;
  const n = p.nutriments || {};
  const pick = (k) => (typeof n[k] === 'number' ? n[k] : typeof n[k] === 'string' && n[k] !== '' && Number.isFinite(Number(n[k])) ? Number(n[k]) : null);

  let kcal = pick('energy-kcal_100g');
  if (kcal === null) {
    const kj = pick('energy_100g');
    if (kj !== null) kcal = kj / 4.184;
  }
  const protein = pick('proteins_100g');
  const carbs = pick('carbohydrates_100g');
  const fat = pick('fat_100g');
  if ([kcal, protein, carbs, fat].some((v) => v === null)) return null;

  const name = String(p.product_name_nl || p.product_name || '').trim();
  if (!name) return null;
  const brand = String(p.brands || '').split(',')[0].trim() || null;
  const serving = Number(p.serving_quantity);

  const check = validateFood({
    name: name.slice(0, 80),
    brand,
    barcode: /^\d{8,14}$/.test(String(p.code || '')) ? String(p.code) : null,
    kcal100: round(kcal, 1),
    protein100: round(protein, 1),
    carbs100: round(carbs, 1),
    fat100: round(fat, 1),
    servingG: Number.isFinite(serving) && serving >= 1 && serving <= 2000 ? round(serving, 1) : null,
  });
  if (!check.ok) return null;
  return { ...check.value, source: 'off', warnings: check.warnings };
}

module.exports = { MEALS, MEAL_LABELS, validateFood, scale, sumTotals, parseOffProduct, macroKcal };
