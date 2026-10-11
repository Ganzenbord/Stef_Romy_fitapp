'use strict';

// Rekenmodule. Alle getallen in de app komen hieruit, nooit uit een taalmodel.
// Bronnen/aannames (benaderingen, geen exacte wetenschap):
// - BMR: Mifflin-St Jeor (1990)
// - Activiteitsfactoren: standaard 1.2 / 1.375 / 1.55
// - 7700 kcal per kg lichaamsgewicht is een rule of thumb; het echte verloop wijkt af
// - Eiwit 1.8 g per kg lichaamsgewicht (binnen de gangbare 1.6-2.2 bij krachttraining in een tekort)

const ACTIVITY = {
  sedentary: 1.2, // zittend, nauwelijks sport
  light: 1.375, // zittend werk + 1-4 korte sessies per week
  moderate: 1.55, // zittend werk + 4-5 stevige sessies per week
};

const KCAL_PER_KG = 7700;
const MAX_RATE_PCT = 1.0; // max % lichaamsgewicht per week
const MIN_RATE_PCT = 0.25;
const MAX_DEFICIT_FRACTION = 0.25; // nooit meer dan 25% onder onderhoud
const ABS_FLOOR = { male: 1500, female: 1200 };
const MIN_GOAL_BMI = 18.5;
const WARN_GOAL_BMI = 20;

function round(n, step = 1) {
  return Math.round(n / step) * step;
}

function bmi(weightKg, heightCm) {
  const m = heightCm / 100;
  return weightKg / (m * m);
}

function bmr({ sex, weightKg, heightCm, age }) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return sex === 'male' ? base + 5 : base - 161;
}

function validate(p) {
  const errors = [];
  if (p.sex !== 'male' && p.sex !== 'female') errors.push('Geslacht ontbreekt (nodig voor de formule).');
  if (!(p.age >= 18 && p.age <= 90)) errors.push('Leeftijd moet 18 of ouder zijn.');
  if (!(p.heightCm >= 120 && p.heightCm <= 230)) errors.push('Lengte buiten bereik (120-230 cm).');
  if (!(p.weightKg >= 35 && p.weightKg <= 300)) errors.push('Gewicht buiten bereik (35-300 kg).');
  if (!(p.goalKg >= 35 && p.goalKg <= 300)) errors.push('Streefgewicht buiten bereik.');
  if (!ACTIVITY[p.activity]) errors.push('Onbekend activiteitsniveau.');
  return errors;
}

function plan(input) {
  const p = { activity: 'light', ratePct: 0.5, ...input };
  const errors = validate(p);
  if (errors.length) return { ok: false, errors };

  const warnings = [];
  const goalBmi = bmi(p.goalKg, p.heightCm);
  if (goalBmi < MIN_GOAL_BMI) {
    return {
      ok: false,
      errors: [
        `Streefgewicht ${p.goalKg} kg geeft BMI ${goalBmi.toFixed(1)} (ondergewicht). De app weigert dit doel. Kies minimaal ${Math.ceil(
          MIN_GOAL_BMI * Math.pow(p.heightCm / 100, 2)
        )} kg.`,
      ],
    };
  }
  if (goalBmi < WARN_GOAL_BMI) {
    warnings.push(`Streefgewicht geeft BMI ${goalBmi.toFixed(1)}, dat is laag-normaal. Bespreek dit met je huisarts of diëtist.`);
  }

  const bmrKcal = bmr(p);
  const tdee = bmrKcal * ACTIVITY[p.activity];
  const currentBmi = bmi(p.weightKg, p.heightCm);
  const toLose = p.weightKg - p.goalKg;

  const base = {
    ok: true,
    warnings,
    bmi: round(currentBmi, 0.1),
    goalBmi: round(goalBmi, 0.1),
    bmr: round(bmrKcal),
    maintenanceKcal: round(tdee, 10),
  };

  if (toLose <= 0) {
    return {
      ...base,
      mode: 'maintain',
      targetKcal: round(tdee, 10),
      deficitKcal: 0,
      kgPerWeek: 0,
      weeks: 0,
      ...macros(round(tdee, 10), p.weightKg),
    };
  }

  const ratePct = Math.min(Math.max(p.ratePct, MIN_RATE_PCT), MAX_RATE_PCT);
  if (ratePct !== p.ratePct) warnings.push(`Tempo bijgesteld naar ${ratePct}% lichaamsgewicht per week (toegestaan: ${MIN_RATE_PCT}-${MAX_RATE_PCT}%).`);

  let deficit = ((p.weightKg * ratePct) / 100 * KCAL_PER_KG) / 7;
  const maxDeficit = tdee * MAX_DEFICIT_FRACTION;
  if (deficit > maxDeficit) {
    deficit = maxDeficit;
    warnings.push('Tekort begrensd tot maximaal 25% onder onderhoud.');
  }

  const floor = Math.max(bmrKcal, ABS_FLOOR[p.sex]);
  let target = tdee - deficit;
  if (target < floor) {
    target = floor;
    deficit = tdee - target;
    warnings.push(`Dagdoel verhoogd naar ondergrens (${round(floor, 10)} kcal). Het tempo is daardoor lager.`);
  }

  const kgPerWeek = (deficit * 7) / KCAL_PER_KG;
  const weeks = kgPerWeek > 0 ? toLose / kgPerWeek : Infinity;

  return {
    ...base,
    mode: 'lose',
    targetKcal: round(target, 10),
    deficitKcal: round(deficit, 10),
    kgPerWeek: round(kgPerWeek, 0.01),
    weeks: Math.ceil(weeks),
    ...macros(round(target, 10), p.weightKg),
  };
}

function macros(kcal, weightKg) {
  const proteinG = round(1.8 * weightKg);
  const fatG = round((0.25 * kcal) / 9);
  const carbsG = Math.max(0, round((kcal - proteinG * 4 - fatG * 9) / 4));
  return { proteinG, fatG, carbsG };
}

// Voortschrijdend gemiddelde over de laatste `days` kalenderdagen (alleen dagen met een meting tellen).
// entries: [{date:'YYYY-MM-DD', value:number}] oplopend of niet, wordt gesorteerd.
function movingAverage(entries, days = 7) {
  const sorted = [...entries].filter((e) => Number.isFinite(e.value)).sort((a, b) => a.date.localeCompare(b.date));
  return sorted.map((e, i) => {
    const end = Date.parse(e.date + 'T00:00:00Z');
    const window = [];
    for (let j = i; j >= 0; j--) {
      const t = Date.parse(sorted[j].date + 'T00:00:00Z');
      if ((end - t) / 86400000 >= days) break;
      window.push(sorted[j].value);
    }
    const avg = window.reduce((s, v) => s + v, 0) / window.length;
    return { date: e.date, value: e.value, avg: round(avg, 0.01), n: window.length };
  });
}

module.exports = { ACTIVITY, bmi, bmr, plan, movingAverage, validate };
