'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { plan, movingAverage, bmr, bmi } = require('../lib/calc');

const approx = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} niet binnen ${tol} van ${b}`);

test('Mifflin-St Jeor: handberekende waarden', () => {
  // man: 10*90 + 6.25*180 - 5*30 + 5 = 1880
  approx(bmr({ sex: 'male', weightKg: 90, heightCm: 180, age: 30 }), 1880, 0.01);
  // vrouw: 10*70 + 6.25*168 - 5*30 - 161 = 1439
  approx(bmr({ sex: 'female', weightKg: 70, heightCm: 168, age: 30 }), 1439, 0.01);
});

test('plan man 90 -> 80, licht actief, 0.5%/week', () => {
  const r = plan({ sex: 'male', weightKg: 90, heightCm: 180, age: 30, goalKg: 80 });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'lose');
  approx(r.maintenanceKcal, 2590, 10); // 1880 * 1.375 = 2585
  approx(r.deficitKcal, 500, 10); // 90 * 0.005 * 7700 / 7 = 495
  approx(r.targetKcal, 2090, 10);
  approx(r.kgPerWeek, 0.45, 0.01);
  assert.ok(r.weeks >= 22 && r.weeks <= 24, `weeks=${r.weeks}`);
  assert.equal(r.proteinG, 162); // 1.8 * 90
  assert.ok(r.targetKcal > r.bmr, 'doel moet boven BMR liggen');
});

test('plan vrouw 70 -> 62, licht actief, 0.5%/week', () => {
  const r = plan({ sex: 'female', weightKg: 70, heightCm: 168, age: 30, goalKg: 62 });
  assert.equal(r.ok, true);
  approx(r.maintenanceKcal, 1980, 10);
  approx(r.deficitKcal, 390, 10);
  approx(r.targetKcal, 1590, 15);
  assert.ok(r.targetKcal >= r.bmr, 'niet onder BMR');
  assert.ok(r.weeks >= 22 && r.weeks <= 24, `weeks=${r.weeks}`);
  assert.equal(r.proteinG, 126); // 1.8 * 70
});

test('weigert streefgewicht met BMI onder 18.5', () => {
  const r = plan({ sex: 'female', weightKg: 60, heightCm: 170, age: 25, goalKg: 50 }); // BMI 17.3
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /weigert/);
});

test('waarschuwt bij BMI tussen 18.5 en 20', () => {
  const r = plan({ sex: 'female', weightKg: 60, heightCm: 170, age: 25, goalKg: 55 }); // BMI 19.0
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /laag-normaal/.test(w)));
});

test('weigert minderjarigen', () => {
  const r = plan({ sex: 'male', weightKg: 80, heightCm: 180, age: 17, goalKg: 75 });
  assert.equal(r.ok, false);
});

test('tempo wordt gecapt op 1% per week', () => {
  const r = plan({ sex: 'male', weightKg: 100, heightCm: 180, age: 30, goalKg: 85, ratePct: 3 });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /bijgesteld/.test(w)));
  assert.ok(r.kgPerWeek <= 1.0 + 0.01);
});

test('tekort wordt nooit groter dan 25% onder onderhoud', () => {
  const r = plan({ sex: 'male', weightKg: 130, heightCm: 180, age: 30, goalKg: 90, ratePct: 1 });
  assert.equal(r.ok, true);
  assert.ok(r.deficitKcal <= r.maintenanceKcal * 0.25 + 10);
});

test('absolute ondergrens 1500 (man) en 1200 (vrouw) en BMR worden gehaald', () => {
  const m = plan({ sex: 'male', weightKg: 55, heightCm: 160, age: 50, goalKg: 52, ratePct: 1 });
  assert.equal(m.ok, true);
  assert.ok(m.targetKcal >= 1500, `targetKcal=${m.targetKcal}`);
  assert.ok(m.targetKcal >= m.bmr - 5);
});

test('streefgewicht boven huidig gewicht geeft onderhoud, geen tekort', () => {
  const r = plan({ sex: 'male', weightKg: 80, heightCm: 180, age: 30, goalKg: 82 });
  assert.equal(r.mode, 'maintain');
  assert.equal(r.deficitKcal, 0);
});

test('macro-kcal tellen op tot het dagdoel (binnen afronding)', () => {
  const r = plan({ sex: 'male', weightKg: 90, heightCm: 180, age: 30, goalKg: 80 });
  const sum = r.proteinG * 4 + r.fatG * 9 + r.carbsG * 4;
  approx(sum, r.targetKcal, 30);
});

test('bmi helper', () => {
  approx(bmi(80, 180), 24.7, 0.05);
  approx(bmi(62, 168), 22.0, 0.05);
});

test('movingAverage: 7-daags venster, ontbrekende dagen tellen niet mee', () => {
  const e = [
    { date: '2026-10-01', value: 88 },
    { date: '2026-10-03', value: 87 },
    { date: '2026-10-05', value: 86 },
    { date: '2026-10-09', value: 85 }, // 8 dagen na 10-01 -> valt buiten venster van 10-01
  ];
  const r = movingAverage(e, 7);
  assert.equal(r[0].avg, 88);
  approx(r[2].avg, 87, 0.001);
  // venster voor 10-09: dagen > 10-02 -> 10-03, 10-05, 10-09
  approx(r[3].avg, (87 + 86 + 85) / 3, 0.01);
  assert.equal(r[3].n, 3);
});
