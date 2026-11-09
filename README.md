# hide&seek

Ein Versteckspiel für draußen, als Progressive Web App (PWA). Eine Partei versteckt sich, die anderen suchen sie und holen sich über die App Hinweise. Zielgruppe: Kinder ab 10 und Erwachsene.

Backend: [Supabase](https://supabase.com).

**Status:** In Planung – die Spielregeln werden gerade festgelegt, die App-Logik folgt.

## Icons

Logo „Gucker-&“ in `icons/`:

| Datei | Zweck |
|---|---|
| `icon.svg` | Logo, Vorlage (abgerundet) |
| `icon-192.png`, `icon-512.png` | PWA-Manifest (`purpose: any`) |
| `icon-maskable-192.png`, `icon-maskable-512.png` | PWA-Manifest (`purpose: maskable`, Android) |
| `apple-touch-icon.png` | iOS-Homescreen (180 × 180) |
| `favicon-32.png` | Browser-Tab |

Das „&“ ist aus Inter Display ExtraBold (SIL Open Font License) in einen Pfad umgewandelt, damit das Icon ohne Schriftart funktioniert.
