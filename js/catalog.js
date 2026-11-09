// Fragen und Blockaden. Kosten und automatische Antworten stehen zusätzlich in
// der Datenbank (Funktionen _question_cost / ask_question) – beides synchron halten.

// type: auto = App beantwortet sofort, suggest = App schlägt vor, Hider kann korrigieren,
//       photo = Hider schickt ein Foto, yesno = Hider antwortet Ja/Nein, text = Freitext
export const CATEGORIES = [
  {
    id: 'relativ', name: 'Relativ', cost: 7,
    questions: [
      { key: 'ns', type: 'auto', text: 'Seid ihr nördlich oder südlich von uns?' },
      { key: 'ew', type: 'auto', text: 'Seid ihr östlich oder westlich von uns?' },
      { key: 'district', type: 'auto', needs: 'districts', text: 'Sind wir im selben Stadtteil?' },
      ...[1, 2, 3, 4].map((i) => ({
        key: 'place' + i, type: 'auto', place: i - 1,
        text: (g) => `Sind wir näher an ${g.places[i - 1]?.name} als ihr?`,
      })),
    ],
  },
  {
    id: 'entfernung', name: 'Entfernung', cost: 6,
    questions: [1000, 500, 300, 150, 75, 30].map((m) => ({
      key: 'd' + m, type: 'auto',
      text: `Sind wir max. ${m >= 1000 ? '1 km' : m + ' m'} von euch entfernt?`,
    })),
  },
  {
    id: 'foto', name: 'Foto', cost: 3,
    questions: [
      { key: 'tallest', type: 'photo', text: 'Schick ein Foto vom höchsten Gebäude, das ihr von eurem Standort aus sehen könnt' },
      { key: 'buildings5', type: 'photo', text: 'Schick ein Foto, auf dem mindestens 5 Gebäude zu sehen sind' },
      { key: 'trees5', type: 'photo', text: 'Schick ein Foto mit mindestens 5 Bäumen, von jedem Baum muss ein Teil vom Stamm zu sehen sein' },
      { key: 'stop', type: 'photo', text: 'Schick ein Foto von der nächsten Straßenbahn- oder Bushaltestelle' },
      { key: 'restaurant', type: 'photo', text: 'Schick ein Foto vom nächsten Restaurant' },
    ],
  },
  {
    id: 'endspiel', name: 'Endspiel', cost: 3, endgame: true,
    questions: [
      { key: 'street_letters', type: 'suggest', text: 'Wie viele Buchstaben hat die Straße, die euch am nächsten ist?' },
      { key: 'selfie', type: 'photo', facing: 'user', text: 'Schickt ein Selfie von einer von euch mit komplett ausgestrecktem Arm' },
      { key: 'photo_up', type: 'photo', text: 'Schickt ein Foto, das gerade nach oben zeigt' },
      { key: 'photo_down', type: 'photo', text: 'Schickt ein Foto, das nach unten zeigt' },
      { key: 'same_street', type: 'suggest', yesno: true, text: 'Seid ihr in derselben Straße wie wir?' },
      { key: 'street_dist', type: 'suggest', text: 'Gerundet auf 5 m, wie weit seid ihr von der nächsten Straße entfernt?' },
      { key: 'dist25', type: 'auto', text: 'Gerundet auf 25 m, wie weit seid ihr von uns weg?' },
      { key: 'seen', type: 'yesno', text: 'Habt ihr uns schon gesehen oder gehört?' },
    ],
  },
];

export const QUESTIONS = Object.fromEntries(
  CATEGORIES.flatMap((c) => c.questions.map((q) => [q.key, { ...q, category: c.id, cost: c.cost }])),
);

export function questionText(key, game) {
  const q = QUESTIONS[key];
  if (!q) return key;
  return typeof q.text === 'function' ? q.text(game) : q.text;
}

/** Ist die Frage in diesem Spiel überhaupt verfügbar? */
export function questionAvailable(q, game) {
  if (q.needs === 'districts' && !game.has_districts) return false;
  if (q.place !== undefined && !game.places?.[q.place]) return false;
  return true;
}

// Dauer in Minuten bei Blockaden mit Timer; done = Seeker bestätigen selbst
export const BLOCKADES = {
  1: { name: 'Nichts', text: 'Pech gehabt – diesmal gibt es keine Blockade.' },
  2: { name: 'Auswahl', text: 'Beim nächsten Wurf gegen dieses Team dürft ihr auch die Zahl davor oder danach nehmen.' },
  3: { name: 'Fitness Check', done: 'Liegestütze geschafft',
       text: 'Haltet an und macht durchschnittlich 10 Liegestütze pro Person am Stück – beliebig untereinander aufgeteilt.' },
  4: { name: 'Säubern', done: 'Müll ist entsorgt',
       text: 'Jeder von euch hebt ein weggeworfenes Stück Müll auf und entsorgt es.' },
  5: { name: 'Duftende Rosen', minutes: 2, note: true,
       text: 'Findet eine Blume und genießt 2 Minuten lang ihren Duft. Schreibt den Hidern eine dabei gewonnene Erkenntnis.' },
  6: { name: 'Freeze', minutes: 2, text: 'Bleibt 2 Minuten lang stehen.' },
  7: { name: 'Maps', minutes: 5, text: 'Ihr dürft 5 Minuten lang keine Karten-App nutzen.' },
  8: { name: 'Zeichnen', done: 'Jemand hat richtig geraten', draw: true,
       text: (g) => `Einer von euch zeichnet ${g.landmark ? `„${g.landmark}“` : 'eine bekannte Sehenswürdigkeit in der Nähe'} mit dem Finger auf dem Handy. Schickt das Bild einer Person, die heute nicht mitspielt, und fragt, was das ist. Ist die Antwort falsch oder kommt nach 2 Minuten keine, fragt die nächste Person – so lange, bis jemand richtig rät.` },
  9: { name: 'Bank', done: 'Wir sitzen auf einer Bank',
       text: 'Eure nächste Frage müsst ihr von einer Sitzbank aus stellen. Setzt euch auf eine Bank, dann geht es weiter.' },
  10: { name: 'Apps', minutes: 5, text: 'Ihr dürft 5 Minuten lang keine Karten-Apps und keinen Browser nutzen.' },
  11: { name: 'Bonus', text: 'Nochmal gewürfelt und zwei Augen dazu.' },
  12: { name: 'Flucht', minutes: 2, endgame: true,
        text: 'Schließt 2 Minuten lang die Augen. Die Hider dürfen sich in der Zeit innerhalb der Zielzone ein neues Versteck suchen.' },
};

export function blockadeText(value, game) {
  const b = BLOCKADES[value];
  if (!b) return '';
  return typeof b.text === 'function' ? b.text(game) : b.text;
}

export const DIE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
