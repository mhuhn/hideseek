# hide&seek

Ein Versteckspiel für draußen, als Progressive Web App (PWA). Eine Partei versteckt sich im Spielfeld, die anderen suchen sie und stellen über die App Fragen. Die Hider bekommen dafür Münzen und würfeln damit Blockaden gegen die Sucher. Zielgruppe: Kinder ab 10 und Erwachsene.

Läuft über GitHub Pages: <https://mhuhn.github.io/hideseek/>

## Spielablauf (Kurzfassung)

- **Spiel anlegen** (Spielleiter): Titel, optional Zeitraum, Spielerzahl, Spielfeld auf der Karte (Stadtteile antippen und/oder Flächen zeichnen/ausschneiden), bis zu 4 Orte für die Relativ-Fragen, eine Sehenswürdigkeit für „Zeichnen“, Versteckzeit, Zielzone, Antwortzeit. Die App erzeugt eine Spiel-ID aus 5 Hex-Ziffern.
- **Beitreten**: Spiel-ID und Name eingeben; der Name wird auf dem Gerät gespeichert.
- **Start**: unter 4 Spielern jeder für sich, über 6 in Teams, dazwischen wählt der Spielleiter. Die erste Hider-Partei wird ausgelost.
- **Runde**: alle bestätigen „bereit“ → Versteckzeit → Hider bestätigen das Versteck (sonst gilt die Position nach Ablauf) → Suche mit Fragen, Münzen, Würfeln und Blockaden → Endspiel, sobald ein Seeker-Team die Zielzone betritt → Fund mit Beweisfoto.
- **Wertung**: Hider 3 × Suchminuten, Finder 1 ×. Die Finder verstecken sich als Nächstes (oder eine zufällige Partei, die noch nicht dran war). Ende, wenn jede Partei einmal Hider war.

## Technik

- Reines HTML/CSS/JavaScript (ES-Module), kein Build-Schritt.
- Karte: [Leaflet](https://leafletjs.com) mit OpenStreetMap-Kacheln, Zeichnen mit [Leaflet-Geoman](https://geoman.io).
- Stadtteilgrenzen und Straßen aus OpenStreetMap (Nominatim, Overpass API).
- Backend: [Supabase](https://supabase.com) mit PostGIS. Anmeldung anonym.
  - Alle Tabellen haben RLS ohne Policies – Clients lesen nur über `get_state()` / `get_field()` und schreiben nur über RPC-Funktionen, die die Regeln prüfen. Seeker sehen die Position der Hider nie.
  - Zeitabhängige Übergänge (Versteckzeit, Antwortzeit, Blockade-Timer, Beginn des Endspiels) erledigt `_tick()` bei jeder Abfrage; die App fragt alle 3 Sekunden ab.
  - Fotos liegen im privaten Storage-Bucket `photos`, Ordner = Spiel-ID.

```
index.html, manifest.webmanifest, sw.js
css/app.css
js/app.js            Router
js/config.js         Supabase-URL und Publishable Key
js/sb.js             Supabase-Client, anonyme Anmeldung, rpc()
js/catalog.js        Fragen und Blockaden
js/geo.js, osm.js    Standort, Geometrie, OpenStreetMap
js/photo.js          Kamera, Upload, Zeichenfläche
js/views/            Startseite, Beitreten, Spiel anlegen, Spiel
supabase/migrations/ Datenbank-Schema und Spiellogik
icons/               App-Icons (Logo „Gucker-&“)
```

## Einrichtung Supabase

1. Migration `supabase/migrations/20261110000000_init.sql` im Projekt ausführen.
2. Unter *Authentication → Sign In / Providers* „Allow anonymous sign-ins“ einschalten.
3. Projekt-URL und Publishable Key in `js/config.js` eintragen.

## Icons

Das „&“ ist aus Inter Display ExtraBold (SIL Open Font License) in einen Pfad umgewandelt, damit das Icon ohne Schriftart funktioniert.
