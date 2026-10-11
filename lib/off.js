'use strict';
// Open Food Facts-client. Data: ODbL (bronvermelding verplicht). Gebruik volgens hun regels:
// - eigen User-Agent met contactgegevens (OFF_CONTACT_EMAIL)
// - lage limieten (zoeken 10/min, product 15/min per IP): we begrenzen zelf en zoeken nooit "tijdens het typen"
const { parseOffProduct } = require('./food');

const FIELDS = 'code,product_name,product_name_nl,brands,nutriments,serving_quantity';
let fetchImpl = (...a) => fetch(...a);
const setFetch = (f) => {
  fetchImpl = f;
};

class OffError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const buckets = { search: [], product: [] };
const LIMITS = { search: 8, product: 12 }; // per minuut, iets onder de limiet van Open Food Facts
function take(kind) {
  const now = Date.now();
  buckets[kind] = buckets[kind].filter((t) => now - t < 60000);
  if (buckets[kind].length >= LIMITS[kind]) return false;
  buckets[kind].push(now);
  return true;
}
const resetLimits = () => {
  buckets.search = [];
  buckets.product = [];
};

function userAgent() {
  const mail = process.env.OFF_CONTACT_EMAIL;
  if (!mail) throw new OffError('Online zoeken is niet ingesteld (OFF_CONTACT_EMAIL ontbreekt op de server).', 503);
  return `FitHealthApp/0.3 (${mail})`;
}

async function getJson(url) {
  const ua = userAgent();
  let res;
  try {
    res = await fetchImpl(url, { headers: { 'User-Agent': ua, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  } catch (e) {
    throw new OffError('Open Food Facts is nu niet bereikbaar.', 502);
  }
  if (res.status === 429 || res.status === 503) throw new OffError('Open Food Facts is druk. Probeer het over een minuut opnieuw.', 503);
  if (!res.ok) throw new OffError('Open Food Facts gaf een fout.', 502);
  try {
    return await res.json();
  } catch (_) {
    throw new OffError('Onverwacht antwoord van Open Food Facts.', 502);
  }
}

// Vrije-tekstzoekopdracht via de v2 API (vervangt het verouderde CGI-endpoint van nl.openfoodfacts.org).
async function search(query) {
  userAgent(); // eerst controleren of online zoeken is ingesteld, zodat een mislukte poging geen limiet verbruikt
  if (!take('search')) throw new OffError('Even rustig aan: maximaal 8 online zoekopdrachten per minuut.', 429);
  const url =
    'https://world.openfoodfacts.org/api/v2/search?' +
    `search_terms=${encodeURIComponent(query)}&fields=${encodeURIComponent(FIELDS)}&page_size=15&json=true`;
  const data = await getJson(url);
  const list = Array.isArray(data.products) ? data.products : [];
  return list.map(parseOffProduct).filter(Boolean);
}

async function barcode(code) {
  if (!/^\d{8,14}$/.test(code)) throw new OffError('Barcode moet 8 tot 14 cijfers zijn.', 400);
  userAgent();
  if (!take('product')) throw new OffError('Even rustig aan: te veel barcode-opzoekingen.', 429);
  const url = `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${encodeURIComponent(FIELDS)}`;
  const data = await getJson(url);
  if (!data || data.status === 0 || !data.product) return null;
  return parseOffProduct({ ...data.product, code: data.product.code || code });
}

module.exports = { search, barcode, setFetch, resetLimits, OffError };
