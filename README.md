# Nexory

**Nexory** is an Electron desktop music player with social rooms, shared playback, and a customizable “liquid glass” UI. The GitHub project repository is **[NexoryND](https://github.com/ioqeeqo-create/NexoryND)** (product name in the app: Nexory).

## Current release

- **Version:** 2.7.23 (see `package.json` for the exact value on your checkout).
- **Windows:** run `npm run build:win` to produce `dist/Nexory-Setup.exe` (installer) and `dist/Nexory-Portable.exe` (portable).

Publishing a GitHub Release with artifacts:

- **electron-builder** (needs `GH_TOKEN` with `repo` scope): `npm run release:win`
- **GitHub CLI** (after `npm run build:win`):  
  `gh release create v2.7.23 --repo ioqeeqo-create/NexoryND dist/Nexory-Setup.exe dist/Nexory-Portable.exe --title "Nexory 2.7.23" --generate-notes`

## Key features

- Yandex Music, VK, SoundCloud, Spotify (where supported), local playback.
- Social rooms: shared queue and playback sync.
- Visual settings: background blur/brightness, glass opacity and panel blur (including the home “Up next” queue).
- `.flowpreset` **export** stores the full `flow_*` snapshot; **import** only applies appearance: `flow_visual` fields `blur`, `bright`, `glass`, `panelBlur`, `bgType`, `customBg`, `gifMode`, `homeWidget` (e.g. Dotify visualizer image), plus `flow_track_covers` when present. Dotify **`.dotifypreset`** v2 uses `data.gifSettings[]` / `data.uiSettings` (older files use `data.gifs` / `data.ui`) — both are mapped on import.
- Default UI font: bundled pixel font in `assets/fonts/minecraft.ttf` (with webfont fallbacks). Replace that file if you want another look.

## Local development

```bash
npm install
npm start
```

The renderer is assembled from `renderer-src/`; `npm start` runs `merge-renderer` automatically via `prestart`.

## License

Project metadata uses the MIT license in `package.json`. Third-party fonts and trademarks belong to their respective owners.
