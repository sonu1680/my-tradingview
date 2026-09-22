# Deploying to your own server

This app parses five years of MT5 candles into memory once and keeps them there.
That wants a **long-running process with a disk** — which is exactly what an EC2
box is. No object storage, no database, no format conversion.

## Measured on the production build

| | |
|---|---|
| Memory, all 21 timeframes resident | **347 MB** RSS |
| First request for a timeframe (M15, 9.5 MB CSV) | 0.23 s |
| First request for M1 (140 MB CSV) | 2.9 s |
| Every request after that | 8–11 ms |
| Data on disk | 395 MB |
| Cold boot to serving | ~0.1 s (parsing is lazy, per timeframe) |

Parsing is **lazy and per-timeframe**: the process starts instantly and pays the
cost the first time a timeframe is asked for. Nothing re-parses afterwards, which
is the whole reason this belongs on a persistent server rather than serverless.

## Instance sizing

- **t3.small (2 GB)** — comfortable, what I'd pick.
- **t3.micro (1 GB)** — works; 347 MB app plus OS leaves room, but there is no
  slack if you later load a second symbol.
- **Disk**: 395 MB data + ~500 MB `node_modules` + ~50 MB build. 8 GB is plenty.

## Steps

```bash
# 1. Node 20+ on the box (built and tested against v20.19.6)
node -v

# 2. App code
sudo mkdir -p /opt/xauusd-chart && sudo chown $USER /opt/xauusd-chart
rsync -a --exclude node_modules --exclude .next --exclude candle_data \
      ./ ubuntu@YOUR_HOST:/opt/xauusd-chart/

# 3. Candle data, kept OUTSIDE the app dir so redeploys never touch it
ssh ubuntu@YOUR_HOST 'sudo mkdir -p /var/lib/xauusd && sudo chown $USER /var/lib/xauusd'
rsync -a --info=progress2 candle_data/ ubuntu@YOUR_HOST:/var/lib/xauusd/candle_data/

# 4. Install and build ON the server (the build is machine-specific)
ssh ubuntu@YOUR_HOST
cd /opt/xauusd-chart
npm ci
npm run build

# 5. Run it under systemd
sudo cp deploy/xauusd-chart.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xauusd-chart
journalctl -u xauusd-chart -f

# 6. Put nginx in front and add TLS
sudo cp deploy/nginx.conf /etc/nginx/sites-available/xauusd-chart
sudo ln -s /etc/nginx/sites-available/xauusd-chart /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d chart.example.com
```

Security group: open **443** (and 80 for the certbot challenge) to the internet.
Do **not** open 3000 — the unit binds it to `127.0.0.1` and nginx is the only way in.

## Smoke test after deploying

```bash
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' https://chart.example.com/
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' 'https://chart.example.com/api/candles?tf=M15&limit=3000'
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' 'https://chart.example.com/api/candles?tf=M15&limit=3000'  # warm: expect <50ms
curl -s https://chart.example.com/api/timeframes | head -c 200
```

## Things to know

- **`CANDLE_DATA_DIR`** is read by `lib/candles/store.ts` and falls back to
  `./candle_data`. Pointing it at `/var/lib/xauusd/candle_data` is what lets the
  395 MB of CSVs stay out of the repo and survive redeploys.
- **Everything is stored in the browser.** Drawings, indicator layout and the
  Count-mode log live in that browser's `localStorage`, keyed by symbol. They do
  not sync between devices, and clearing site data erases them. Adding real
  persistence means a database — deliberately not built yet.
- **There is no authentication.** Anyone who reaches the URL gets the terminal
  and the data. If that matters, put it behind nginx basic auth, a VPN, or
  restrict the security group to your own IP.
- **Single process, single box.** The in-memory store is per-process, so running
  two instances behind a load balancer just parses everything twice. Scale up,
  not out — or move the data into a database first.
