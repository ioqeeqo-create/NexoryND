# Flow Import Server (VK + Yandex)

## 1) Install Node.js + PM2 (Ubuntu)

```bash
sudo apt update
sudo apt install -y curl git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm i -g pm2
node -v
npm -v
```

## 2) Upload project and install deps

```bash
cd /opt
sudo git clone https://github.com/ioqeeqo-create/FlowPleerLoww.git flow
sudo chown -R $USER:$USER /opt/flow
cd /opt/flow
npm ci
```

## 3) Create server env file

```bash
cat > /opt/flow/.env <<'EOF'
HOST=0.0.0.0
PORT=8787

# Optional VK token
VK_ACCESS_TOKEN=

# VK session cookie string from logged in browser
VK_COOKIE=

# Optional Yandex OAuth token
YANDEX_TOKEN=

# Yandex session cookie string from logged in browser
YANDEX_COOKIE=
EOF
```

## 4) Run import server with PM2

```bash
cd /opt/flow
pm2 start server/flow-vk-server.js --name flow-import-server
pm2 save
pm2 startup
```

## 5) Open firewall port

```bash
sudo ufw allow 8787/tcp
sudo ufw status
```

## 6) Check server health

```bash
curl http://127.0.0.1:8787/health
```

Expected JSON includes:
- `vkServerToken`
- `vkCookie`
- `yandexToken`
- `yandexCookie`

## 7) Test endpoints

### VK

```bash
curl -X POST http://127.0.0.1:8787/vk/playlist \
  -H "Content-Type: application/json" \
  -d '{"url":"https://vk.com/music/playlist/-2000000001_1"}'
```

### Yandex

```bash
curl -X POST http://127.0.0.1:8787/yandex/playlist \
  -H "Content-Type: application/json" \
  -d '{"url":"https://music.yandex.ru/users/USER/playlists/123"}'
```

### Universal endpoint

```bash
curl -X POST http://127.0.0.1:8787/import/playlist \
  -H "Content-Type: application/json" \
  -d '{"url":"https://music.yandex.ru/users/USER/playlists/123"}'
```

## 8) Connect app to server

In Flow settings, set `proxyBaseUrl` to:

```text
http://YOUR_SERVER_IP:8787
```

Then use "Импорт" from playlist link in app.

## 9) One-command server update

```bash
cd /opt/flow
chmod +x server/update-flow-import-server.sh
APP_DIR=/opt/flow BRANCH=cursor/liquid-glass-room-widget-0756 SERVICE_NAME=flow-import-server ./server/update-flow-import-server.sh
```

Optional alias:

```bash
echo "alias flow-update='APP_DIR=/opt/flow BRANCH=cursor/liquid-glass-room-widget-0756 SERVICE_NAME=flow-import-server /opt/flow/server/update-flow-import-server.sh'" >> ~/.bashrc
source ~/.bashrc
```
