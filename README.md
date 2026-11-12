# RE1-Monitor

Dieses Tool dokumentiert, **wann** sich der Fahrplan des RE1 (München – Ingolstadt – Treuchtlingen – Nürnberg) ändert. Es geht um die Bauphase auf der Schnellfahrstrecke vom 30.10. bis 12.12.2026.

**These:** Die Halte in Roth und Nürnberg Hbf stehen Tage vorher im Fahrplan, werden aber erst am Tag der Fahrt gestrichen.

Ein GitHub-Actions-Workflow fragt den Fahrplan jede Stunde ab und legt die Ergebnisse auf dem Branch `data` ab. Die Auswertung steht als Webseite bereit: <https://frederikwalter.github.io/RE1-Monitor/>

## Wie es funktioniert

| Sammler | Quelle | API-Key | Vorausschau | Was er belegt |
|---|---|---|---|---|
| `collect.mjs` | bahn.de / DB Navigator (über `db-vendo-client`) | nein | 72 h | Der Halt stand am Tag X im Fahrplan und ist ab Abruf Y als „entfällt“ markiert oder ganz verschwunden. |
| `iris.mjs` | offizielle *Timetables*-API (IRIS), DB API Marketplace | ja, kostenlos | ca. 12 h | Der **von der DB gespeicherte Zeitpunkt**, zu dem die Streichung angelegt wurde (Feld `clt`). |

### Warum Treuchtlingen?

Keine frei zugängliche Schnittstelle der DB erlaubt die Suche nach einer Zugnummer. Das kann nur die API *RIS::Journeys*; sie ist kostenpflichtig und wird erst nach einer Prüfung durch die DB freigeschaltet. Die übrigen Schnittstellen kennen nur Bahnhofstafeln. Über Treuchtlingen fährt jeder umgeleitete RE1, auch wenn er dort vorzeitig endet. Die Tafel dieses Bahnhofs ist deshalb der Einstieg.

Ein Lauf von `collect.mjs` hat zwei Phasen:

1. **Entdecken.** Das Skript fragt die Abfahrts- und Ankunftstafel in Treuchtlingen ab, aber nur für Stundenfenster, die neu im 72-Stunden-Fenster sind oder zuletzt vor mehr als 6 Stunden abgefragt wurden (`rescanHours`).
2. **Direktabruf.** Jede bereits bekannte Fahrt lädt das Skript direkt über ihre Fahrt-ID, ohne Tafel. Ist die ID ungültig geworden, fragt es das Stundenfenster dieser Fahrt neu ab.

Den Laufweg jeder Fahrt vergleicht es mit dem letzten gespeicherten Stand. Jede Abweichung landet mit Zeitstempel und Vorlauf in Stunden in `events.csv`. Eine Fahrt wird über Betriebstag und Zugnummer erkannt, z. B. `2026-11-14_4041`.

### Erkannte Ereignisse

| Ereignis | Bedeutung |
|---|---|
| `FAHRT_ERSTMALS_GESEHEN` | Erster Abruf der Fahrt; Status von Roth/Nürnberg zu diesem Zeitpunkt |
| `HALT_BEREITS_GESTRICHEN` | Halt war schon beim ersten Abruf als „entfällt“ markiert |
| `HALT_GESTRICHEN` / `HALT_WIEDERHERGESTELLT` | Halt als „entfällt“ markiert bzw. wieder aktiv |
| `HALT_AUS_LAUFWEG_ENTFERNT` / `HALT_HINZUGEFUEGT` | Halt ganz aus dem Laufweg verschwunden bzw. neu |
| `START_ZIEL_GEAENDERT` | z. B. „München → Nürnberg“ wird zu „München → Treuchtlingen“ |
| `SOLLZEIT_GEAENDERT` | Geänderte Fahrplanzeit (nicht Verspätung) |
| `FAHRT_GESTRICHEN` / `FAHRT_WIEDER_AKTIV` | Komplettausfall bzw. dessen Rücknahme |
| `FAHRT_NICHT_MEHR_GEFUNDEN` / `FAHRT_WIEDER_AUFGETAUCHT` | Fahrt weder direkt noch auf der Tafel auffindbar bzw. wieder da |
| `HINWEIS_NEU` / `HINWEIS_ENTFERNT` | Text-Hinweise der DB, z. B. „Halt entfällt“ |

## Einrichtung auf GitHub

1. Das Repository muss **öffentlich** sein. Nur dann sind GitHub Pages und unbegrenzte Actions-Minuten kostenlos, und nur dann kann die Seite die Daten lesen.
2. *Settings → Pages*: Quelle „Deploy from a branch“, Branch `main`, Ordner `/docs`.
3. Optional für IRIS: Registriere dich auf <https://developers.deutschebahn.com>, lege eine Anwendung an und abonniere die API **„Timetables“**. Trage Client-ID und API-Key unter *Settings → Secrets and variables → Actions* als `DB_CLIENT_ID` und `DB_API_KEY` ein. Ohne diese Werte überspringt der Workflow IRIS.
4. *Actions → RE1-Monitor → Run workflow* startet den ersten Lauf. Danach läuft der Workflow stündlich. Den Branch `data` legt er selbst an.

## Auswertung

Die Seite `docs/index.html` lädt `events.csv`, `iris_events.csv` und `runs.csv` vom Branch `data` und rechnet im Browser. Sie zeigt die Kernzahlen, die Verteilung des Vorlaufs, jede einzelne Streichung und den Zustand des Sammlers. Die Rechenlogik liegt in `docs/report.js`.

Lokal ansehen (aus dem Repo-Ordner, mit Daten in `data/`):

```bash
python3 -m http.server 8000
# dann http://localhost:8000/docs/ öffnen; andere Datenquelle: ?src=<Ordner oder URL>
```

## Dateien auf dem Branch `data`

| Datei | Inhalt |
|---|---|
| `events.csv` | Alle erkannten Änderungen (Hauptergebnis) |
| `iris_events.csv` | Änderungen laut IRIS inkl. offiziellem Streichungszeitpunkt |
| `runs.csv` | Protokoll der Läufe (Fahrten, Ereignisse, Fehler, Zahl der Anfragen) |
| `snapshots/JJJJ-MM-TT.jsonl` | Vollständiger Laufweg einer Fahrt bei jeder Änderung (Beweissicherung) |
| `index.json`, `state/`, `iris/` | Letzter bekannter Stand (intern) |

## Lokal ausführen

Voraussetzung ist Node.js ≥ 20.

```bash
npm install
node collect.mjs --horizon 6 --dry-run   # Probelauf, speichert nichts
node collect.mjs                         # 72 h, schreibt nach data/
DB_CLIENT_ID=... DB_API_KEY=... node iris.mjs
npm test                                 # Offline-Test mit simulierten Daten
```

`config.json` enthält Linie, Ankerbahnhof, beobachtete Halte und Abfrageparameter. Findet der Sammler keine Fahrt, zeigt `data/state/lines_seen_at_anchor.json`, wie die Linien auf der Tafel heißen; passe dann `lineRegex` an.

## Alternativen zum Dauerbetrieb

GitHub Actions braucht keinen eigenen Rechner, hat aber zwei Schwächen: Geplante Läufe starten oft 5–30 Minuten verspätet, und die DB sperrt die inoffizielle Schnittstelle für manche Rechenzentren. Zeigt `runs.csv` dauerhaft Fehler, eignet sich einer dieser Wege:

| Ort | Vorteil | Nachteil |
|---|---|---|
| LNT-Server (cron) | pünktlich, Uni-Netz, kostenlos | Zugang und Wartung hängen am Lehrstuhl |
| Raspberry Pi oder NAS zu Hause | private IP-Adresse, wird am seltensten gesperrt | Gerät muss durchlaufen |
| Mietserver (ab ca. 4 € im Monat) | pünktlich, unabhängig | Rechenzentrums-IP, Sperre möglich |

Auf einem eigenen Rechner genügt ein Cron-Eintrag. Er startet beide Sammler und lädt die Daten danach auf den Branch `data` hoch, damit die Seite sie findet:

```bash
git clone git@github.com:frederikwalter/RE1-Monitor.git && cd RE1-Monitor && npm ci
git worktree add data origin/data   # falls der Branch schon existiert
crontab -e
```

```cron
7 * * * * cd $HOME/RE1-Monitor && node collect.mjs >> cron.log 2>&1; DB_CLIENT_ID=xxx DB_API_KEY=yyy node iris.mjs >> cron.log 2>&1; cd data && git add -A && git commit -qm "Daten $(date '+\%F \%H:\%M')" && git push -q origin HEAD:data
```

Schalte in diesem Fall den Workflow unter *Actions* ab, damit nicht zwei Sammler auf denselben Branch schreiben.

## Grenzen

- Die bahn.de-/DB-Navigator-Schnittstelle ist inoffiziell. Die DB drosselt sie und sperrt einzelne IP-Adressen (Antwort `OPS_BLOCKED` oder „Access Denied“). Das Skript wartet deshalb 1,2 s zwischen zwei Anfragen. Die offizielle IRIS-Schnittstelle ist davon nicht betroffen.
- Der erkannte Zeitpunkt einer Streichung ist der erste Abruf, bei dem sie sichtbar war. Die Genauigkeit entspricht dem Abfrageintervall von einer Stunde. Den exakten Zeitpunkt liefert nur IRIS (`clt`).
- `FAHRT_NICHT_MEHR_GEFUNDEN` kann auch auf eine fehlerhafte API-Antwort zurückgehen. Prüfe das im Zweifel mit `snapshots/`.
- GitHub schaltet geplante Workflows ab, wenn ein Repository 60 Tage lang keine Aktivität zeigt.
