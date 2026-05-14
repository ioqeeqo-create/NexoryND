# Flow Yandex Music Helper

Small optional helper for importing Yandex Music playlists through `KM.Yandex.Music.Api`.

## Build

Install .NET 8 SDK, then run from `flow_fixed`:

```powershell
npm run build:yandex-helper
```

Flow auto-detects the published helper at:

```text
tools/flow-yandex-helper/bin/Release/net8.0/win-x64/publish/FlowYandexMusicHelper.exe
```

You can also point Flow to a custom build:

```powershell
$env:FLOW_YANDEX_HELPER_PATH="C:\path\to\FlowYandexMusicHelper.exe"
npm start
```

The OAuth token is passed via the `FLOW_YANDEX_TOKEN` environment variable by the Electron main process, not through command-line arguments.
