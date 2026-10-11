'use strict';
// Wachtwoord opnieuw instellen zonder data te wissen. Gebruik: npm run reset-password
const path = require('path');
const readline = require('readline');
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch (_) {}
const bcrypt = require('bcryptjs');
const { db } = require('../lib/db');

const users = db.prepare('SELECT id, name, email FROM users ORDER BY id').all();
if (!users.length) {
  console.log('Er zijn nog geen accounts. Maak er een aan in de app.');
  process.exit(0);
}
console.log('Accounts:');
users.forEach((u, i) => console.log(`  ${i + 1}. ${u.name} <${u.email}>`));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
let muted = false;
const origWrite = rl._writeToOutput;
rl._writeToOutput = function (s) { if (!muted) origWrite.call(rl, s); };
// Regels in een wachtrij, zodat het ook werkt als de invoer in één keer binnenkomt
const queue = [];
let waiter = null;
rl.on('line', (l) => { if (waiter) { const w = waiter; waiter = null; w(l); } else queue.push(l); });
rl.on('close', () => { if (waiter) { const w = waiter; waiter = null; w(''); } });
const ask = (q, hide) => new Promise((res) => {
  process.stdout.write(q);
  muted = !!hide;
  const done = (a) => { if (hide && process.stdin.isTTY) process.stdout.write('\n'); muted = false; res(a); };
  if (queue.length) done(queue.shift()); else waiter = done;
});

(async () => {
  let user = users.length === 1 ? users[0] : null;
  if (!user) {
    const n = Number(await ask('Nummer van het account: '));
    user = users[n - 1];
    if (!user) { console.log('Ongeldig nummer.'); process.exit(1); }
  }
  const pw = await ask(`Nieuw wachtwoord voor ${user.email} (minimaal 10 tekens): `, true);
  if (pw.length < 10) { console.log('Te kort (minimaal 10 tekens). Er is niets gewijzigd.'); process.exit(1); }
  const pw2 = await ask('Herhaal het wachtwoord: ', true);
  if (pw !== pw2) { console.log('De wachtwoorden zijn niet gelijk. Er is niets gewijzigd.'); process.exit(1); }
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(bcrypt.hashSync(pw, 12), user.id);
  console.log('Klaar. Je kunt nu inloggen met het nieuwe wachtwoord.');
  rl.close();
})();
