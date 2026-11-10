# hide&seek

Statische PWA (HTML/CSS/JS-Module ohne Build), ausgeliefert über GitHub Pages von `main` / Root. Backend: Supabase-Projekt „hideseek“.

- Bei Änderungen an App-Dateien `CACHE` in `sw.js` und `VERSION`/`VERSION_DATE` in `js/version.js` hochzählen (Startseite zeigt die Version).
- Datenbank: `supabase/migrations/`. Interne Funktionen im Schema `hs`, öffentliche RPCs in `public`; Tabellen haben RLS ohne Policies.
- Oberer Rand (iOS-PWA vom Homescreen), bewährt aus mhuhn/voka und mhuhn/tourwetter:
  Statusleiste `default` (nicht `black-translucent`); `html`-Hintergrund = Kopfleistenfarbe = `theme-color` =
  Manifest `background_color`/`theme_color` (#ff6b35); `body` ist `position: fixed; inset: 0`, gescrollt wird nur in `<main>`;
  die Kopfleiste ist `position: fixed`, voll breit, einfarbig deckend. Kein sticky Header über scrollendem Dokument,
  keine Transparenz/Blur an der oberen Kante – sonst blendet iOS einen verwaschenen Verlauf ein.
