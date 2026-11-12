# RE1-Monitor

Dieses Tool dokumentiert, **wann** die DB Halte des RE1 (München – Ingolstadt – Treuchtlingen – Nürnberg) streicht. Es geht um die Bauphase auf der Schnellfahrstrecke vom 30.10. bis 12.12.2026.

**These:** Die Halte in Roth und Nürnberg Hbf stehen im Fahrplan und werden erst am Tag der Fahrt gestrichen.

Ein GitHub-Actions-Workflow fragt die DB jede Stunde ab und legt die Ergebnisse auf dem Branch `data` ab. Die Auswertung steht als Webseite bereit: <https://frederikwalter.github.io/RE1-Monitor/>

## Wie es funktioniert

Quelle ist die offizielle **Timetables-API** der DB (intern „IRIS“) aus dem DB API Marketplace. Der Zugang ist kostenlos, braucht aber einen API-Key. Die API kennt nur Bahnhöfe, keine einzelnen Züge. `collect.mjs` lädt deshalb für Roth und Nürnberg Hbf

1. den **Sollfahrplan** der nächsten 24 Stunden (`/plan`, jede Stundenscheibe nur einmal) und
2. alle bekannten **Änderungen** (`/fchg`),

filtert die Halte der Linie RE1 heraus und vergleicht ihren Status mit dem letzten Lauf. Jede Änderung landet in `events.csv`.

Zu jeder Streichung liefert die API das Feld `clt`: den Zeitpunkt, zu dem die DB die Streichung in ihrem System angelegt hat. Der Vorlauf (`lead_time_h`) ist der Abstand zwischen diesem Zeitpunkt und der planmäßigen Abfahrt. Er hängt nicht davon ab, wann das Skript läuft.

### Erkannte Ereignisse

| Ereignis | Bedeutung |
|---|---|
| `ERSTMALS_GESEHEN` | Halt taucht zum ersten Mal im Sollfahrplan auf; Status zu diesem Zeitpunkt |
| `HALT_GESTRICHEN` | Ankunft und Abfahrt sind gestrichen |
| `HALT_TEILWEISE_GESTRICHEN` | Nur Ankunft oder nur Abfahrt ist gestrichen (Zug endet oder beginnt hier) |
| `HALT_WIEDERHERGESTELLT` | Streichung zurückgenommen |
| `LAUFWEG_GEAENDERT` | Geänderter Laufweg bei gleichem Status |

### Warum nicht bahn.de?

Die erste Fassung fragte die Schnittstelle von bahn.de / DB Navigator ab, weil sie den Fahrplan Tage im Voraus zeigt. Die DB schützt sie seit Mai 2026 gegen automatische Abfragen (Antwort `OPS_BLOCKED`), auch von GitHub aus. Eine Suche nach einzelnen Zugnummern bietet nur die API *RIS::Journeys*; sie ist kostenpflichtig und wird erst nach einer Prüfung durch die DB freigeschaltet.

## Einrichtung auf GitHub

1. Das Repository muss **öffentlich** sein. Nur dann sind GitHub Pages und unbegrenzte Actions-Minuten kostenlos, und nur dann kann die Seite die Daten lesen.
2. API-Key holen: Auf <https://developers.deutschebahn.com> registrieren, eine Anwendung anlegen und die API **„Timetables“** abonnieren.
3. Client-ID und API-Key unter *Settings → Secrets and variables → Actions* als `DB_CLIENT_ID` und `DB_API_KEY` eintragen.
4. *Settings → Pages*: Quelle „Deploy from a branch“, Branch `main`, Ordner `/docs`.
5. *Actions → RE1-Monitor → Run workflow* startet den ersten Lauf. Danach läuft der Workflow stündlich. Den Branch `data` legt er selbst an.

## Auswertung

Die Seite `docs/index.html` lädt `events.csv` und `runs.csv` vom Branch `data` und rechnet im Browser. Sie zeigt, wie viele Züge planmäßig und wie viele mit gestrichenen Halten gefahren sind (gesamt, pro Tag und je Zug im Tagesverlauf), die Verteilung des Vorlaufs, eine Liste aller Züge und den Zustand des Sammlers. Ein Zug gilt als planmäßig, wenn keiner seiner Halte in Roth und Nürnberg Hbf gestrichen wurde. Die Rechenlogik liegt in `docs/report.js`.

Lokal ansehen (aus dem Repo-Ordner, mit Daten in `data/`):

```bash
python3 -m http.server 8000
# dann http://localhost:8000/docs/ öffnen; andere Datenquelle: ?src=<Ordner oder URL>
```

## Dateien auf dem Branch `data`

| Datei | Inhalt |
|---|---|
| `events.csv` | Alle erkannten Änderungen (Hauptergebnis) |
| `runs.csv` | Protokoll der Läufe (Halte, Ereignisse, Fehler, Anfragen) |
| `snapshots/JJJJ-MM-TT.jsonl` | Soll und Änderung im Wortlaut der API, ein Eintrag je Ereignis (Beweissicherung) |
| `state/` | Geladener Sollfahrplan und letzter Stand je Halt (intern) |

## Lokal ausführen

Voraussetzung ist Node.js ≥ 20.12.

```bash
npm install
node collect.mjs   # schreibt nach data/
npm test           # Offline-Test mit simulierten Daten
```

Die Zugangsdaten liest das Skript aus der Datei `.env` im Repo-Ordner. Sie steht in `.gitignore` und gelangt nicht nach GitHub:

```
DB_CLIENT_ID=...
DB_API_KEY=...
```

`config.json` enthält Bahnhöfe, Linie und Abfrageparameter. Findet der Sammler an einem Bahnhof keinen Halt der Linie, gibt er aus, welche Linien er gesehen hat; passe dann `categories` und `line` an.

## Alternativen zum Dauerbetrieb

Die offizielle API lässt sich von überall abfragen. GitHub Actions genügt deshalb; geplante Läufe starten dort zwar oft 5–30 Minuten verspätet, der Streichungszeitpunkt stammt aber von der DB und bleibt exakt. Wer lieber einen eigenen Rechner nutzt (LNT-Server, Raspberry Pi, Mietserver), braucht nur einen Cron-Eintrag:

```bash
git clone git@github.com:frederikwalter/RE1-Monitor.git && cd RE1-Monitor && npm ci
git worktree add data origin/data
crontab -e
```

```cron
7 * * * * cd $HOME/RE1-Monitor && DB_CLIENT_ID=xxx DB_API_KEY=yyy node collect.mjs >> cron.log 2>&1; cd data && git add -A && git commit -qm "Daten $(date '+\%F \%H:\%M')" && git push -q origin HEAD:data
```

Schalte in diesem Fall den Workflow unter *Actions* ab, damit nicht zwei Sammler auf denselben Branch schreiben.

## Grenzen

- Der Sollfahrplan ist nur rund einen Tag im Voraus abrufbar. Das Tool belegt also, wann eine Streichung angelegt wurde, aber nicht, dass der Halt schon Tage vorher im Fahrplan stand. Wie weit die API tatsächlich vorausreicht, zeigt jeder Lauf im Log („Sollfahrplan bis +… h“).
- Streichungen, die erst nach der planmäßigen Abfahrt angelegt werden, erfasst das Tool nicht. Die API entfernt alte Änderungen wieder; vergangene Halte bleiben deshalb auf ihrem letzten Stand.
- Fehlt bei einer Streichung das Feld `clt`, steht in der Auswertung der Zeitpunkt des ersten Abrufs (mit `*` markiert, Genauigkeit eine Stunde).
- Läuft der Sammler länger als etwa einen Tag nicht, fehlen die Halte dieser Zeit.
- GitHub schaltet geplante Workflows ab, wenn ein Repository 60 Tage lang keine Aktivität zeigt.
