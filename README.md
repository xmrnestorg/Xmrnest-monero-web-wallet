# XmrNest

A non-custodial Monero web wallet you can run yourself. The server keeps only watch-only
wallets; every transaction is signed in the browser. No accounts, no IP logging, no build step,
no npm dependencies.

Live instance: [xmrnest.org](https://xmrnest.org). This repository is the complete wallet:
backend, frontend and the Docker stack. Swaps go through a separate gateway service (see
"Swap page" below); the gateway itself is not part of this repository.

## What it does

- **Open or create a wallet** from a 25-word seed, a 16-word Polyseed, or address + keys.
  View-only sessions (address + private view key) are supported.
- **Receive** on the primary address or fresh subaddresses, with QR codes and a payment sound.
- **Send** with local signing: the server builds an unsigned transaction set, the browser decodes
  it, checks that the destination and amount are what you typed, signs it in WebAssembly, and
  the server broadcasts it. The server can never spend.
- **Restore** from a creation date or a transaction id, with live progress during the scan and
  scans that keep running after you close the tab.
- **Multiple wallets** in one browser, switched from the account menu.
- **Swap** between XMR and other coins through a swap gateway, with or without a wallet open.
  The coin list comes from the gateway (on xmrnest.org: BTC, ETH, USDT, USDC, DAI, BNB, SOL,
  ZEC and TRX).

## Privacy

- The server never reads, stores or logs a client IP address, and there is no reverse proxy
  access log. Protection against floods comes from a proof-of-work puzzle the browser solves
  once per new wallet, not from tracking anyone.
- The browser only ever talks to the server it loaded the page from. Coin logos and swap data
  are re-served from that origin.
- Private spend keys never leave the browser. Private view keys are sent once to open the
  watch-only wallet and live in server memory, Redis (24 h) and the wallet file.
- The server's only outbound connections are its own monerod, the wallet-rpc pool, Redis, the
  swap gateway you configure, and a public price feed (CoinGecko, one request per minute, no
  user data in it).

## Repository layout

```
backend/                  Node.js API: server.js, lib/, Dockerfile (runs as the `node` user)
public/                   the web app: app.html, js/ modules, icons, payment sound
docs/                     architecture.md (operations) and swap-gateway-api.md (gateway contract)
docker-compose.yml        monerod, four wallet-rpc instances, Redis, the API
docker-compose.pool8.yml  wallet-rpc instances 5 to 12
docker-compose.tls.yml    Caddy on 443 in front of the API
.env.example              every setting an operator touches, documented
```

## Quick start

Requirements: Docker with Compose, about 40 GB of disk for a pruned Monero node, and patience
while the node syncs for the first time.

```bash
git clone https://github.com/xmrnestorg/Xmrnest-monero-web-wallet.git
cd Xmrnest-monero-web-wallet
cp .env.example .env          # set REDIS_PASSWORD and HEALTH_TOKEN at least
docker compose up -d
```

Open <http://localhost> once `curl -s localhost:8080/api/health` reports the daemon as
synchronized. The default stack runs monerod (pruned), four `monero-wallet-rpc` instances, Redis
and the API. For more concurrent users add the extra instances:

```bash
docker compose -f docker-compose.yml -f docker-compose.pool8.yml up -d
```


## Configuration

Everything is read from `.env` (see `.env.example`; every variable is explained in
[docs/architecture.md](docs/architecture.md#environment-reference)). The ones you will touch:

| Variable | What it does |
| :--- | :--- |
| `REDIS_PASSWORD` | protects the Redis that holds sessions and wallet records |
| `HEALTH_TOKEN` | unlocks the detailed `/api/health?token=` view for the operator |
| `SCAN_LANES` | wallet-rpc instances reserved for long restores (0 = a quarter of the pool) |
| `SWAP_GATEWAY_URL`, `SWAP_GATEWAY_KEY` | the swap gateway to use; empty URL hides the swap page |
| `POW_BASE_BITS` | difficulty of the new-wallet puzzle (16 is a few seconds on a phone) |
| `SITE_URL` | public origin used in robots.txt, the sitemap and link previews |

Rules worth knowing before you operate it:

- Wallet-rpc instances may be **appended, never removed or reordered**. Each wallet remembers
  the instance that holds it.
- Never delete `data/wallets/*`. Those files hold scan progress; recreating one means a full
  rescan from its restore height.
- `backend/public/` must stay in place (it only holds a `.gitkeep`): Compose mounts the web app
  there inside the read-only backend mount, and the API cannot start without the mount point.

## How it works

```
browser ──same origin──▶ API (backend/server.js) ──▶ monero-wallet-rpc pool (watch-only wallets)
                            │                      ──▶ monerod (height, mempool, broadcast)
                            ├──▶ Redis (sessions, wallet records, swap order tokens)
                            └──▶ swap gateway (separate service, docs/swap-gateway-api.md)
```

- **Backend**: one Node.js file for routes plus a handful of modules in `backend/lib/`. Zero npm
  dependencies. It runs as an unprivileged user with its code mounted read-only. The whole HTTP
  API is sixteen routes plus the swap forwarder, listed in
  [docs/architecture.md](docs/architecture.md#http-api).
- **Frontend**: plain JavaScript modules in `public/js/` (`crypto.js`, `polyseed.js`,
  `monero-signer.js`, `api.js`, `wallet.js`, `tx.js`, `ui.js`, `app.js`, `swap.js`). No bundler.
- **Pool**: `monero-wallet-rpc` can only scan one wallet at a time and answers nothing while it
  scans, so the API runs a pool, pins each wallet to an instance, keeps restores on reserved
  lanes, continues abandoned scans, and reads live progress from the instances' logs.
- **Push**: a server-sent event stream tells open tabs about new blocks and transactions;
  polling is the fallback.

The full description, including the restore-height rules, key-image import, locks and the
chain watcher, is in [docs/architecture.md](docs/architecture.md).

## Swap page

The wallet does not execute swaps. `/api/swap/*` forwards to a **swap gateway**, a separate
HTTPS service that implements [docs/swap-gateway-api.md](docs/swap-gateway-api.md): assets,
quotes, orders and order actions, authenticated per wallet instance with a key. The forwarder
sends only the documented fields, never a client header, a wallet address or a session id, and
orders are tracked with tokens the gateway mints. The provider name and terms link shown on the
page come from the gateway's config, so the wallet code names no provider.

Point `SWAP_GATEWAY_URL` at a gateway that follows the document (XmrNest runs one at
`api.xmrnest.org`), at your own implementation, or leave it empty to hide the page.


## Security

Found something? email support@xmrnest.org rather than
opening a public issue. .

## Licence

Code: [GNU AGPL-3.0](LICENSE). If you run a modified copy as a service, you must publish your
changes. The XmrNest name and logo are not covered, 
Contributions are welcome.
