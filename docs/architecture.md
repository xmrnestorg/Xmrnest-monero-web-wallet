# Architecture and operations

This is the long version of how XmrNest works. The README covers installation and the model
in a few paragraphs; this file is for operators and contributors.

## Components

```
browser  ──HTTP/same origin──▶  node-wallet-api (backend/server.js)
                                  │  ├─ sessions, wallet records, swap tokens ─▶ wallet-redis
                                  │  ├─ pool of monero-wallet-rpc instances (watch-only wallets)
                                  │  ├─ monerod (block height, mempool, broadcast)
                                  │  └─ swap forwarder ─▶ swap gateway (separate service)
```

- `backend/server.js`: all HTTP routes, static files, security headers, server-sent events.
- `backend/lib/moneroRpc.js`: the wallet-rpc pool (placement, locks, keep-warm, progress).
- `backend/lib/moneroKeys.js`: Ed25519 in pure JavaScript, used to prove view-key ownership.
- `backend/lib/sessionManager.js`: Redis client, sessions, per-wallet records, swap tokens.
- `backend/lib/pow.js`: the proof-of-work gate for new wallets.
- `backend/lib/swapClient.js`: forwarder to a swap gateway (`docs/swap-gateway-api.md`).
- `backend/lib/rateLimit.js`: site-wide sliding-window budgets (never per address).

Frontend modules under `public/js/`:

| Module | Purpose |
| :--- | :--- |
| `crypto.js` | Monero cryptography (keys, mnemonics, subaddresses, balances, QR) |
| `polyseed.js` | 16-word Polyseed decoder |
| `monero-signer.js` | WebAssembly wallet used to decode and sign unsigned transaction sets |
| `api.js` | Fetch-based client for `/api/*` |
| `wallet.js` | Session and multi-account state, polling and event stream |
| `tx.js` | Send flow: validate, fetch unsigned set, verify, sign locally, broadcast |
| `ui.js` | Views, notifications, QR rendering, account switcher |
| `app.js` | Bootstrap, routing, event binding, privacy purge |
| `swap.js` | The swap page |

## HTTP API

The whole surface. Session routes take the session id in the POST body or the `X-Session-Id`
header; a missing or expired session answers 401. Every `/api/*` route shares one site-wide
budget (never per address), plus the per-route budgets noted.

| Route | Session | Purpose |
| :--- | :--- | :--- |
| `GET /api/health` | no | daemon height and sync state, pool size, Redis; `?token=` adds per-instance detail |
| `POST /api/auth` | no | open a watch-only wallet from address + private view key; returns the session id and restore height |
| `POST /api/state` | yes | balance, heights, scan progress and last transactions in one call (`stale: true` when served from the snapshot) |
| `POST /api/events/token`, `GET /api/events?t=` | yes | server-sent events: `state` on change, heartbeat every 25 s |
| `POST /api/height-for-date`, `POST /api/height-for-txid` | no | restore height from a date or a transaction id (120/min) |
| `GET /api/price` | no | XMR in USD and BTC, cached 60 s (the only third-party call the server makes) |
| `GET /api/fees` | no | per-byte fee for the four priority levels, from the daemon |
| `POST /api/create-unsigned-tx` | yes | unsigned transaction set for one destination, or a sweep; nothing is relayed |
| `POST /api/submit-signed-tx` | yes | broadcast a browser-signed set and import its key images |
| `POST /api/export-outputs`, `POST /api/import-key-images` | yes | key-image sync for spend-key logins (see below) |
| `POST /api/subaddress-next` | yes | reserve the next subaddress index (max 199); derivation happens in the browser |
| `POST /api/unspent-outputs` | yes | raw output list; not used by the app, kept for the backend tests |
| `POST /api/logout` | yes | destroy the session and close its event streams |
| `/api/swap/*` | optional | forwarder to the swap gateway (see "Swap page") |

Everything else is static: the app shell for `/`, `/send`, `/receive`, `/swap` and the other
pages, the assets under `public/`, plus `robots.txt` and `sitemap.xml` built from `SITE_URL`.
There is no route that accepts a seed or a spend key, and no route that relays an unsigned
transaction.

## Security model

- **Client-side spend keys.** Private spend keys never leave the browser. The server's
  `monero-wallet-rpc` holds only a watch-only wallet (address and private view key). It builds an
  unsigned transaction set (`transfer` / `sweep_all` with `do_not_relay`), the browser decodes
  the set with the wallet keys and refuses to sign unless every destination is the typed address
  and the amount matches, signs it in WebAssembly, and the signed set is broadcast with
  `submit_transfer`, which also imports the key images.
- **Proof of view-key ownership.** `/api/auth` verifies on the server that the supplied private
  view key derives the address's public view key. A public address alone opens nothing.
- **Failed broadcast.** If the relay answer is lost, the UI offers to re-send the same signed
  transaction. It never builds a second one, so a payment cannot be made twice.
- **Destinations.** Standard, subaddress and integrated addresses are accepted; checksums are
  verified in the browser and on the server. Standalone payment IDs are never sent.
- **Sessions.** In memory and Redis, 24 h TTL, id only in the POST body or `X-Session-Id`
  header. The frontend wipes everything on reload or sign-out.
- **Headers.** Content-Security-Policy (same origin, a nonce for the one inline script,
  `wasm-unsafe-eval` for the signer, `frame-ancestors 'none'`), `X-Frame-Options: DENY`,
  nosniff, `Referrer-Policy: no-referrer`, Permissions-Policy, COOP/CORP. No CORS.
- **No IP addresses.** The server never reads, stores or logs a client address. There is no
  per-user rate limiting, by design.
- **Proof of work for new wallets.** The browser solves a small keccak puzzle once per new
  wallet (`POW_BASE_BITS`, default 16). Difficulty rises by one bit per `POW_STEP_WALLETS` new
  wallets in the last hour, up to `POW_MAX_EXTRA_BITS`, so a flood gets expensive while real
  users wait a little longer. Existing wallets never see it. `NEW_WALLETS_PER_DAY` is a last
  resort bound.
- **Containers.** The API runs as the unprivileged `node` user with its code mounted read-only.
  Port 8080 is published on localhost only; port 80 (or Caddy on 443) is the public entry.
  Redis takes `REDIS_PASSWORD`. `HEALTH_TOKEN` unlocks the detailed `/api/health?token=` view.
  `backend/public/` (a `.gitkeep` only) is the mount point for `./public` inside the read-only
  backend mount; without it the API container cannot start.
- **No custodial route exists.** Nothing on the server accepts a spend key or a seed.

## The wallet-rpc pool

`monero-wallet-rpc` has one request thread and can only scan the wallet it has open. While it
scans it answers nothing, not even a TCP connect. So the API talks to a pool of instances and
stores, per wallet, which instance holds it.

- `docker-compose.yml` runs 4 instances. `docker-compose.pool8.yml` adds instances 5 to 12
  (`docker compose -f docker-compose.yml -f docker-compose.pool8.yml up -d`). Budget about
  300 MB and one core per instance while it scans.
- **Instances may be appended, never removed or reordered.** Placements are stored per wallet
  in Redis (`rec.instance`); shrinking the pool below a stored index orphans that wallet.
- All instances share `./data/wallets`, so a wallet can be reopened on any instance. Never
  delete files there: they hold scan progress, and every recreation is a full rescan.
- **Scan lanes.** `SCAN_LANES` instances (the last N indexes; 0 = a quarter of the pool) are
  reserved for deep restores (more than `DEEP_SCAN_BLOCKS` behind the tip), so an hours-long
  scan never blocks synced wallets.
- **Placement without queueing.** A new wallet is placed on an instance that answers right
  now: a free lane for deep scans, else a free regular instance, fewest wallets first. A user
  whose instance is busy scanning somebody else's wallet is moved to a free one.
- **Locks.** Every "open the right wallet, then query it" sequence runs under a per-instance
  lock with a holder name and age (visible in `/api/health?token=`). A watchdog breaks any lock
  held longer than 5 minutes and logs who held it. Every RPC call has an abort signal and a
  hard timer.
- **Keep-warm.** Every `KEEP_WARM_INTERVAL_MS` each idle instance opens the registered wallet
  it warmed longest ago, unfinished scans first (furthest behind first), so a scan continues
  after its owner closes the tab. Wallets unseen for 30 days are left alone.
- **Live restore progress.** Each instance logs `wallet.wallet2` at debug level to
  `./data/rpclogs`. While an instance is silent, the API tails that log for the last processed
  block height (`RPC_LOG_DIR`), so the progress bar moves during a restore.
- **Last-known state.** After every successful read the balance, heights and last
  transactions are stored in the wallet record. When an instance is busy, `/api/state` returns
  that snapshot with `stale: true` and the UI says so.
- **Chain watcher.** Every `CHAIN_WATCH_INTERVAL_MS` the API polls monerod's height and mempool.
  On a change it drops caches and asks idle instances to refresh (debounced by
  `CHAIN_REFRESH_DEBOUNCE_MS`), and pushes a `state` event to connected tabs.
- **Persistence.** The API stores a synced wallet when its scan completes and every
  `STORE_INTERVAL_MS` afterwards; containers stop with a grace period so wallet-rpc can flush.

## Restore height

- The import screen takes a creation date (`/api/height-for-date`) or the oldest known
  transaction id (`/api/height-for-txid`) and fills the restore height. Polyseed wallets carry
  their creation month. Without any of those the UI warns that a scan from the first block will
  run, and sending stays disabled until the scan reaches the tip.
- The effective height is stored per wallet and reused on later logins. A derived height can
  only lower a stored height; only an explicit manual height can raise it, and raising is
  refused when the wallet already holds outputs below the new height.
- wallet-rpc cannot change an existing file's start height, so a raised height means a new file
  (`wallet_<sha>_r<height>`); the old file is kept, never deleted. `/api/state` reports
  `scan_start`, the height the file really scans from.

## Spent outputs (key images)

A watch-only wallet sees every output it received but not spends made elsewhere, so its balance
is too high until key images are imported. After a spend-key login, once synced, the browser
fetches `POST /api/export-outputs`, computes signed key images in the WebAssembly wallet and
uploads them to `POST /api/import-key-images`. Only key images and signatures leave the browser.

## Push updates

A tab asks `POST /api/events/token` for a 60-second single-use token and opens
`GET /api/events?t=…`. The server pushes a `state` event whenever the wallet's fingerprint
(balance, scan height, transaction ids and confirmations) changes, plus a heartbeat every 25 s.
Polling is 15 s for a synced wallet and 5 s while a scan runs, with an immediate poll when the
tab becomes visible. At most 5 streams per wallet; sign-out closes them.



## Health

`GET /api/health` reports daemon height and sync state, the pool size and Redis status. With
`?token=<HEALTH_TOKEN>` it adds, per instance: reachability, lock state, holder and age, open
wallet, assigned wallets and the maximum blocks behind.

## Environment reference

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `PORT` | 8080 | API port |
| `DOCKER_ENV` | set by compose | switches the defaults below from `127.0.0.1` to the compose hostnames |
| `DAEMON_URL` | `http://monerod:18081` | monerod RPC |
| `WALLET_RPC_URLS` | compose list | the pool, comma separated, append only (`WALLET_RPC_URL` = a single instance) |
| `REDIS_URL` | from compose | Redis, with `REDIS_PASSWORD` |
| `PUBLIC_DIR` | `../public` | directory served as the web app |
| `SITE_URL` | `https://xmrnest.org` | public origin for robots.txt, the sitemap and link previews; set it on a fork |
| `RPC_LOCK_TIMEOUT_MS` | 30000 | how long a request waits for an instance lock |
| `SCAN_LANES` | 0 (auto) | instances reserved for deep restores |
| `DEEP_SCAN_BLOCKS` | 30000 | blocks behind the tip that count as a deep scan |
| `RPC_LOG_DIR` | `/rpclogs` | shared wallet-rpc log directory for live progress |
| `CACHE_TTL_SECONDS` | 20 | poll cache |
| `KEEP_WARM_INTERVAL_MS`, `KEEP_WARM_IDLE_MS` | 60000 | keep-warm cadence |
| `CHAIN_WATCH_INTERVAL_MS`, `CHAIN_REFRESH_DEBOUNCE_MS` | 3000, 10000 | chain watcher |
| `STORE_INTERVAL_MS` | 300000 | wallet store cadence |
| `POW_BASE_BITS`, `POW_STEP_WALLETS`, `POW_MAX_EXTRA_BITS` | 16, 40, 6 | new-wallet puzzle |
| `NEW_WALLETS_PER_DAY` | 5000 | last-resort daily bound on new wallet files |
| `HEALTH_TOKEN` | empty | unlocks the detailed health view |
| `SWAP_GATEWAY_URL`, `SWAP_GATEWAY_KEY` | empty | swap gateway; empty URL hides the page |
| `TEST_WALLET_ADDRESS`, `TEST_WALLET_VIEWKEY` | empty | watch-only wallet for the test suites |
