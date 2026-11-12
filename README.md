# RE1-Monitor

Dieses Tool sammelt Belege dafür, wie der RE1 (München – Ingolstadt – Nürnberg) während der Sperrung der Schnellfahrstrecke vom 30.10. bis 12.12.2026 tatsächlich fährt: Wie viele Züge halten wie geplant in Roth und Nürnberg Hbf, wie viele enden stattdessen in Treuchtlingen, wie kurzfristig streicht die DB die Halte, und wie verspätet sind die Züge? Ziel ist eine belastbare Grundlage für eine Beschwerde.

Ein GitHub-Actions-Workflow fragt die DB jede Stunde ab und legt die Ergebnisse auf dem Branch `data` ab. Die Auswertung steht als Webseite bereit: <https://frederikwalter.github.io/RE1-Monitor/>

## Wie es funktioniert

Quelle ist die offizielle **Timetables-API** der DB (intern „IRIS“) aus dem DB API Marketplace. Der Zugang ist kostenlos, braucht aber einen API-Key. Die API kennt nur Bahnhöfe, keine einzelnen Züge. `collect.mjs` lädt deshalb für Roth und Nürnberg Hbf (beobachtete Halte) sowie Treuchtlingen (Verbleib umgeleiteter Züge, Umstieg auf Pendelzüge)

1. den **Sollfahrplan** der nächsten 24 Stunden (`/plan`, jede Stundenscheibe nur einmal) und
2. alle bekannten **Änderungen** (`/fchg`),

filtert die Halte der Linie RE1 heraus und vergleicht sie mit dem letzten Lauf. Halte, die nur in den Änderungen stehen, werden mit aufgenommen. Das betrifft etwa den zusätzlichen Halt eines umgeleiteten Zuges in Treuchtlingen oder einen kurzfristig eingesetzten Pendelzug Treuchtlingen – Roth – Nürnberg. Jede Änderung landet in `events.csv`, zusammen mit
- der Verspätung (`delay_min`),
- den Meldungscodes der DB (`messages`),
- dem Hinweis, ob der Zug an diesem Halt endet oder beginnt (`terminus`),
- Ankunft und Abfahrt jeweils als Soll, Ist und Gleis (`arrival_*`, `departure_*`, `platform_*`).

In Treuchtlingen wird jede Änderung der Verspätung ab 1 Minute protokolliert, in Roth und Nürnberg ab 5 Minuten. In Treuchtlingen entscheidet jede Minute darüber, ob der Umstieg klappt.

Nach der Sollzeit verfolgt der Sammler einen Halt noch bis zu 6 Stunden weiter, solange die API ihn liefert; so wird die Endverspätung erfasst. Ein Halt in Roth oder Nürnberg, der erst nach seiner Abfahrt auftaucht, wird dagegen nicht aufgenommen, weil die DB den Anlagezeitpunkt einer Streichung manchmal nachträglich aktualisiert.

Zu jeder Streichung liefert die API das Feld `clt`: den Zeitpunkt, zu dem die DB die Streichung in ihrem System angelegt hat. Der Vorlauf (`lead_time_h`) ist der Abstand zwischen diesem Zeitpunkt und der planmäßigen Abfahrt. Er hängt nicht davon ab, wann das Skript läuft.

### Erkannte Ereignisse

| Ereignis | Bedeutung |
|---|---|
| `ERSTMALS_GESEHEN` | Halt taucht zum ersten Mal im Sollfahrplan auf; Status zu diesem Zeitpunkt |
| `HALT_GESTRICHEN` | Ankunft und Abfahrt sind gestrichen |
| `HALT_TEILWEISE_GESTRICHEN` | Nur Ankunft oder nur Abfahrt ist gestrichen (Zug endet oder beginnt hier) |
| `HALT_WIEDERHERGESTELLT` | Streichung zurückgenommen |
| `LAUFWEG_GEAENDERT` | Geänderter Laufweg bei gleichem Status, z. B. Zug endet nun hier |
| `VERSPAETUNG` | Verspätung hat sich seit dem letzten Eintrag um mindestens 5 Minuten geändert (Treuchtlingen: 1 Minute) |

### Warum nicht bahn.de?

Die erste Fassung fragte die Schnittstelle von bahn.de / DB Navigator ab, weil sie den Fahrplan Tage im Voraus zeigt. Die DB schützt sie seit Mai 2026 gegen automatische Abfragen (Antwort `OPS_BLOCKED`), auch von GitHub aus. Eine Suche nach einzelnen Zugnummern bietet nur die API *RIS::Journeys*; sie ist kostenpflichtig und wird erst nach einer Prüfung durch die DB freigeschaltet.

## Einrichtung auf GitHub

1. Das Repository muss **öffentlich** sein. Nur dann sind GitHub Pages und unbegrenzte Actions-Minuten kostenlos, und nur dann kann die Seite die Daten lesen.
2. API-Key holen: Auf <https://developers.deutschebahn.com> registrieren, eine Anwendung anlegen und die API **„Timetables“** abonnieren.
3. Client-ID und API-Key unter *Settings → Secrets and variables → Actions* als `DB_CLIENT_ID` und `DB_API_KEY` eintragen.
4. *Settings → Pages*: Quelle „Deploy from a branch“, Branch `main`, Ordner `/docs`.
5. *Actions → RE1-Monitor → Run workflow* startet den ersten Lauf. Danach läuft der Workflow stündlich. Den Branch `data` legt er selbst an.

## Auswertung

Die Seite `docs/index.html` lädt `events.csv` und `runs.csv` vom Branch `data` und rechnet im Browser (Darstellung in `docs/app.js`, Rechenlogik in `docs/report.js`). Sie enthält:

- eine **Zusammenfassung** als Fließtext zum Kopieren, mit Gegenüberstellung von Ankündigung und Beobachtung, und eine Druckfassung („Drucken / als PDF speichern“);
- einen Abschnitt **Strecke und Sperrung** mit der Presseinformation der DB vom 09.10.2026 und Presseberichten als Quellen;
- Kennzahlen, Züge pro Tag, einen **Kalender** (jeder Zug an jedem Tag) und Kreisdiagramme je Zug;
- den **Umstieg in Treuchtlingen**: welche Züge einen Pendelzug hatten, ob der Umstieg erreichbar war (je Verbindung und Tag), geplante und tatsächliche Umstiegszeit, Gleise (auch als CSV);
- Vorlauf der Streichungen, gemeldete **Gründe**, **Verspätungen**;
- eine Tabelle aller Züge (auch als CSV herunterladbar), **Datenqualität** (Erfassungslücken) und **Methodik**.

Ein Filter für Zeitraum, Wochentage und Hauptverkehrszeit wirkt auf alle Abschnitte.

**Begriffe:** *Durchgehender Zug* – Laufweg laut Fahrplan über München oder Ingolstadt. *Pendelzug* – nur Treuchtlingen–Nürnberg, wird getrennt gezählt. *Planmäßig* – kein Halt in Roth oder Nürnberg Hbf gestrichen. *Endet/beginnt in Treuchtlingen* – Halte gestrichen, Zug hält aber in Treuchtlingen. *Umstieg* – Jedem in Treuchtlingen endenden (bzw. beginnenden) durchgehenden Zug wird der Pendelzug derselben Richtung mit der nächstgelegenen Sollzeit zugeordnet, höchstens 30 Minuten entfernt. Pendelzüge erkennt das Tool selbst, Zugnummern sind nicht hinterlegt. *Erreichbar* heißt: Der Anschlusszug fuhr laut letzter Meldung der DB nicht vor der Ankunft des Zubringers ab (Mindestumstiegszeit 0 Minuten, `MIN_TRANSFER_MIN` in `docs/report.js`).

**Meldungscodes:** Die DB veröffentlicht keine Liste. Die Klartexte stammen aus dem Open-Source-Projekt [Travel::Status::DE::IRIS](https://github.com/derf/Travel-Status-DE-IRIS) und sind nicht amtlich.

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

Die offizielle API lässt sich von überall abfragen. GitHub Actions genügt deshalb; geplante Läufe starten dort zwar oft 5–30 Minuten verspätet und fallen unter Last gelegentlich ganz aus, der Streichungszeitpunkt stammt aber von der DB und bleibt exakt. Bei einem neuen Repository kann es einige Stunden dauern, bis der Zeitplan greift. Wer lieber einen eigenen Rechner nutzt (Raspberry Pi, Mietserver), braucht nur einen Cron-Eintrag:

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
- Änderungen erfasst das Tool bis höchstens 6 Stunden nach der Sollzeit und nur, solange die API sie liefert; danach bleibt der letzte Stand stehen.
- Die Aufzeichnung beginnt am 12.11.2026. Züge davor sind nicht erfasst; eine erste Testphase vom selben Tag wurde verworfen.
- Die Ist-Zeit eines Umstiegs ist die letzte Meldung der DB, die der stündliche Sammler gesehen hat. Liefert die API einen Zug nach seiner Abfahrt nicht mehr, kann das eine Prognose von bis zu einer Stunde vor der Abfahrt sein.
- Fehlt bei einer Streichung das Feld `clt`, steht in der Auswertung der Zeitpunkt des ersten Abrufs (mit `*` markiert, Genauigkeit eine Stunde).
- Läuft der Sammler länger als etwa einen Tag nicht, fehlen die Halte dieser Zeit.
- GitHub schaltet geplante Workflows ab, wenn ein Repository 60 Tage lang keine Aktivität zeigt.

## Beschwerde

Der RE1 gehört zum Verkehrsvertrag „München-Nürnberg-Express/Ringzug West“. Besteller ist die **Bayerische Eisenbahngesellschaft (BEG)** im Auftrag des Freistaats Bayern, Betreiber ist **DB Regio Bayern**. Ein fester Beschwerdeweg mit vorgegebenen Nachweisen ist öffentlich nicht beschrieben; den passenden Kanal findest du auf den Seiten der BEG und von DB Regio. Als Anlage eignen sich die Druckfassung der Seite und die CSV-Datei aus der Tabelle „Alle Züge“.
