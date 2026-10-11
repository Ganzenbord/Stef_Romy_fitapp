'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateFood, scale, sumTotals, parseOffProduct } = require('../lib/food');

const base = { name: 'Havermout', kcal100: 370, protein100: 13, carbs100: 60, fat100: 7 };

test('validateFood: geldig product, komma als decimaalteken', () => {
  const v = validateFood({ ...base, kcal100: '370', protein100: '13,5', servingG: '40', servingLabel: 'kom' });
  assert.equal(v.ok, true);
  assert.equal(v.value.protein100, 13.5);
  assert.equal(v.value.servingG, 40);
  assert.deepEqual(v.warnings, []);
});

test('validateFood: afwijzen van onzin', () => {
  assert.equal(validateFood({ ...base, name: '  ' }).ok, false);
  assert.equal(validateFood({ ...base, kcal100: -1 }).ok, false);
  assert.equal(validateFood({ ...base, kcal100: 901 }).ok, false);
  assert.equal(validateFood({ ...base, protein100: 'abc' }).ok, false);
  assert.equal(validateFood({ ...base, fat100: '' }).ok, false);
  assert.equal(validateFood({ ...base, barcode: '12ab' }).ok, false);
  assert.equal(validateFood({ ...base, servingG: 0 }).ok, false);
  // 60 + 50 + 10 gram per 100 gram kan niet
  assert.equal(validateFood({ ...base, protein100: 60, carbs100: 50, fat100: 10 }).ok, false);
});

test('validateFood: waarschuwt bij calorieën die niet bij de macro\'s passen', () => {
  const v = validateFood({ ...base, kcal100: 120 }); // macro's geven ~ 4*13+4*60+9*7 = 355
  assert.equal(v.ok, true);
  assert.equal(v.warnings.length, 1);
  assert.match(v.warnings[0], /wijken af/);
});

test('validateFood: kleine afwijking (vezels, afronding) geeft geen waarschuwing', () => {
  assert.deepEqual(validateFood({ ...base, kcal100: 340 }).warnings, []);
});

test('scale: rekent per 100 g om en rondt af', () => {
  const s = scale({ kcal: 370, protein: 13, carbs: 60, fat: 7 }, 45);
  assert.equal(s.kcal, 167); // 166.5 -> 167
  assert.equal(s.protein, 5.9); // 5.85 -> 5.9
  assert.equal(s.carbs, 27);
  assert.equal(s.fat, 3.2); // 3.15 -> 3.2 (afronding)
});

test('sumTotals', () => {
  const t = sumTotals([
    { kcal: 100, protein: 1.25, carbs: 2, fat: 0.5 },
    { kcal: 250, protein: 8.5, carbs: 30, fat: 9.1 },
  ]);
  assert.deepEqual(t, { kcal: 350, protein: 9.8, carbs: 32, fat: 9.6 });
});

const offProduct = (over = {}) => ({
  code: '8710400000000',
  product_name: 'Magere kwark',
  brands: 'Melkunie, Overig',
  serving_quantity: '125',
  nutriments: { 'energy-kcal_100g': 57, proteins_100g: 10, carbohydrates_100g: 4, fat_100g: 0.2 },
  ...over,
});

test('parseOffProduct: volledig product', () => {
  const p = parseOffProduct(offProduct());
  assert.equal(p.name, 'Magere kwark');
  assert.equal(p.brand, 'Melkunie');
  assert.equal(p.barcode, '8710400000000');
  assert.equal(p.kcal100, 57);
  assert.equal(p.servingG, 125);
  assert.equal(p.source, 'off');
});

test('parseOffProduct: kJ als terugval, Nederlandse naam heeft voorrang', () => {
  const p = parseOffProduct(offProduct({ product_name_nl: 'Kwark mager', nutriments: { energy_100g: 239, proteins_100g: 10, carbohydrates_100g: 4, fat_100g: 0.2 } }));
  assert.equal(p.name, 'Kwark mager');
  assert.ok(Math.abs(p.kcal100 - 57.1) < 0.2, `kcal ${p.kcal100}`);
});

test('parseOffProduct: onvolledig of onzinnig product wordt overgeslagen', () => {
  assert.equal(parseOffProduct(offProduct({ nutriments: { 'energy-kcal_100g': 57, proteins_100g: 10 } })), null);
  assert.equal(parseOffProduct(offProduct({ product_name: '' })), null);
  assert.equal(parseOffProduct(offProduct({ nutriments: { 'energy-kcal_100g': 5000, proteins_100g: 1, carbohydrates_100g: 1, fat_100g: 1 } })), null);
  assert.equal(parseOffProduct(null), null);
});

test('parseOffProduct: waarden als tekst worden geaccepteerd, ongeldige barcode wordt leeg', () => {
  const p = parseOffProduct(offProduct({ code: 'abc', nutriments: { 'energy-kcal_100g': '57', proteins_100g: '10', carbohydrates_100g: '4', fat_100g: '0.2' } }));
  assert.equal(p.kcal100, 57);
  assert.equal(p.barcode, null);
});
