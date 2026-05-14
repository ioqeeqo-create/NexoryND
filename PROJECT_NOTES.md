# Nexory — Project Notes (2.6.6)

## Scope
Nexory is an Electron desktop player with:
- multi-source search/playback
- cloud social layer (friends, presence, rooms)
- shared room queue and host-controlled synchronized playback
- built-in stable updater (`latest.yml` + installer artifacts)

## Runtime structure
- `main.js` — Electron main process, native bridges, updater flow
- `preload.js` — IPC bridge (`window.api.*`)
- `renderer.js` — shipped runtime UI/player/social logic
- `renderer-src/*` — source modules merged into `renderer.js`
- `server/flow-social-server.js` — cloud social backend (REST+WS, SQLite)

## Current release line
- Current app version in repo: `2.6.6`
- Social mode: cloud-first (`/social/flow-api/v1`)
- Stable updates: published via `scripts/publish-stable-update.cjs`

## 2.6.x key fixes summary
- Presence:
  - mutual friend visibility restored server-side
  - accepted friend requests create both directions
  - cloud presence endpoint used as source of truth
- Rooms:
  - host election and host transfer hardened
  - queue sync stabilized (authoritative channels only)
  - guest playback recovery on host sync
  - host-only transport control enforcement
- My Wave:
  - source selector (Yandex/VK) restored in shipped runtime renderer
  - mode controls adapt to selected source

## Build and publish
```bash
npm install
npm run build:win
npm run publish:update:stable -- --host <host> --user <user> --port <port> --dir /var/www/flow-updates/stable
```

## Deployment notes (social backend)
- Service unit currently runs:
  - `ExecStart=/usr/bin/node /opt/flow/server/flow-social-server.js`
- Nginx must proxy:
  - `/social/ -> http://127.0.0.1:3847/`
- Nginx serves updater artifacts:
  - `/flow-updates/ -> /var/www/flow-updates/`

## Known operational checks
- API health:
  - `GET /flow-api/v1/health`
- Presence sanity:
  - `GET /flow-api/v1/presence/friends/:owner`
- Update feed sanity:
  - `GET /flow-updates/stable/latest.yml`
