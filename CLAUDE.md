# hide&seek

Statische PWA (HTML/CSS/JS-Module ohne Build), ausgeliefert über GitHub Pages von `main` / Root. Backend: Supabase-Projekt „hideseek“.

- Bei Änderungen an App-Dateien `CACHE` in `sw.js` und `VERSION`/`VERSION_DATE` in `js/version.js` hochzählen (Startseite zeigt die Version).
- Datenbank: `supabase/migrations/`. Interne Funktionen im Schema `hs`, öffentliche RPCs in `public`; Tabellen haben RLS ohne Policies.
- Oberer Rand (iOS-PWA vom Homescreen), bewährt aus mhuhn/voka und mhuhn/tourwetter:
  Statusleiste `default` (nicht `black-translucent`); `html`-Hintergrund = Kopfleistenfarbe = `theme-color` =
  Manifest `background_color`/`theme_color` (#ff6b35); `body` ist `position: fixed; inset: 0`, gescrollt wird nur in `<main>`;
  die Kopfleiste ist `position: fixed`, voll breit, einfarbig deckend. Kein sticky Header über scrollendem Dokument,
  keine Transparenz/Blur an der oberen Kante – sonst blendet iOS einen verwaschenen Verlauf ein.
- Aufräumen: Edge Function `supabase/functions/cleanup-old-games` löscht täglich (pg_cron-Job `hideseek-cleanup`, 03:17 UTC)
  Spiele, deren letzte Aktivität älter als 7 Tage ist, samt Fotos; Foto-Ordner ohne Spiel ebenfalls.
- Fotos werden in `js/photo.js` vor dem Upload auf max. 1280 px und unter ~250 KB gebracht; Bucket-Limit 1 MB.
- Funktionen mit `delete` lösen in Supabase eine Bestätigung aus, die die App des Nutzers abbricht.
  Standorte daher nur über `hs._clear_positions` löschen; neue Löschbefehle als SQL für den SQL Editor ausgeben.
