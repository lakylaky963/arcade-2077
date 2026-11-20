# Night Lab // Arcade 2077

A browser arcade built from scratch: seven games, one shared profile, no frameworks, no build step.
Plain ES modules, canvas, WebAudio. English and Hebrew (RTL). Phone-first controls.

Live: https://avrahamarazi.com/game/ (also avraham.dev and the Tailscale Funnel address).

## Games

| Folder | Game |
|---|---|
| `defender/` | Homelab Defender: tower defense, 3 maps, 20 waves + Endless |
| `icebreaker/` | Icebreaker: survivor-style netrunner arena |
| `blackwall/` | Blackwall Defense: orbital missile defense |
| `neonvector/` | Neon Vector 2077: vertical shoot-'em-up with graze and Overdrive |
| `protocol/` | Breach Protocol: hex-matrix hacking roguelike |
| `overclock/` | Overclock // ICE Shatter: brick breaker with power-ups |
| `lightcycle/` | Lightcycle: buffered-turn arena |

`hub/` is the lobby: the live neon-city background (`bg.js`, drawn procedurally), game cards, Street Cred XP,
eddies (`€$`), trophies and leaderboards. `shared/` holds what every cabinet loads: the cyberpunk theme,
the hub SDK (profile, runs, trophies) and the cabinet skin (`cabinet.css/js`).

## WILDCARD // 2077 (in progress)

`wildcard-server/` is the Colyseus game server for the 8th cabinet, our Uno (game id `wildcard`). It is a
Node service, not static files: see [`wildcard-server/README.md`](wildcard-server/README.md). The phone client
`wildcard/` and the hub entry come in the next steps; nothing in the hub changes yet.

## How it fits the homelab

- Static files only. Served by nginx in its own LXC container (`CT 112 arcade`, `10.0.0.153`).
- CT 101 (`central-proxy`) routes `/game/` to that container and `/game/api/` to the dashboard (CT 105),
  which owns accounts, roles, scores and the audit log (MongoDB on CT 106). Same cookie, same origin.
- Guests can play without signing in; progress is then kept in the browser.

## Run locally

```sh
python3 -m http.server 8080      # then open http://localhost:8080/
node --test                      # game engines, hub logic, deploy guard, and wildcard-server's rules/match tests
```

Without the dashboard API the hub runs as a guest (the `/game/api/me` 401 in the console is expected).

## Deploy

`deploy.ps1` (Windows, SSH key to `root@server`) packs the site, pushes it into CT 112 and checks it.
It never ships `wildcard-server/` (the game server runs in its own container) and aborts if that folder
ends up in the archive.
Cloudflare caches JS/CSS in browsers for 4 hours, so when you change a shared file bump the `?v=` on the
entry points (`index.html`, each game's `index.html`, and the imports in `hub/`).

## Credits

Original code and art. Fonts: IBM Plex (self-hosted). Inspired by the cyberpunk genre; not affiliated with any game or studio.
