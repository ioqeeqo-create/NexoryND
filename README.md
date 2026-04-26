# FlowPleerLoww

FlowPleerLoww is a desktop music player built with Electron, focused on style, social listening, and flexible customization.

## Highlights

- Beautiful fullscreen player with synchronized lyrics and karaoke mode
- Social rooms for listening with friends in real time
- Shared room queue with host controls
- Playlist management, editing, and drag-and-drop sorting
- VK playlist import and multi-source search integrations
- Profile customization: avatar, banner, pinned tracks/playlists
- Extensive UI customization (accents, blur, glass, scale, covers, GIF support)

## Tech Stack

- Electron
- Vanilla JavaScript
- HTML/CSS
- PeerJS

## Run Locally

```bash
npm install
npm start
```

## Build

```bash
npm run build:win
```

## Optional: Edge Server (VPS)

You can run a lightweight server on VPS to offload non-critical realtime/cache tasks from desktop clients:

- Cover image proxy + disk cache (`/cover?u=...`)
- Presence heartbeat API (`/presence/heartbeat`, `/presence`)
- Room transient state API (`/rooms/:id/state`)

Run locally:

```bash
npm run start:edge
```

Production (example):

```bash
PORT=8787 HOST=0.0.0.0 node server/flow-edge-server.js
```

Then in Flow Settings set `proxyBaseUrl` to your VPS endpoint (e.g. `http://<server-ip>:8787`).
This enables cover fetching via server cache and reduces repeated direct image downloads from clients.

---

Made with love for Flow users.
