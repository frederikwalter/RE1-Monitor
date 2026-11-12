# RE1-Monitor

Dieses Tool dokumentiert, **wann** sich der Fahrplan des RE1 (München – Ingolstadt – Treuchtlingen – Nürnberg) ändert. Es geht dabei um die Bauphase auf der Schnellfahrstrecke vom 30.10. bis 12.12.2026.

**These:** Die Halte in Roth und Nürnberg Hbf stehen Tage vorher im Fahrplan, werden aber erst am Tag der Fahrt gestrichen.

## Wie es funktioniert

| Sammler | Quelle | API-Key | Vorausschau | Was er beweist |
|---|---|---|---|---|
| `collect.mjs` | bahn.de / DB Navigator (über `db-vendo-client`) | nein | beliebig, Standard 72 h | Der Halt stand am Tag X im Fahrplan und ist ab Abruf Y als „entfällt“ markiert oder ganz verschwunden. |
| `iris.mjs` (optional) | offizielle *Timetables*-API (IRIS), DB API Marketplace | ja, kostenlos | ca. 12 h | Der **von der DB selbst gespeicherte Zeitpunkt**, zu dem die Streichung angelegt wurde (Feld `clt`). |

`collect.mjs` fragt am Ankerbahnhof **Treuchtlingen** stundenweise Abfahrten und Ankünfte ab. Über Treuchtlingen fährt jeder umgeleitete RE1, auch wenn er dort vorzeitig endet. Das Skript filtert die RE1-Fahrten heraus und lädt für jede den kompletten Laufweg. Diesen vergleicht es mit dem letzten gespeicherten Stand. Jede Abweichung landet mit Zeitstempel und Vorlauf in Stunden in `data/events.csv`.

Diese Ereignisse werden erkannt:

| Ereignis | Bedeutung |
|---|---|
| `FAHRT_ERSTMALS_GESEHEN` | Erster Abruf der Fahrt; Status von Roth/Nürnberg zu diesem Zeitpunkt |
| `HALT_GESTRICHEN` / `HALT_WIEDERHERGESTELLT` | Halt als „entfällt“ markiert bzw. wieder aktiv |
| `HALT_AUS_LAUFWEG_ENTFERNT` / `HALT_HINZUGEFUEGT` | Halt ganz aus dem Laufweg verschwunden bzw. neu |
| `START_ZIEL_GEAENDERT` | z. B. „München → Nürnberg“ wird zu „München → Treuchtlingen“ |
| `SOLLZEIT_GEAENDERT` | Geänderte Fahrplanzeit (nicht Verspätung) |
| `FAHRT_GESTRICHEN`, `FAHRT_NICHT_MEHR_GEFUNDEN` | Komplettausfall bzw. Fahrt nicht mehr auffindbar |
| `HINWEIS_NEU` / `HINWEIS_ENTFERNT` | Text-Hinweise der DB, z. B. „Halt entfällt“ |

## Einrichtung

Voraussetzung ist ein Rechner, der durchgehend läuft, z. B. ein Uni-Server. Ein Laptop im Ruhezustand erzeugt Lücken. Außerdem wird Node.js ≥ 18 benötigt.

```bash
cd re1-monitor
npm install
```

1. Trage in `config.json` bei `userAgent` deine E-Mail-Adresse ein. Die DB-Schnittstelle verlangt eine Kontaktangabe.
2. Mach einen ersten Probelauf:
   ```bash
   node collect.mjs --horizon 3
   ```
   Prüfe danach `data/debug/lines_seen_at_anchor.json`. Dort sollte `"RE 1"` auftauchen. Heißt die Linie anders (z. B. `"RE1"`), passe `lineRegex` in `config.json` an.
3. Optional richtest du die IRIS-Quelle ein. Registriere dich auf <https://developers.deutschebahn.com>, lege eine Anwendung an und abonniere die API **„Timetables“**. Danach:
   ```bash
   DB_CLIENT_ID=... DB_API_KEY=... node iris.mjs
   ```
   Prüfe `data/iris/debug/categories_*.json`. Dort sollte `"RE 1"` auftauchen; sonst passe `iris.line` an.

## Regelmäßig ausführen (cron)

Öffne die Crontab mit `crontab -e` und trage ein (Pfad anpassen):

```cron
# stündlich: Vorausschau über 3 Tage (Dauer ca. 5–6 min)
7 * * * *    cd $HOME/re1-monitor && node collect.mjs --horizon 72 >> data/cron.log 2>&1
# alle 15 min: Fahrten der nächsten 8 h (fängt kurzfristige Streichungen genau ein)
*/15 * * * * cd $HOME/re1-monitor && node collect.mjs --horizon 8  >> data/cron.log 2>&1
# alle 15 min: IRIS (optional, Keys eintragen)
*/15 * * * * cd $HOME/re1-monitor && DB_CLIENT_ID=xxx DB_API_KEY=yyy node iris.mjs >> data/cron.log 2>&1
```

Ein Lock verhindert, dass sich zwei Läufe überlappen. Ist ein Lauf noch aktiv, wird der nächste übersprungen.

Ohne cron, z. B. in `tmux`, geht auch:
```bash
while true; do node collect.mjs --horizon 8; sleep 900; done
```

## Auswertung

```bash
node report.mjs
```

Das erzeugt `data/report.md` mit der Kernaussage, einem Histogramm des Vorlaufs und einer Liste der einzelnen Streichungen. Dazu kommt `data/report_halte.csv`, eine Zeile pro Fahrt und Bahnhof, z. B. für Excel.

## Dateien in `data/`

| Datei | Inhalt |
|---|---|
| `events.csv` | Alle erkannten Änderungen (Hauptergebnis) |
| `iris_events.csv` | Änderungen laut IRIS inkl. offiziellem Streichungszeitpunkt |
| `snapshots/JJJJ-MM-TT.jsonl` | Vollständiger Stand jeder Fahrt bei jedem Abruf (Beweissicherung) |
| `state/`, `index.json` | Letzter bekannter Stand je Fahrt (intern) |
| `runs.csv` | Protokoll der Läufe (Anzahl Fahrten, Fehler) |

## Grenzen

- Die bahn.de-/DB-Navigator-Schnittstelle ist inoffiziell. Die DB drosselt sie oder sperrt einzelne IP-Adressen; deshalb wartet das Skript 1,2 s zwischen Anfragen. Häufen sich Fehler in `runs.csv`, erhöhe `requestDelayMs` oder wechsle in `config.json` auf `"profile": "db"`.
- Der erkannte Zeitpunkt einer Streichung ist der erste Abruf, bei dem sie sichtbar war. Die Genauigkeit entspricht also dem Intervall (15 min). Den exakten Zeitpunkt liefert nur IRIS (`clt`).
- Fahrten-Schlüssel: Datum + Sollzeit in Treuchtlingen + Richtung (`N`/`S`), z. B. `2026-11-14T1458_N`.
- `FAHRT_NICHT_MEHR_GEFUNDEN` kann auch auf eine fehlerhafte API-Antwort zurückgehen. Prüfe das im Zweifel mit `snapshots/`.

## Test

```bash
npm test   # Offline-Test mit simulierten Daten, kein Netz nötig
```
