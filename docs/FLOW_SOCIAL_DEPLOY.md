# Flow Social backend deploy

## 0) Важно: файл на сервере

Сервис стартует только если существует **`server/flow-social-server.js`**. Если на VPS после `git pull` его нет — значит ветка на GitHub без этих коммитов: сделай `git push` с машины разработчика или скопируй файл вручную (`scp`).

Репозиторий из `package.json`: `https://github.com/ioqeeqo-create/FlowPleerLoww.git`

## 1) Environment

Required:

- `FLOW_SOCIAL_SECRET` - long random shared bearer secret.

Optional:

- `FLOW_SOCIAL_PORT` - default `3847`.
- `FLOW_SOCIAL_DB_PATH` - default `./data/flow-social.sqlite`.

Example:

```bash
FLOW_SOCIAL_SECRET="replace-with-long-random-string"
FLOW_SOCIAL_PORT=3847
FLOW_SOCIAL_DB_PATH="/opt/flow/data/flow-social.sqlite"
```

## 2) Local run

```bash
npm install
npm run social-server
```

Health checks:

- `GET /health`
- `GET /flow-api/v1/health`

WebSocket endpoint:

- `/flow-api/ws`

### Без домена (только IP)

- В фаерволе/VPS открой TCP **3847** (или твой `FLOW_SOCIAL_PORT`).
- Nginx с путями Let’s Encrypt **не нужен**; если уже ломал `nginx -t`, убери битый `sites-enabled` и `reload nginx`.
- В приложении: `flowSocialApiBase` = `http://<ПУБЛИЧНЫЙ_IP>:3847`, секрет как в `.env.social`.

Проверка на самой машине:

```bash
curl -s http://127.0.0.1:3847/health
```

## 3) Reverse proxy (Nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name flow-social.example.com;

    ssl_certificate     /etc/letsencrypt/live/flow-social.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/flow-social.example.com/privkey.pem;

    location /flow-api/ws {
        proxy_pass http://127.0.0.1:3847/flow-api/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

    location / {
        proxy_pass http://127.0.0.1:3847;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 4) Reverse proxy (Caddy)

```caddyfile
flow-social.example.com {
    reverse_proxy /flow-api/ws 127.0.0.1:3847
    reverse_proxy 127.0.0.1:3847
}
```

## 5) Process manager

### systemd

```ini
[Unit]
Description=Flow Social Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/flow/flow_fixed
Environment=FLOW_SOCIAL_SECRET=replace-with-long-random-string
Environment=FLOW_SOCIAL_PORT=3847
ExecStart=/usr/bin/node /opt/flow/flow_fixed/server/flow-social-server.js
Restart=always
RestartSec=3
User=flow
Group=flow

[Install]
WantedBy=multi-user.target
```

### pm2

```bash
pm2 start server/flow-social-server.js --name flow-social --cwd /opt/flow/flow_fixed --env production
pm2 save
pm2 startup
```

## 6) Client settings

In app settings (or localStorage mirror), set:

- `flowSocialApiBase`: `https://flow-social.example.com`
- `flowSocialApiSecret`: same value as `FLOW_SOCIAL_SECRET`

If your page is HTTPS, `ws://` will be upgraded through proxy to `wss://` automatically by browser rules and reverse proxy setup.

## 7) Optional migration from Supabase exports

Use migration script:

```bash
node server/migrate-supabase-export-to-sqlite.js --input ./supabase-export --db ./data/flow-social.sqlite
```

Accepted per-table files in `--input`:

- `flow_profiles.(json|csv|ndjson)`
- `flow_friends.(json|csv|ndjson)`
- `flow_friend_requests.(json|csv|ndjson)`
- `flow_rooms.(json|csv|ndjson)`
- `flow_room_members.(json|csv|ndjson)`
