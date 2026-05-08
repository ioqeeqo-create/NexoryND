# Flow

Flow is an Electron desktop music player with social rooms, shared playback, and customizable UI.

## Current release

- App version: `2.6.6`
- Update channel: `stable` (`latest.yml` + installer artifacts)
- Social mode: cloud-first (`/social/flow-api/v1`)

## Key features

- Full player with lyrics/karaoke, playlists, likes, and profile customization
- Room listening with host controls and shared queue
- Multi-source music search (Yandex, VK, SoundCloud, Spotify fallback flow, etc.)
- Built-in app updater (check/download/install)
- Animated Flow-style UI with glass effects and visual modes

## Social/Room status (2.6.x line)

- Server-side friend presence (online/offline) from social backend
- Explicit host transfer + server election fallback
- Authoritative room queue synchronization and host-only transport control
- Invite flow and room member sync through cloud relay

## Local development

```bash
npm install
npm start
```

## Build (Windows)

```bash
npm run build:win
```

## Publish stable update artifacts

```bash
npm run publish:update:stable -- --host <host> --user <user> --port <port> --dir /var/www/flow-updates/stable
```
