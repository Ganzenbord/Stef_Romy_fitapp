'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'photos'), { recursive: true });

const db = new Database(process.env.DB_FILE || path.join(DATA_DIR, 'health.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS households (
  id INTEGER PRIMARY KEY,
  invite_code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sex TEXT NOT NULL CHECK (sex IN ('male','female')),
  birth_date TEXT NOT NULL,
  height_cm REAL NOT NULL,
  goal_kg REAL NOT NULL,
  activity TEXT NOT NULL DEFAULT 'light',
  rate_pct REAL NOT NULL DEFAULT 0.5,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS entries (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  weight_kg REAL,
  waist_cm REAL,
  PRIMARY KEY (user_id, date)
);
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  file TEXT NOT NULL,
  mime TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_photos_user ON photos(user_id, date);

-- v0.2: voeding. Producten zijn gedeeld binnen het huishouden, het logboek is per persoon.
CREATE TABLE IF NOT EXISTS foods (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id),
  name TEXT NOT NULL,
  brand TEXT,
  barcode TEXT,
  kcal100 REAL NOT NULL,
  protein100 REAL NOT NULL,
  carbs100 REAL NOT NULL,
  fat100 REAL NOT NULL,
  serving_g REAL,
  serving_label TEXT,
  source TEXT NOT NULL CHECK (source IN ('own','off')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_foods_house ON foods(household_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_foods_barcode ON foods(household_id, barcode) WHERE barcode IS NOT NULL;
CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  meal TEXT NOT NULL CHECK (meal IN ('breakfast','lunch','dinner','snack')),
  food_id INTEGER REFERENCES foods(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  grams REAL NOT NULL,
  kcal100 REAL NOT NULL,
  protein100 REAL NOT NULL,
  carbs100 REAL NOT NULL,
  fat100 REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_log_user_date ON log(user_id, date);
`);

// Migratie: lijst met dingen die je niet eet (vrije tekst), later gebruikt bij weekmenu's
const profileCols = db.prepare('PRAGMA table_info(profiles)').all().map((c) => c.name);
if (!profileCols.includes('avoid')) db.exec("ALTER TABLE profiles ADD COLUMN avoid TEXT NOT NULL DEFAULT ''");

module.exports = { db, DATA_DIR };
