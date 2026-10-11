# Fit

Persoonlijke gezondheidsapp voor twee personen (mobiel-first PWA). Versie 0.1.

## Wat zit erin

- Accounts voor 2 personen in één huishouden (uitnodigingscode voor de tweede persoon)
- Profiel en doel per persoon; dagdoel (kcal + eiwit/koolhydraten/vet) berekend in code (`lib/calc.js`)
- Dagelijks gewicht, wekelijks taille, 7-daags gemiddelde, werkelijk tempo vs. plan, grafiek
- Voortgangsfoto's, privé per account (de partner ziet ze niet)
- Voeding loggen (v0.2): producten per 100 g (gedeeld in het huishouden), logboek per persoon, vier maaltijden, dagtotalen tegen het dagdoel, "kopieer gisteren", vaak gebruikte producten bovenaan. Een logregel bewaart een momentopname, dus een product later aanpassen herschrijft de geschiedenis niet.
- Per persoon een "Niet eten"-lijst (vrije tekst). Die wordt in v0.3 bij weekmenu's gebruikt; nu alleen opgeslagen en getoond.
- Veiligheidsgrenzen: weigert streefgewicht met BMI < 18,5, dagdoel nooit onder BMR (en nooit onder 1500 man / 1200 vrouw), tekort max. 25%, tempo max. 1% lichaamsgewicht per week, waarschuwing als je sneller afvalt

## Nog niet gebouwd

Weekmenu's, trainplan en boodschappenlijst, en een NEVO-import (zie "Voedingsdata"). Dat zijn de volgende stappen.

## Lokaal draaien

```bash
npm install
npm test
npm start          # http://127.0.0.1:3000, de setup-sleutel staat in de serverlog
```

Eerste registratie: "Eerste keer? Maak het huishouden aan" en vul de setup-sleutel uit de log in. Daarna geeft de app op het tabblad Plan een uitnodigingscode voor de tweede persoon. Een huishouden zit vol bij 2 personen.

## Omgevingsvariabelen

| Variabele | Betekenis |
|---|---|
| `PORT` | poort (standaard 3000) |
| `HOST` | bindadres (standaard 127.0.0.1) |
| `DATA_DIR` | map voor database en foto's (standaard `./data`) |
| `SETUP_KEY` | sleutel voor de eerste registratie (standaard willekeurig per start, zichtbaar in de log zolang er nog geen huishouden is) |
| `SESSION_SECRET` | sessiesleutel (standaard automatisch gegenereerd in `DATA_DIR/session.secret`) |
| `OFF_CONTACT_EMAIL` | jouw e-mailadres voor de User-Agent richting Open Food Facts. Zonder deze variabele staat online zoeken uit (503). |
| `NODE_ENV=production` | zet de sessiecookie op `Secure`, dus alleen via HTTPS gebruiken |

## Op een VPS

Draai de app achter een reverse proxy met HTTPS. Voorbeeld met Caddy:

```
fit.jouwdomein.nl {
  reverse_proxy 127.0.0.1:3000
}
```

Voorbeeld systemd-unit (`/etc/systemd/system/fit.service`):

```
[Unit]
Description=Fit
After=network.target

[Service]
WorkingDirectory=/opt/fit
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=DATA_DIR=/var/lib/fit
ExecStart=/usr/bin/node server.js
Restart=on-failure
User=fit

[Install]
WantedBy=multi-user.target
```

Maak een back-up van `DATA_DIR` (database + foto's). Zonder die map ben je alles kwijt.

## Voedingsdata

- **Eigen producten**: altijd beschikbaar, handmatig invoeren per 100 g (de app waarschuwt als calorieën niet bij de macro's passen en weigert onmogelijke waarden).
- **Open Food Facts** (online zoeken en barcode): data onder de ODbL-licentie, bronvermelding staat in de app. We sturen een eigen User-Agent en begrenzen onszelf op 8 zoekopdrachten en 12 barcode-opzoekingen per minuut (hun limieten zijn 10 en 15 per minuut per IP). Zoeken gebeurt alleen op knopdruk, nooit tijdens het typen. Gekozen producten worden lokaal opgeslagen.
  **Let op:** de koppeling is getest met nagebootste antwoorden. De bouwomgeving kon Open Food Facts zelf niet bereiken, dus de echte API-aanroep (met name het legacy-zoekendpoint `/cgi/search.pl` en de veldnamen in `nutriments`) is nog niet live geverifieerd. Test na de eerste deploy één zoekopdracht en één barcode.
- **NEVO** (RIVM): niet meegeleverd. De dataset moet je zelf aanvragen bij het RIVM; hun voorwaarden eisen onder meer ongewijzigd gebruik, bronvermelding ("NEVO online, versie …, RIVM, Bilthoven") en dat je er geen geld voor vraagt. Of een kopie in een repo of app is toegestaan staat er niet in. Zet de dataset daarom niet in git. Een importer schrijf ik zodra het echte bestand beschikbaar is, want de kolomindeling moet ik dan kunnen zien.

## Rekenaannames

- BMR: Mifflin-St Jeor
- Activiteit: factor 1,2 / 1,375 / 1,55
- 7700 kcal ≈ 1 kg is een rule of thumb; het werkelijke verloop wijkt af
- Eiwit 1,8 g per kg lichaamsgewicht
- Dit is geen medisch advies. Bij een medische aandoening, zwangerschap of een eetstoornis(-verleden) hoort dit onder begeleiding van een arts of diëtist.

## Privacy en beveiliging

- Wachtwoorden met bcrypt, sessie via httpOnly-cookie, CSRF-header op alle schrijvende calls
- Foto's liggen buiten de webroot en worden alleen aan de eigenaar geserveerd
- De service worker cachet nooit API-verkeer
- Rate limit op inloggen en registreren (in het geheugen, per proces)
