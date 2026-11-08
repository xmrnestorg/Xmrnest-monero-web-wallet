const path = require('path');
const fs = require('fs');

// Optional .env (project root, then backend/): never overrides variables already in the
// environment, so docker-compose `environment:` / `env_file:` keep precedence.
for (const envPath of [path.resolve(__dirname, '../../.env'), path.resolve(__dirname, '../.env')]) {
    try {
        if (!fs.existsSync(envPath)) continue;
        for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
            const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
            if (!m || m[1] in process.env) continue;
            let v = m[2];
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
            process.env[m[1]] = v;
        }
    } catch (e) { /* unreadable .env: ignore */ }
}

const config = {
    port: parseInt(process.env.PORT || '8080', 10),
    daemonUrl: process.env.DAEMON_URL || (process.env.DOCKER_ENV ? 'http://monerod:18081' : 'http://127.0.0.1:18081'),
    walletRpcUrl: process.env.WALLET_RPC_URL || (process.env.DOCKER_ENV ? 'http://monero-wallet-rpc:18082' : 'http://127.0.0.1:18082'),
    // Pool of wallet-rpc instances (comma separated). Each address is pinned to one instance
    // by hash, so N instances let N wallets scan at the same time.
    walletRpcUrls: (process.env.WALLET_RPC_URLS || '').split(',').map(u => u.trim()).filter(Boolean),
    redisUrl: process.env.REDIS_URL || (process.env.DOCKER_ENV ? 'redis://wallet-redis:6379' : 'redis://127.0.0.1:6379'),
    publicDir: process.env.PUBLIC_DIR || path.resolve(__dirname, '../../public'),
    // Switching between users' wallets stores the previous one to disk first, which can take a
    // few seconds for large wallet caches; waiting beats answering with empty data.
    rpcLockTimeoutMs: parseInt(process.env.RPC_LOCK_TIMEOUT_MS || '30000', 10),
    // Polls within this window are served from memory and never touch the wallet-rpc lock.
    cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || '20', 10),
    daemonHeightCacheTtlMs: 4000,
    // Keep-warm: open idle registered wallets on idle instances so they keep scanning.
    keepWarmIntervalMs: parseInt(process.env.KEEP_WARM_INTERVAL_MS || '60000', 10),
    keepWarmIdleMs: parseInt(process.env.KEEP_WARM_IDLE_MS || '60000', 10),
    // Chain watcher: poll monerod for new blocks / mempool changes.
    chainWatchIntervalMs: parseInt(process.env.CHAIN_WATCH_INTERVAL_MS || '3000', 10),
    chainRefreshDebounceMs: parseInt(process.env.CHAIN_REFRESH_DEBOUNCE_MS || '10000', 10),
    // Explicit wallet `store` cadence for synced wallets (scan progress survives container stops).
    storeIntervalMs: parseInt(process.env.STORE_INTERVAL_MS || '300000', 10),
    // Swap page: forwarded to a swap gateway (docs/swap-gateway-api.md). Empty URL = page hidden.
    // The instance key identifies this server to the gateway and never reaches the browser.
    swapGatewayUrl: (process.env.SWAP_GATEWAY_URL || '').trim().replace(/\/+$/, ''),
    swapGatewayKey: (process.env.SWAP_GATEWAY_KEY || '').trim(),
    // Operator-only detail on /api/health (?token=...). Empty = summary only.
    healthToken: (process.env.HEALTH_TOKEN || '').trim(),
    // Site-wide budget for NEW wallet files (addresses never seen here). No IP tracking exists,
    // so this is the only brake on a flood of fake wallets. Existing wallets are never limited.
    // Last-resort daily bound on NEW wallet files (the proof-of-work gate is the real brake).
    newWalletsPerDay: parseInt(process.env.NEW_WALLETS_PER_DAY || '5000', 10) || 5000,
    // Proof-of-work for new wallets: base difficulty in bits, +1 bit per `powStepWallets` new
    // wallets in the last hour, at most +powMaxExtraBits.
    powBaseBits: parseInt(process.env.POW_BASE_BITS || '16', 10) || 16,
    powStepWallets: parseInt(process.env.POW_STEP_WALLETS || '40', 10) || 40,
    powMaxExtraBits: parseInt(process.env.POW_MAX_EXTRA_BITS || '6', 10) || 6,
    // Scan lanes: wallet-rpc instances reserved for long restore scans, so a deep scan never
    // blocks instances that serve synced wallets. 0 = auto (a quarter of the pool, min 1 when
    // the pool has 4+ instances).
    scanLanes: parseInt(process.env.SCAN_LANES || '0', 10) || 0,
    // Directory where the wallet-rpc instances write their logs (shared volume, read-only here).
    // Used to read live scan progress while an instance is silent; '' disables it.
    rpcLogDir: process.env.RPC_LOG_DIR || '',
    // A restore this many blocks below the tip counts as a deep scan (~6 weeks).
    deepScanBlocks: parseInt(process.env.DEEP_SCAN_BLOCKS || '30000', 10) || 30000
};

if (config.walletRpcUrls.length === 0) config.walletRpcUrls = [config.walletRpcUrl];

module.exports = config;
