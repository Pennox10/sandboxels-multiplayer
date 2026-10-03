# Sandboxels Multiplayer Mod

Mehrere Spieler bearbeiten **gleichzeitig dieselbe Sandboxels-Welt**: Jeder kann malen, radieren, Werkzeuge benutzen – alle sehen live dasselbe, inkl. der Cursor der anderen (mit Name und gewähltem Element).

Kein eigener Server nötig: Die Verbindung läuft direkt zwischen den Browsern (WebRTC über [PeerJS](https://peerjs.com)).

## Installation

Die Mod muss über eine **URL** erreichbar sein, damit Sandboxels sie laden kann:

1. `multiplayer.js` in ein (öffentliches) GitHub-Repository hochladen.
2. URL über jsDelivr bauen:
   `https://cdn.jsdelivr.net/gh/<github-name>/<repo>@main/multiplayer.js`
3. In Sandboxels: **Mods** → URL einfügen → Enter → Seite neu laden.

Alle Mitspieler müssen die Mod installiert haben.

**Alternative ohne Hosting (zum schnellen Testen):** Sandboxels öffnen, F12 → Konsole, den kompletten Inhalt von `multiplayer.js` einfügen und Enter drücken. (Muss nach jedem Neuladen wiederholt werden.)

## Benutzung

1. Unten in der Leiste auf **Multiplayer** klicken.
2. Namen eintragen.
3. **Host:** „Raum erstellen“ → Es erscheint ein 5-stelliger Code (z. B. `9UDK2`). Code an Freunde schicken.
4. **Mitspieler:** Code eingeben → „Beitreten“.

Tipp: Mit `?mpjoin=CODE` an der Sandboxels-URL tritt man automatisch einem Raum bei.

## Was synchronisiert wird

| Funktioniert | Hinweis |
|---|---|
| Elemente platzieren (Linksklick), Radieren (Rechtsklick) | inkl. Pinselgröße, Linien mit Shift, Ersetzen-Modus |
| Werkzeuge (Heizen, Kühlen, Mixen, Schocken, Bemalen …) | werden beim Host ausgeführt |
| Pause / Weiter, Zurücksetzen | von jedem Spieler aus |
| Cursor aller Spieler | mit Name + Element |
| Temperatur, Ladung, Brennen, Farben | Temperatur in 3°-Schritten |

**Einschränkungen**

- Der **Host** simuliert die Welt. Verlässt der Host den Raum, ist das Spiel für alle beendet (jeder behält aber den letzten Stand der Welt).
- Nur der Host kann **Spielstände laden**; Bilder einfügen und Spezial-Werkzeuge mit eigener Maus-Logik (z. B. „Ziehen“) funktionieren nur beim Host.
- Alle sollten **dieselben Mods** aktiv haben. Elemente, die der Host nicht kennt, kann ein Mitspieler nicht platzieren.
- Die Weltgröße richtet sich nach dem Host.
- In seltenen Netzwerken (strenge Firmen-/Uni-Firewalls) kann WebRTC blockiert sein – dann kommt keine Verbindung zustande.

## Technik (kurz)

- Mitspieler simulieren nicht selbst. Ihre Maus-Aktionen werden an den Host gesendet und dort mit den originalen Sandboxels-Funktionen ausgeführt.
- Der Host schickt 20× pro Sekunde nur die **geänderten Pixel** binär (13 Byte pro Pixel) an alle; neue Spieler bekommen zuerst einen kompletten Schnappschuss.
- Ist ein Mitspieler zu langsam, werden Updates übersprungen und danach ein vollständiger Schnappschuss nachgeschickt.
