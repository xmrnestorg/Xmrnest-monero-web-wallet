const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const sessionManager = require('./sessionManager');

const RING_SIZE = 16;
const DEFAULT_FEE_PER_BYTE = 20000;
const WALLET_RESCAN_SAFETY_BLOCKS = 1000;

/**
 * One monero-wallet-rpc process can only have ONE wallet open at a time, so every
 * "open the right wallet, then query it" sequence runs under that instance's lock.
 * To let several users' wallets scan in parallel, the API talks to a POOL of
 * wallet-rpc instances and routes each address to a fixed instance by hash. All
 * instances share the same wallet directory; the stable hash guarantees a given wallet
 * file is only ever opened by one instance (do not change the pool size while
 * instances are running with wallets open).
 */
class WalletRpcInstance {
    constructor(url, index) {
        this.url = url;
        this.index = index;
        this.lockQueue = [];
        this.isLockHeld = false;
        this.lockToken = null;
        this.lockHolder = null;      // name of the code path holding the lock (diagnostics)
        this.lockSince = 0;          // when it took the lock (watchdog)
        this.lastUserActivity = 0;   // last time a user request took this instance's lock
        this._openAddress = null;    // last address we know to be open here (see accessor)
        this.openedAt = 0;           // when openAddress last changed (scan-progress log lines must be newer)
        this.lastWarmedAddress = null;
        this.lastBusyAt = 0;         // last time wallet-rpc here did not answer (refresh in progress)
        this.lastStoreAt = 0;        // last explicit `store` of the open wallet
        this.wasSyncing = false;
    }
    get openAddress() { return this._openAddress; }
    set openAddress(v) {
        if (v !== this._openAddress) this.openedAt = Date.now();
        this._openAddress = v;
    }
}

class MoneroRpc {
    constructor() {
        this.cache = new Map(); // key -> { val, expires }
        this.txExtraCache = new Map(); // txid -> txData
        this.instances = config.walletRpcUrls.map((url, i) => new WalletRpcInstance(url, i));
        this.placements = new Map(); // address -> instance index (persisted in the wallet record)
        // Resolved once stored placements are loaded (server.js waits for it before listening).
        this.ready = new Promise((resolve) => {
            setTimeout(() => {
                Promise.race([this.loadPlacements().catch(() => {}), new Promise(r => setTimeout(r, 5000))]).then(resolve, resolve);
            }, 300);
        });
        this.priceCache = { data: { USD: 530.0, BTC: 0.00638 }, expires: 0 };
        this.lastKnownDaemonHeight = 0;

        // Chain watcher state (new block / mempool change detection)
        this.watcher = { height: 0, poolKey: '', lastRefreshAt: 0, lastEvent: null, running: false, pending: false, pendingTimer: null };
        // Set by the API layer: addresses with a live event stream count as active users.
        this.hasSubscribers = () => false;
        this._relocatedAt = new Map();  // address -> last relocation time (rate limit)

        if (config.keepWarmIntervalMs > 0) {
            this._keepWarmTimer = setInterval(() => this.warmIdleWallets().catch(() => {}), config.keepWarmIntervalMs);
            if (this._keepWarmTimer.unref) this._keepWarmTimer.unref();
        }
        if (config.chainWatchIntervalMs > 0) {
            this._watchTimer = setInterval(() => this.watchChain().catch(() => {}), config.chainWatchIntervalMs);
            if (this._watchTimer.unref) this._watchTimer.unref();
        }
        this._lockWatchdog = setInterval(() => { try { this._checkStuckLocks(); } catch (e) {} }, 30000);
        if (this._lockWatchdog.unref) this._lockWatchdog.unref();
    }

    _noteUserActivity(inst) {
        inst.lastUserActivity = Date.now();
    }

    _invalidateAllWalletCaches() {
        for (const key of Array.from(this.cache.keys())) {
            if (key.startsWith('addr_info:') || key.startsWith('addr_txs:')) this.cache.delete(key);
        }
    }

    _getCache(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        if (Date.now() > item.expires) {
            this.cache.delete(key);
            return null;
        }
        return item.val;
    }

    _setCache(key, val, ttlMs) {
        if (this.cache.size >= 5000) {
            // bounded: drop expired entries, then the oldest insertions
            const now = Date.now();
            for (const [k, v] of this.cache) if (v.expires < now) this.cache.delete(k);
            while (this.cache.size >= 5000) this.cache.delete(this.cache.keys().next().value);
        }
        this.cache.set(key, { val, expires: Date.now() + ttlMs });
    }

    _invalidateWalletCaches(address) {
        this.cache.delete(`addr_info:${address}`);
        this.cache.delete(`addr_txs:${address}`);
    }

    _hashInstanceIndex(address) {
        const n = this.instances.length;
        if (n === 1) return 0;
        const h = crypto.createHash('sha256').update(String(address || '')).digest();
        return h.readUInt32BE(0) % n;
    }

    /**
     * Address -> wallet-rpc instance. A stored placement (decided once, at first login, by
     * load) wins; otherwise the stable hash. Because the placement is persisted and never
     * changed, a wallet file is only ever opened by one instance.
     */
    instanceFor(address) {
        const n = this.instances.length;
        const placed = this.placements.get(address);
        if (Number.isInteger(placed)) {
            if (placed < n) return this.instances[placed];
            // Pool shrank below a stored index: fall back deterministically and say so once.
            if (!this._shrinkWarned) {
                this._shrinkWarned = true;
                console.error(`[moneroRpc] stored placement ${placed} exceeds pool size ${n}; using modulo. Do not shrink the pool while wallets are placed.`);
            }
            return this.instances[placed % n];
        }
        return this.instances[this._hashInstanceIndex(address)];
    }

    /** Wallets pinned to each instance (from the registry), for load-aware placement. */
    _assignedCounts() {
        const counts = this.instances.map(() => 0);
        for (const idx of this.placements.values()) {
            if (Number.isInteger(idx) && idx < counts.length) counts[idx]++;
        }
        return counts;
    }

    /**
     * Decide (once) which instance a wallet lives on. Existing records keep their instance; a
     * record without one (pre-placement wallets) gets its hash instance written back; a brand
     * new wallet goes to the instance with the fewest pinned wallets, ties -> lowest index.
     */
    /** Instance indexes reserved for long restore scans (the last ones in the pool). */
    _scanLaneIndexes() {
        const n = this.instances.length;
        let lanes = config.scanLanes > 0 ? config.scanLanes : (n >= 4 ? Math.floor(n / 4) : 0);
        lanes = Math.min(lanes, Math.max(0, n - 1));
        const out = [];
        for (let i = n - lanes; i < n; i++) out.push(i);
        return out;
    }

    /**
     * `deepScan`: the wallet will scan far below the tip. It goes to a scan lane so the hours it
     * needs never block the instances serving synced wallets. Placement stays sticky afterwards.
     */
    async placeWallet(address, { deepScan = false } = {}) {
        if (!address) return null;
        if (this.placements.has(address)) return this.instances[this.placements.get(address) % this.instances.length];

        const rec = await sessionManager.getWalletRecord(address);
        let idx;
        if (rec && Number.isInteger(rec.instance)) {
            idx = rec.instance;
        } else if (rec && (rec.stateAt > 0 || rec.lastWarmed > 0 || rec.scannedHeight > 0)) {
            // Its wallet file was opened before placement existed, i.e. it lives on the hash
            // instance. (A mere login stamp does not count: no file was touched yet.)
            idx = this._hashInstanceIndex(address);
        } else {
            const counts = this._assignedCounts();
            const lanes = this._scanLaneIndexes();
            const laneSet = new Set(lanes);
            const all = counts.map((_, i) => i);
            const regular = all.filter(i => !laneSet.has(i));
            // Nobody waits for a slot: a restore starts on an instance that is free RIGHT NOW.
            // Preference for a deep restore: a free lane, then a free regular instance (its
            // synced wallets pause while the scan runs, which beats making the new user wait
            // hours), then the least-loaded lane. Synced/new wallets stay off the lanes.
            const free = await this._freeInstances(deepScan ? all : regular);
            let candidates;
            if (deepScan && lanes.length) {
                const freeLanes = free.filter(i => laneSet.has(i));
                const freeRegular = free.filter(i => !laneSet.has(i));
                candidates = freeLanes.length ? freeLanes : (freeRegular.length ? freeRegular : lanes);
            } else {
                candidates = free.length ? free : (regular.length ? regular : all);
            }
            idx = candidates[0];
            for (const i of candidates) if (counts[i] < counts[idx]) idx = i;
        }
        this.placements.set(address, idx);
        await sessionManager.setWalletInstance(address, idx);
        return this.instances[idx % this.instances.length];
    }

    /**
     * Move a wallet off an instance that is busy scanning a DIFFERENT wallet, onto one that is
     * free. Only when the bookkeeping is unambiguous (another address is known to be open there
     * and this wallet's stored placement is this instance), at most once per 10 minutes per
     * wallet, never while our own file could be open on the old instance. Returns true if moved.
     */
    async _relocateIfBlocked(address, inst) {
        if (!inst.openAddress || inst.openAddress === address) return false;
        if (this.placements.get(address) !== inst.index) return false;
        const last = this._relocatedAt.get(address) || 0;
        if (Date.now() - last < 10 * 60 * 1000) return false;
        this._relocatedAt.set(address, Date.now());
        if (this._relocatedAt.size > 5000) this._relocatedAt.clear();
        const others = this.instances.map((_, i) => i).filter(i => i !== inst.index);
        const free = await this._freeInstances(others);
        if (!free.length) return false;
        const lanes = new Set(this._scanLaneIndexes());
        const counts = this._assignedCounts();
        // Prefer a free regular instance; a free lane only if nothing else is free.
        const pool = free.filter(i => !lanes.has(i)).length ? free.filter(i => !lanes.has(i)) : free;
        let idx = pool[0];
        for (const i of pool) if (counts[i] < counts[idx]) idx = i;
        console.log(`[moneroRpc] ${address.slice(0, 8)}... blocked behind ${inst.openAddress.slice(0, 8)}... on instance ${inst.index}: moving to free instance ${idx}`);
        this.placements.set(address, idx);
        await sessionManager.setWalletInstance(address, idx);
        this.cache.delete(`addr_info:${address}`);
        return true;
    }

    /** Log file of an instance: monero-wallet-rpc -> rpc-1.log, monero-wallet-rpc-7 -> rpc-7.log. */
    _logFileFor(inst) {
        if (!config.rpcLogDir) return null;
        let host = '';
        try { host = new URL(inst.url).hostname; } catch (e) { return null; }
        const m = /-(\d+)$/.exec(host);
        return path.join(config.rpcLogDir, `rpc-${m ? m[1] : '1'}.log`);
    }

    /**
     * Live scan progress for a silent instance, read from the tail of its wallet-rpc log
     * (level `0,wallet.wallet2:DEBUG` prints "Processed block: <hash>, height N" per block and
     * "Pulled blocks: ... height N, node height T" per batch). Only lines written after the
     * current wallet was opened count, so a previous wallet's scan is never reported.
     */
    async _scanProgressFromLog(inst) {
        const file = this._logFileFor(inst);
        if (!file) return null;
        let fh = null;
        try {
            fh = await fs.promises.open(file, 'r');
            const st = await fh.stat();
            const len = Math.min(st.size, 65536);
            if (len === 0) return null;
            const buf = Buffer.alloc(len);
            await fh.read(buf, 0, len, st.size - len);
            const text = buf.toString('utf8');
            // File format: "<ts>\t[RPC0]\tDEBUG\twallet.wallet2\tsrc/wallet/wallet2.cpp:NNNN\t<message>"
            const re = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\t\[[^\]]*\]\tDEBUG\twallet\.wallet2\t\S+\t(?:Processed block: <[0-9a-f]+>, height (\d+)|Pulled blocks: blocks_start_height \d+, count \d+, height (\d+))/gm;
            // Highest height in the tail (never 0: an idle wallet logs "Pulled blocks ... height
            // 0"), with the newest timestamp. "Pulled" and "Processed" lines interleave, so the
            // last line alone would make the counter step back by a batch now and then.
            let height = 0, at = 0, m;
            while ((m = re.exec(text)) !== null) {
                const h = parseInt(m[2] || m[3], 10);
                const t = Date.parse(m[1].replace(' ', 'T') + 'Z');
                if (!(h > 0) || !(t > 0) || t < inst.openedAt - 2000) continue;
                if (h > height) height = h;
                if (t > at) at = t;
            }
            if (!height) return null;
            return { height, at };
        } catch (e) {
            return null;
        } finally {
            if (fh) await fh.close().catch(() => {});
        }
    }

    /**
     * Instances that answer right now and are not locked: a live probe, because an instance
     * mid-scan stays silent for hours and `lastBusyAt` only moves when somebody asks it.
     */
    async _freeInstances(indexes) {
        const now = Date.now();
        const checks = indexes.map(async (i) => {
            const inst = this.instances[i];
            if (inst.isLockHeld || inst.lockQueue.length > 0) return null;
            if ((now - (inst.lastBusyAt || 0)) < 60000) return null;
            const v = await this.callWalletRpc('get_version', {}, 2500, inst);
            return (v && v.version) ? i : null;
        });
        return (await Promise.all(checks)).filter(i => i !== null);
    }

    /** Load stored placements at startup so routing is consistent before any login. */
    async loadPlacements() {
        const all = await sessionManager.listWallets();
        for (const a of all) {
            try { await this.placeWallet(a); } catch (e) {}
        }
        if (all.length) console.log(`[moneroRpc] placements loaded for ${all.length} wallets: ${JSON.stringify(this._assignedCounts())} per instance`);
    }

    async acquireRpcLock(inst, timeoutMs = 3500, holder = 'unknown') {
        const token = crypto.randomBytes(8).toString('hex');
        if (!inst.isLockHeld) {
            inst.isLockHeld = true;
            inst.lockToken = token;
            inst.lockHolder = holder;
            inst.lockSince = Date.now();
            return token;
        }

        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const idx = inst.lockQueue.findIndex(q => q.token === token);
                if (idx !== -1) inst.lockQueue.splice(idx, 1);
                resolve(null);
            }, timeoutMs);

            inst.lockQueue.push({
                token,
                resolve: () => {
                    clearTimeout(timer);
                    inst.isLockHeld = true;
                    inst.lockToken = token;
                    inst.lockHolder = holder;
                    inst.lockSince = Date.now();
                    resolve(token);
                }
            });
        });
    }

    releaseRpcLock(inst, token) {
        if (!token || inst.lockToken !== token) return;
        inst.isLockHeld = false;
        inst.lockToken = null;
        inst.lockHolder = null;
        inst.lockSince = 0;
        if (inst.lockQueue.length > 0) {
            const next = inst.lockQueue.shift();
            next.resolve();
        }
    }

    /**
     * Lock watchdog. Every holder releases in a `finally` and every RPC call has a timeout, so a
     * lock can only stay held for a few minutes at most. Should one ever stay longer (observed
     * once in production: instance 1 "busy" for 80 minutes, queue empty, wallet-rpc idle), log
     * who took it and break it so the wallets on that instance come back without a restart.
     * The stale holder's own release is ignored afterwards (its token no longer matches).
     */
    _checkStuckLocks(maxHoldMs = 5 * 60 * 1000) {
        const now = Date.now();
        for (const inst of this.instances) {
            if (!inst.isLockHeld || !inst.lockSince) continue;
            const held = now - inst.lockSince;
            if (held < maxHoldMs) continue;
            console.error(`[moneroRpc] lock on instance ${inst.index} held ${Math.round(held / 1000)}s by '${inst.lockHolder}': forcing release (queue ${inst.lockQueue.length})`);
            inst.isLockHeld = false;
            inst.lockToken = null;
            inst.lockHolder = null;
            inst.lockSince = 0;
            if (inst.lockQueue.length > 0) inst.lockQueue.shift().resolve();
        }
    }

    async callDaemonJsonRpc(method, params = {}) {
        const payload = { jsonrpc: '2.0', id: '0', method, params };
        try {
            const resp = await fetch(`${config.daemonUrl}/json_rpc`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(10000)
            });
            const json = this._parseRpcJson(await resp.text());
            return json.result || json;
        } catch (e) {
            return { error: { message: e.message } };
        }
    }

    async callDaemonRest(endpoint, payload = {}) {
        try {
            const resp = await fetch(`${config.daemonUrl}/${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(10000)
            });
            return this._parseRpcJson(await resp.text());
        } catch (e) {
            return { error: { message: e.message } };
        }
    }

    /**
     * monerod / wallet-rpc emit uint64 amounts as bare JSON numbers; JSON.parse would round
     * anything above 2^53 (≈ 9 007 XMR). Quote long integers before parsing so they arrive as
     * exact strings (every caller already treats amounts as strings / BigInt).
     */
    _parseRpcJson(text) {
        return JSON.parse(String(text).replace(/([\[:,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"'));
    }

    async callWalletRpc(method, params = {}, timeoutMs = 12000, inst = null) {
        const target = inst || this.instances[0];
        const payload = { jsonrpc: '2.0', id: '0', method, params };
        let hardTimer = null;
        try {
            // Belt and braces: the abort signal should end the request, but a lock holder must
            // never be able to wait longer than its budget whatever the HTTP client does.
            const hardTimeout = new Promise((_, reject) => {
                hardTimer = setTimeout(() => reject(new Error(`timeout: ${method} exceeded ${timeoutMs + 5000}ms`)), timeoutMs + 5000);
            });
            const request = (async () => {
                const resp = await fetch(`${target.url}/json_rpc`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: AbortSignal.timeout(timeoutMs)
                });
                return this._parseRpcJson(await resp.text());
            })();
            const json = await Promise.race([request, hardTimeout]);
            request.catch(() => {});
            return json.result || json;
        } catch (e) {
            // Two kinds of "no answer": our own timeout, or a socket-level failure (undici reports
            // these as TypeError "fetch failed" with a cause such as ECONNRESET / UND_ERR_*). Both
            // mean "the instance did not answer", which for a refreshing wallet-rpc is normal.
            const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError' || /timeout|aborted/i.test(String(e.message)));
            const causeCode = e && e.cause && (e.cause.code || e.cause.name) ? String(e.cause.code || e.cause.name) : '';
            const unreachable = !timeout && /fetch failed|ECONN|EPIPE|UND_ERR|socket hang up|EHOSTUNREACH|ENOTFOUND/i.test(String(e.message) + ' ' + causeCode);
            return { error: { message: e.message + (causeCode ? ` (${causeCode})` : ''), timeout: Boolean(timeout) || unreachable, unreachable } };
        } finally {
            if (hardTimer) clearTimeout(hardTimer);
        }
    }

    async getDaemonHeight() {
        const cached = this._getCache('daemon_height');
        if (cached !== null) return cached;

        const res = await this.callDaemonJsonRpc('get_block_count');
        let height = res && res.count ? parseInt(res.count, 10) : 0;
        if (!(height > 0)) {
            const alt = await this.callDaemonRest('get_height');
            height = alt && alt.height ? parseInt(alt.height, 10) : 0;
        }
        if (height > 0) {
            this._setCache('daemon_height', height, config.daemonHeightCacheTtlMs);
            this.lastKnownDaemonHeight = height;
            return height;
        }
        // Daemon unreachable: return the last height we actually saw (0 if never).
        return this.lastKnownDaemonHeight;
    }

    /**
     * Fee levels per byte for the 4 wallet priorities (unimportant, normal, elevated, priority).
     * monerod >= 0.18 returns a `fees` array; older daemons only return `fee`.
     */
    async getFeeLevels() {
        const cached = this._getCache('fee_levels');
        if (cached) return cached;

        const res = await this.callDaemonJsonRpc('get_fee_estimate', { grace_blocks: 10 });
        let fee = DEFAULT_FEE_PER_BYTE;
        let fees = null;
        if (res && res.fee) fee = parseInt(res.fee, 10) || DEFAULT_FEE_PER_BYTE;
        if (res && Array.isArray(res.fees) && res.fees.length === 4) {
            fees = res.fees.map(f => parseInt(f, 10) || fee);
        } else {
            // Historical wallet2 multipliers for per-byte fees.
            fees = [fee, fee * 5, fee * 25, fee * 1000];
        }
        const levels = { fee, fees, quantization_mask: (res && res.quantization_mask) || 10000 };
        this._setCache('fee_levels', levels, 30000);
        return levels;
    }

    async getFeeEstimate() {
        const levels = await this.getFeeLevels();
        return levels.fee;
    }

    async getPrice() {
        if (Date.now() < this.priceCache.expires) {
            return this.priceCache.data;
        }
        try {
            const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd,btc', {
                signal: AbortSignal.timeout(4000)
            });
            const data = await res.json();
            if (data && data.monero && data.monero.usd) {
                this.priceCache = {
                    data: {
                        USD: data.monero.usd,
                        BTC: data.monero.btc || 0.00638
                    },
                    expires: Date.now() + 60000
                };
                return this.priceCache.data;
            }
        } catch (e) {}

        return this.priceCache.data;
    }

    /**
     * Which wallet is open on this instance. `timeout: true` means wallet-rpc did not answer:
     * it is single-threaded per wallet and blocks every RPC call while the open wallet refreshes.
     */
    async _currentlyOpenAddress(inst) {
        const current = await this.callWalletRpc('get_address', { account_index: 0 }, 12000, inst);
        if (current && current.error && current.error.timeout) return { address: null, timeout: true };
        return { address: (current && typeof current.address === 'string') ? current.address : null, timeout: false };
    }

    /**
     * Make sure the watch-only wallet for `address` is the one open on `inst`.
     * MUST be called while holding the instance lock.
     *
     * Returns 'open'   - the wallet is open and answering,
     *         'busy'   - wallet-rpc is blocked (a wallet is refreshing); nothing was queued,
     *         'failed' - the wallet could not be opened or generated.
     *
     * A timeout must never be read as "wrong wallet": queuing open_wallet / generate_from_keys
     * behind a refreshing instance would reopen the same wallet and restart its refresh.
     */
    async ensureWalletOpen(inst, address, viewkey, restoreHeight = 0, isNew = false) {
        address = (address || '').trim();
        if (!address) return 'failed';

        const record = (await sessionManager.getWalletRecord(address)) || {};
        const shaHash = crypto.createHash('sha256').update(address).digest('hex').slice(0, 16);
        const shaName = `wallet_${shaHash}`;

        const cur = await this._currentlyOpenAddress(inst);
        if (cur.address === address) {
            if (inst.openAddress !== address) { inst.lastStoreAt = 0; inst.wasSyncing = false; }
            inst.openAddress = address;
            if (!record.walletFile) {
                // File predates this bookkeeping: assume the default name; start height unknown (0).
                await sessionManager.setWalletFile(address, { walletFile: shaName, generatedHeight: record.generatedHeight === null || record.generatedHeight === undefined ? 0 : record.generatedHeight });
            }
            return 'open';
        }
        if (cur.timeout) {
            inst.lastBusyAt = Date.now();
            return 'busy';
        }

        // A pending re-anchor on a file that was generated at block 0 and has NEVER produced a
        // stored state (no scan ever completed, nothing observed) is applied directly: generate
        // the new file instead of opening the old one. Opening it would start a genesis scan
        // that blocks the instance for hours before the re-anchor check could even run.
        // "Never produced anything" means: no funds seen and the scan is still below the
        // requested height. (A saved state with balance 0 at height 0/1 does not count: the
        // first poll right after generation stores one before the scan even starts.)
        const nothingFound = !(record.balance && /^[0-9]+$/.test(String(record.balance)) && BigInt(record.balance) > 0n)
            && (parseInt(record.scannedHeight || '0', 10) || 0) < record.pendingRegenerate;
        if (record.pendingRegenerate > 0 && record.generatedHeight === 0 && nothingFound && viewkey) {
            const target = record.pendingRegenerate;
            const newName = `wallet_${shaHash}_r${target}`;
            const openRes = await this.callWalletRpc('open_wallet', { filename: newName, password: '', autosave_current: true }, 60000, inst);
            if (openRes && openRes.error && openRes.error.timeout) { inst.lastBusyAt = Date.now(); return 'busy'; }
            if (openRes && !openRes.error) {
                const chk = await this._currentlyOpenAddress(inst);
                if (chk.address === address) {
                    inst.openAddress = address;
                    await sessionManager.setWalletFile(address, { walletFile: newName, generatedHeight: target });
                    return 'open';
                }
                if (chk.timeout) { inst.openAddress = address; inst.lastBusyAt = Date.now(); return 'busy'; }
            }
            console.log(`[moneroRpc] direct re-anchor for ${address.slice(0, 8)}...: genesis file never synced -> generate from ${target}`);
            return this._generateWallet(inst, address, viewkey, target, newName);
        }

        const legacyName = `wallet_${address.slice(0, 16)}_${address.slice(-8)}`;
        const candidates = [];
        if (record.walletFile) candidates.push(record.walletFile);
        for (const c of [shaName, legacyName]) if (!candidates.includes(c)) candidates.push(c);

        for (const filename of candidates) {
            const openRes = await this.callWalletRpc('open_wallet', {
                filename,
                password: '',
                autosave_current: true
            }, 60000, inst);

            if (openRes && openRes.error && openRes.error.timeout) {
                inst.lastBusyAt = Date.now();
                return 'busy';
            }
            const opened = openRes && !openRes.error;
            const alreadyOpen = openRes && openRes.error && openRes.error.message && openRes.error.message.includes('already open');
            if (opened || alreadyOpen) {
                const chk = await this._currentlyOpenAddress(inst);
                if (chk.address === address) {
                    inst.openAddress = address;
                    inst.lastStoreAt = 0;
                    inst.wasSyncing = false;
                    if (!record.walletFile) {
                        // Pre-existing file (before this bookkeeping): remember it; its start height is unknown.
                        await sessionManager.setWalletFile(address, { walletFile: filename, generatedHeight: record.generatedHeight === null ? 0 : record.generatedHeight });
                    }
                    return 'open';
                }
                if (chk.timeout) {
                    // Opened and immediately started refreshing: ours, busy.
                    inst.openAddress = address;
                    inst.lastBusyAt = Date.now();
                    return 'busy';
                }
                // Some other wallet is open now: the bookkept address is no longer true.
                inst.openAddress = chk.address || null;
            }
        }

        // No view key (keep-warm path): only existing wallet files may be opened.
        if (!viewkey) return 'failed';

        // Wallet file does not exist yet: generate a watch-only wallet from the view key.
        const dHeight = await this.getDaemonHeight();
        let rHeight = 0;
        if (restoreHeight > 0) {
            rHeight = restoreHeight;
        } else if (isNew && dHeight > 0) {
            rHeight = Math.max(0, dHeight - WALLET_RESCAN_SAFETY_BLOCKS);
        }
        return this._generateWallet(inst, address, viewkey, rHeight, shaName);
    }

    async _generateWallet(inst, address, viewkey, rHeight, filename) {
        const genRes = await this.callWalletRpc('generate_from_keys', {
            restore_height: rHeight,
            filename,
            address,
            viewkey,
            spendkey: '',
            password: '',
            autosave_current: true
        }, 120000, inst);

        if (genRes && genRes.error && genRes.error.timeout) {
            // wallet-rpc may have created the wallet and gone straight into its first refresh.
            inst.openAddress = address;
            inst.lastBusyAt = Date.now();
            await sessionManager.setWalletFile(address, { walletFile: filename, generatedHeight: rHeight });
            return 'busy';
        }
        if (!genRes || genRes.error) {
            console.error(`[moneroRpc] generate_from_keys failed for ${address.slice(0, 8)}...: ${(genRes && genRes.error && genRes.error.message) || 'unknown error'}`);
            return 'failed';
        }
        await sessionManager.setWalletFile(address, { walletFile: filename, generatedHeight: rHeight });
        console.log(`[moneroRpc] generated wallet ${filename} for ${address.slice(0, 8)}... from height ${rHeight}`);

        const after = await this._currentlyOpenAddress(inst);
        if (after.address === address) { inst.openAddress = address; inst.lastStoreAt = 0; inst.wasSyncing = false; return 'open'; }
        if (after.timeout) { inst.openAddress = address; inst.lastBusyAt = Date.now(); return 'busy'; }
        return 'failed';
    }

    /**
     * A later login asked to start higher than the file was generated with (typically: first
     * login without a height, then a corrected one). wallet-rpc cannot move a file's restore
     * height, so we regenerate under a new file name, but ONLY if the current file has found
     * nothing yet; if it already holds outputs below the new height, the new height is wrong
     * and we keep the file. Called under the instance lock with the wallet open.
     */
    async _applyPendingRegenerate(inst, address, viewkey, record) {
        const target = record.pendingRegenerate;
        if (!(target > 0)) return 'open';
        const generated = Number.isInteger(record.generatedHeight) ? record.generatedHeight : 0;
        const downward = generated > 0 && target < generated;
        const h = await this.callWalletRpc('get_height', {}, 12000, inst);
        if (!h || h.error) { inst.lastBusyAt = Date.now(); return 'busy'; }
        const scanned = parseInt(h.height, 10) || 0;
        if (!downward) {
            if (scanned >= target) {
                // Already past the requested height: nothing to gain.
                await sessionManager.setRegenerateDeclined(address, target);
                return 'open';
            }
            // Decide from the LIVE wallet, by outputs not balance: a wallet that received and
            // spent everything (balance 0) still owns outputs and key images below the target.
            const outs = await this.callWalletRpc('incoming_transfers', { transfer_type: 'all', account_index: 0 }, 20000, inst);
            if (!outs || outs.error) { inst.lastBusyAt = Date.now(); return 'busy'; }
            if (Array.isArray(outs.transfers) && outs.transfers.length > 0) {
                console.log(`[moneroRpc] keeping ${address.slice(0, 8)}... file: it already holds ${outs.transfers.length} output(s) below requested height ${target}`);
                await sessionManager.setRegenerateDeclined(address, target);
                return 'open';
            }
        } else {
            console.log(`[moneroRpc] lowering start of ${address.slice(0, 8)}... from ${generated} to ${target} (older funds may exist)`);
        }
        const shaHash = crypto.createHash('sha256').update(address).digest('hex').slice(0, 16);
        const filename = `wallet_${shaHash}_r${target}`;
        console.log(`[moneroRpc] re-anchoring ${address.slice(0, 8)}...: scanned ${scanned} -> regenerate from ${target}`);
        await this.callWalletRpc('close_wallet', { autosave_current: false }, 60000, inst);
        inst.openAddress = null;
        const state = await this._generateWallet(inst, address, viewkey, target, filename);
        if (state === 'failed') {
            // e.g. the versioned file already exists: open it instead of regenerating.
            const openRes = await this.callWalletRpc('open_wallet', { filename, password: '', autosave_current: true }, 60000, inst);
            if (openRes && !openRes.error) {
                await sessionManager.setWalletFile(address, { walletFile: filename, generatedHeight: target });
                inst.openAddress = address;
                return 'open';
            }
        }
        return state;
    }

    _emptyInfo(dHeight) {
        return {
            total_received: '0',
            total_sent: '0',
            scanned_height: 0,
            blockchain_height: dHeight,
            unlocked_balance: '0',
            balance: '0',
            wallet_ready: false
        };
    }

    async getAddressInfo(address, viewkey, restoreHeight = 0, isNew = false) {
        const cacheKey = `addr_info:${address}`;
        const cached = this._getCache(cacheKey);
        if (cached) return cached;

        const inst = this.instanceFor(address);
        this._noteUserActivity(inst);
        // Known to be scanning THIS wallet (its log advanced within the last 10 s, or it was
        // silent a moment ago): answer from the scan log at once instead of waiting 12 s for a
        // probe that will time out (and holding the lock). When the log goes quiet the scan is
        // over and the normal path takes over on the next poll.
        if (inst.openAddress === address && inst.lastBusyAt) {
            const live = await this._scanProgressFromLog(inst);
            const now = Date.now();
            if (live && ((now - live.at) < 10000 || (now - inst.lastBusyAt) < 8000)) {
                const dHeight = await this.getDaemonHeight();
                const rec = (await sessionManager.getWalletRecord(address)) || {};
                const scanStart = Number.isInteger(rec.generatedHeight) ? rec.generatedHeight : null;
                return { ...this._emptyInfo(dHeight), busy: true, syncing: true, restore_height: restoreHeight, scan_start: scanStart, scanned_height: live.height, live: true };
            }
        }
        const lockToken = await this.acquireRpcLock(inst, config.rpcLockTimeoutMs, 'state');
        if (!lockToken) {
            const dHeight = await this.getDaemonHeight();
            const live = inst.openAddress === address ? await this._scanProgressFromLog(inst) : null;
            return { ...this._emptyInfo(dHeight), busy: true, ...(live ? { scanned_height: live.height, live: true } : {}) };
        }

        try {
            this._noteUserActivity(inst);
            const dHeight = await this.getDaemonHeight();
            let state = await this.ensureWalletOpen(inst, address, viewkey, restoreHeight, isNew);
            if (state === 'open') {
                const rec0 = await sessionManager.getWalletRecord(address);
                if (rec0 && rec0.pendingRegenerate > 0) {
                    state = await this._applyPendingRegenerate(inst, address, viewkey, rec0);
                }
            }
            const rec = (await sessionManager.getWalletRecord(address)) || {};
            const scanStart = Number.isInteger(rec.generatedHeight) ? rec.generatedHeight : null;
            if (state === 'busy') {
                // The instance is silent because it is scanning. If that scan is for ANOTHER
                // wallet, this user should not sit behind it: move the wallet to an instance that
                // is free now (all instances share the wallet directory). Takes effect next poll.
                const moved = await this._relocateIfBlocked(address, inst);
                const live = inst.openAddress === address ? await this._scanProgressFromLog(inst) : null;
                return { ...this._emptyInfo(dHeight), busy: true, syncing: true, restore_height: restoreHeight, scan_start: scanStart, relocated: moved, ...(live ? { scanned_height: live.height, live: true } : {}) };
            }
            if (state !== 'open') {
                // Never report another wallet's numbers.
                return this._emptyInfo(dHeight);
            }

            const balRes = await this.callWalletRpc('get_balance', { account_index: 0 }, 12000, inst);
            const heightRes = await this.callWalletRpc('get_height', {}, 12000, inst);
            if (!balRes || balRes.error || !heightRes || heightRes.error) {
                // A refresh started between the open check and these calls: do not cache zeros.
                inst.lastBusyAt = Date.now();
                return { ...this._emptyInfo(dHeight), busy: true, syncing: true, restore_height: restoreHeight, scan_start: scanStart };
            }

            const balance = (typeof balRes.balance !== 'undefined') ? balRes.balance.toString() : '0';
            const unlocked = (typeof balRes.unlocked_balance !== 'undefined') ? balRes.unlocked_balance.toString() : '0';
            let scannedHeight = heightRes.height ? parseInt(heightRes.height, 10) : 0;
            // A freshly generated wallet reports height 1 for a few seconds while wallet-rpc
            // fast-forwards to its restore height; report the restore height instead so the UI
            // does not flash "millions of blocks behind".
            const effectiveStart = Number.isInteger(scanStart) && scanStart > 0 ? scanStart : (restoreHeight > 0 ? restoreHeight : 0);
            if (scannedHeight <= 1 && effectiveStart > 0) scannedHeight = effectiveStart;
            const syncing = dHeight > 0 && (dHeight - scannedHeight) > 2;

            // Persist scan progress. wallet-rpc only writes the file on an explicit `store` or
            // when autosave closes it; a container stop can lose everything since then. Store
            // when a scan has just completed and at most every `storeIntervalMs` afterwards.
            if (!syncing) {
                const now = Date.now();
                const justFinished = inst.openAddress === address && inst.wasSyncing;
                if (justFinished || !inst.lastStoreAt || (now - inst.lastStoreAt) > config.storeIntervalMs) {
                    const st = await this.callWalletRpc('store', {}, 60000, inst);
                    if (!st || !st.error) inst.lastStoreAt = now;
                }
            }
            inst.wasSyncing = syncing;

            const result = {
                total_received: balance,
                total_sent: '0',
                scanned_height: scannedHeight,
                blockchain_height: dHeight,
                unlocked_balance: unlocked,
                balance,
                wallet_ready: !syncing,
                syncing,
                restore_height: restoreHeight,
                scan_start: scanStart
            };

            // Short cache while syncing so progress shows; normal cache once synced.
            this._setCache(cacheKey, result, (syncing ? 3 : config.cacheTtlSeconds) * 1000);
            if (!syncing) {
                sessionManager.saveWalletState(address, { balance, unlocked, scannedHeight, blockchainHeight: dHeight }).catch(() => {});
            }
            return result;
        } finally {
            this.releaseRpcLock(inst, lockToken);
        }
    }

    async getAddressTransactions(address, viewkey, restoreHeight = 0, isNew = false) {
        const cacheKey = `addr_txs:${address}`;
        const cached = this._getCache(cacheKey);
        if (cached) return cached;

        const inst = this.instanceFor(address);
        this._noteUserActivity(inst);
        const lockToken = await this.acquireRpcLock(inst, config.rpcLockTimeoutMs, 'transactions');
        if (!lockToken) {
            return { transactions: [], busy: true };
        }

        try {
            this._noteUserActivity(inst);
            const state = await this.ensureWalletOpen(inst, address, viewkey, restoreHeight, isNew);
            if (state === 'busy') return { transactions: [], busy: true };
            if (state !== 'open') return { transactions: [] };

            const res = await this.callWalletRpc('get_transfers', {
                in: true,
                out: true,
                pending: true,
                failed: false,
                pool: true,
                account_index: 0
            }, 12000, inst);

            if (res && res.error) {
                inst.lastBusyAt = Date.now();
                return { transactions: [], busy: true };
            }
            const txs = [];
            const dHeight = await this.getDaemonHeight();

            // list kind -> { type exposed to UI, direction }
            const processList = (list, type, direction) => {
                if (!Array.isArray(list)) return;
                for (const t of list) {
                    const h = t.height || 0;
                    let confs = '0/10';
                    if (typeof t.confirmations === 'number' && Number.isFinite(t.confirmations) && h > 0) {
                        confs = t.confirmations >= 10 ? '10/10' : `${t.confirmations}/10`;
                    } else if (h > 0 && dHeight >= h) {
                        const count = dHeight - h + 1;
                        confs = count >= 10 ? '10/10' : `${count}/10`;
                    }

                    txs.push({
                        txid: t.txid || t.hash || '',
                        type,
                        direction,
                        amount: t.amount ? t.amount.toString() : '0',
                        unamount: t.amount ? t.amount.toString() : '0',
                        height: h,
                        confirmations: confs,
                        time: t.timestamp || Math.floor(Date.now() / 1000),
                        fee: t.fee ? t.fee.toString() : '0',
                        payment_id: t.payment_id || '0000000000000000',
                        unlock_time: t.unlock_time || 0,
                        locked: typeof t.locked === 'boolean' ? t.locked : undefined
                    });
                }
            };

            if (res && !res.error) {
                processList(res.in, 'in', 'in');
                processList(res.out, 'out', 'out');
                processList(res.pool, 'pool', 'in');       // incoming, waiting in the mempool
                processList(res.pending, 'pool', 'out');   // our own broadcast, not yet mined
            }

            txs.sort((a, b) => b.time - a.time);
            const result = { transactions: txs };
            this._setCache(cacheKey, result, config.cacheTtlSeconds * 1000);
            sessionManager.saveWalletState(address, { txs }).catch(() => {});
            return result;
        } finally {
            this.releaseRpcLock(inst, lockToken);
        }
    }

    parseTxExtra(extra) {
        if (!extra) return { tx_pub_key: '', additional_tx_pub_keys: [] };
        let bytes = [];
        if (Array.isArray(extra)) {
            bytes = extra;
        } else if (typeof extra === 'string') {
            for (let i = 0; i < extra.length; i += 2) {
                bytes.push(parseInt(extra.substr(i, 2), 16));
            }
        }

        let txPubKey = '';
        const additionalKeys = [];
        let i = 0;
        const len = bytes.length;

        while (i < len) {
            const tag = bytes[i++];
            if (tag === 0x00) {
                continue;
            } else if (tag === 0x01) {
                if (i + 32 <= len) {
                    txPubKey = Buffer.from(bytes.slice(i, i + 32)).toString('hex');
                    i += 32;
                } else break;
            } else if (tag === 0x02) {
                if (i < len) {
                    const nlen = bytes[i++];
                    i += nlen;
                }
            } else if (tag === 0x04) {
                if (i < len) {
                    const count = bytes[i++];
                    for (let c = 0; c < count; c++) {
                        if (i + 32 <= len) {
                            additionalKeys.push(Buffer.from(bytes.slice(i, i + 32)).toString('hex'));
                            i += 32;
                        } else break;
                    }
                }
            } else {
                if (i < len) {
                    const slen = bytes[i++];
                    i += slen;
                }
            }
        }

        return { tx_pub_key: txPubKey, additional_tx_pub_keys: additionalKeys };
    }

    async fetchDaemonTransactions(txHashes) {
        if (!Array.isArray(txHashes) || txHashes.length === 0) return {};
        const missing = [];
        const result = {};

        for (const h of txHashes) {
            if (this.txExtraCache.has(h)) {
                result[h] = this.txExtraCache.get(h);
            } else {
                missing.push(h);
            }
        }

        if (missing.length > 0) {
            const daemonRes = await this.callDaemonRest('get_transactions', {
                txs_hashes: missing,
                decode_as_json: true
            });

            if (daemonRes && Array.isArray(daemonRes.txs)) {
                for (const tx of daemonRes.txs) {
                    const h = tx.tx_hash;
                    let parsedJson = null;
                    if (tx.as_json) {
                        try { parsedJson = JSON.parse(tx.as_json); } catch (e) {}
                    }
                    const extraData = this.parseTxExtra(tx.extra || (parsedJson && parsedJson.extra));
                    const data = {
                        hash: h,
                        block_height: tx.block_height || 0,
                        extra: extraData,
                        as_json: parsedJson
                    };
                    this.txExtraCache.set(h, data);
                    result[h] = data;
                }
            }
        }

        return result;
    }

    async getWalletUnspentOutputs(address, viewkey, restoreHeight = 0, isNew = false) {
        const inst = this.instanceFor(address);
        this._noteUserActivity(inst);
        const lockToken = await this.acquireRpcLock(inst, config.rpcLockTimeoutMs, 'unspent_outputs');
        if (!lockToken) return { outputs: [] };

        try {
            const state = await this.ensureWalletOpen(inst, address, viewkey, restoreHeight, isNew);
            if (state !== 'open') return { outputs: [] };

            const transfers = await this.callWalletRpc('incoming_transfers', {
                transfer_type: 'available',
                verbose: true
            }, 12000, inst);

            if (!transfers || !Array.isArray(transfers.transfers) || transfers.transfers.length === 0) {
                return { outputs: [] };
            }

            const txHashes = transfers.transfers.map(t => t.tx_hash).filter(Boolean);
            const daemonTxs = await this.fetchDaemonTransactions(txHashes);

            const outputs = [];
            for (const t of transfers.transfers) {
                const txData = daemonTxs[t.tx_hash];
                let internalIdx = (typeof t.subaddr_index !== 'undefined' && typeof t.subaddr_index.minor !== 'undefined') ? t.subaddr_index.minor : 0;
                const targetKey = t.pubkey || '';

                if (txData && txData.as_json && Array.isArray(txData.as_json.vout)) {
                    for (let idx = 0; idx < txData.as_json.vout.length; idx++) {
                        const vout = txData.as_json.vout[idx];
                        const vKey = (vout.target && (vout.target.tagged_key ? vout.target.tagged_key.key : vout.target.key)) || '';
                        if (vKey && vKey.toLowerCase() === targetKey.toLowerCase()) {
                            internalIdx = idx;
                            break;
                        }
                    }
                }

                let commit = targetKey;
                let mask = '0'.repeat(64);
                if (txData && txData.as_json && txData.as_json.rct_signatures) {
                    const rctSig = txData.as_json.rct_signatures;
                    if (rctSig.outPk && rctSig.outPk[internalIdx]) {
                        commit = String(rctSig.outPk[internalIdx]);
                    }
                    if (rctSig.ecdhInfo && rctSig.ecdhInfo[internalIdx] && rctSig.ecdhInfo[internalIdx].mask) {
                        mask = String(rctSig.ecdhInfo[internalIdx].mask);
                    }
                }

                const extra = txData ? txData.extra : { tx_pub_key: '', additional_tx_pub_keys: [] };
                const allTxPubKeys = [];
                if (extra && extra.tx_pub_key) allTxPubKeys.push(extra.tx_pub_key);
                if (extra && Array.isArray(extra.additional_tx_pub_keys)) {
                    for (const apk of extra.additional_tx_pub_keys) {
                        if (apk && !allTxPubKeys.includes(apk)) allTxPubKeys.push(apk);
                    }
                }
                if (allTxPubKeys.length === 0) allTxPubKeys.push(targetKey);

                const amtStr = t.amount ? t.amount.toString() : '0';
                const gIdx = t.global_index || 0;

                outputs.push({
                    m_amount: amtStr,
                    amount: amtStr,
                    amount_format: 'atomic',
                    m_rct: '01',
                    var_index: gIdx,
                    global_index: gIdx,
                    m_global_output_index: gIdx,
                    out_index: internalIdx,
                    internal_output_index: internalIdx,
                    m_internal_output_index: internalIdx,
                    tx_id: t.tx_hash,
                    tx_hash: t.tx_hash,
                    tx_pub_key: allTxPubKeys[0],
                    tx_pubkey: allTxPubKeys[0],
                    tx_pubkeys: allTxPubKeys,
                    public_key: targetKey,
                    target_key: targetKey,
                    key: targetKey,
                    key_image: t.key_image || '',
                    height: t.block_height || 0,
                    out_pk: commit,
                    mask,
                    rct: mask,
                    vout: { [internalIdx]: { target: { key: targetKey } } },
                    tx_rct: {
                        outPkMask: { [internalIdx]: commit },
                        ecdhInfo: { [internalIdx]: { mask } }
                    },
                    spend_key_images: []
                });
            }

            return { outputs };
        } finally {
            this.releaseRpcLock(inst, lockToken);
        }
    }

    /**
     * Build an UNSIGNED transaction on the watch-only wallet. Nothing is relayed and no
     * spend key is involved; the returned unsigned_txset is signed in the user's browser.
     *
     * `sweepAll` sends the entire unlocked balance (used by the MAX button) via sweep_all,
     * which lets the wallet compute the exact fee instead of guessing it client-side.
     */
    async createUnsignedTransfer({ address, viewkey, toAddress, amountAtomic, priority = 1, restoreHeight = 0, isNew = false, sweepAll = false }) {
        address = (address || '').trim();
        toAddress = (toAddress || '').trim();
        viewkey = (viewkey || '').trim();

        if (!address || !toAddress) {
            return { status: 'Failed', reason: 'Missing source or destination address' };
        }
        if (!sweepAll && (!amountAtomic || !/^[0-9]+$/.test(String(amountAtomic)) || String(amountAtomic).replace(/^0+/, '') === '')) {
            return { status: 'Failed', reason: 'Invalid transfer amount' };
        }

        let prio = parseInt(priority, 10);
        if (!Number.isFinite(prio) || prio < 1 || prio > 4) prio = 1;

        const inst = this.instanceFor(address);
        this._noteUserActivity(inst);
        const lockToken = await this.acquireRpcLock(inst, 60000, 'create_transfer');
        if (!lockToken) {
            return { status: 'Failed', reason: 'Wallet RPC busy, please retry in a moment' };
        }

        try {
            const state = await this.ensureWalletOpen(inst, address, viewkey, restoreHeight, isNew);
            if (state === 'busy') return { status: 'Failed', reason: 'The wallet is busy syncing, please retry in a moment', busy: true };
            if (state !== 'open') {
                return { status: 'Failed', reason: 'Could not open the watch-only wallet for this address' };
            }

            let res;
            if (sweepAll) {
                res = await this.callWalletRpc('sweep_all', {
                    address: toAddress,
                    account_index: 0,
                    priority: prio,
                    ring_size: RING_SIZE,
                    do_not_relay: true,
                    get_tx_hex: false
                }, 120000, inst);
            } else {
                res = await this.callWalletRpc('transfer', {
                    destinations: [{
                        amount: typeof amountAtomic === 'bigint' ? amountAtomic.toString() : String(amountAtomic),
                        address: toAddress
                    }],
                    account_index: 0,
                    priority: prio,
                    ring_size: RING_SIZE,
                    do_not_relay: true,
                    get_tx_hex: false
                }, 120000, inst);
            }

            if (!res || res.error) {
                const errMes = (res && res.error && res.error.message) || 'Failed to create unsigned transaction';
                const errCode = (res && res.error && typeof res.error.code !== 'undefined') ? res.error.code : 'n/a';
                console.error(`[moneroRpc] ${sweepAll ? 'sweep_all' : 'transfer'} rejected by wallet-rpc (code ${errCode}): ${errMes} | from ${address.slice(0, 8)}... to ${toAddress.slice(0, 8)}... amount=${sweepAll ? 'ALL' : amountAtomic} priority=${prio}`);
                return { status: 'Failed', reason: errMes, code: errCode };
            }

            if (!res.unsigned_txset) {
                return { status: 'Failed', reason: 'Wallet did not return unsigned_txset (wallet is not watch-only?)' };
            }

            // The unsigned set only carries outputs whose key image the hot wallet does not know yet
            // (wallet2::export_outputs(all=false)). The browser signer is a fresh wallet, so it also
            // needs the FULL output list, exactly like an offline cold wallet ("export_outputs all").
            const exported = await this.callWalletRpc('export_outputs', { all: true }, 60000, inst);
            if (!exported || exported.error || typeof exported.outputs_data_hex !== 'string') {
                const errMes = (exported && exported.error && exported.error.message) || 'export_outputs failed';
                console.error(`[moneroRpc] export_outputs(all) failed for ${address.slice(0, 8)}...: ${errMes}`);
                return { status: 'Failed', reason: 'Could not export wallet outputs for signing: ' + errMes };
            }

            const sum = (list) => Array.isArray(list) ? list.reduce((acc, v) => acc + BigInt(v || 0), 0n).toString() : null;
            const fee = sweepAll ? sum(res.fee_list) : (typeof res.fee !== 'undefined' ? String(res.fee) : null);
            const amount = sweepAll ? sum(res.amount_list) : (typeof res.amount !== 'undefined' ? String(res.amount) : null);
            const txHashes = sweepAll ? (res.tx_hash_list || []) : (res.tx_hash ? [res.tx_hash] : []);

            return {
                status: 'OK',
                unsigned_txset: res.unsigned_txset,
                outputs_hex: exported.outputs_data_hex,
                fee,
                amount,
                tx_hash: txHashes[0] || '',
                tx_hash_list: txHashes,
                tx_count: txHashes.length
            };
        } finally {
            this.releaseRpcLock(inst, lockToken);
        }
    }

    /**
     * Full output export of the watch-only wallet (encrypted to the view key). The browser
     * loads it into its WASM wallet to compute key images.
     */
    async exportOutputs({ address, viewkey, restoreHeight = 0, isNew = false } = {}) {
        if (!address) return { status: 'Failed', reason: 'Missing wallet address' };
        const inst = this.instanceFor(address);
        this._noteUserActivity(inst);
        const lockToken = await this.acquireRpcLock(inst, config.rpcLockTimeoutMs, 'export_outputs');
        if (!lockToken) return { status: 'Failed', reason: 'Wallet RPC busy, please retry in a moment', busy: true };
        try {
            const state = await this.ensureWalletOpen(inst, address, viewkey, restoreHeight, isNew);
            if (state === 'busy') return { status: 'Failed', reason: 'The wallet is busy syncing, please retry in a moment', busy: true };
            if (state !== 'open') return { status: 'Failed', reason: 'Could not open the watch-only wallet for this address' };
            const res = await this.callWalletRpc('export_outputs', { all: true }, 60000, inst);
            if (!res || res.error || typeof res.outputs_data_hex !== 'string') {
                return { status: 'Failed', reason: (res && res.error && res.error.message) || 'export_outputs failed' };
            }
            return { status: 'OK', outputs_hex: res.outputs_data_hex };
        } finally {
            this.releaseRpcLock(inst, lockToken);
        }
    }

    /**
     * Import signed key images computed in the browser. This is what lets a watch-only
     * wallet know which outputs were spent from somewhere else (another device, another
     * server): without it, every received output counts as still available.
     */
    async importKeyImages({ address, viewkey, restoreHeight = 0, isNew = false, signedKeyImages, offset = 0 } = {}) {
        if (!address) return { status: 'Failed', reason: 'Missing wallet address' };
        if (!Array.isArray(signedKeyImages)) return { status: 'Failed', reason: 'Missing key images' };
        const inst = this.instanceFor(address);
        this._noteUserActivity(inst);
        const lockToken = await this.acquireRpcLock(inst, 60000, 'import_key_images');
        if (!lockToken) return { status: 'Failed', reason: 'Wallet RPC busy, please retry in a moment', busy: true };
        try {
            const state = await this.ensureWalletOpen(inst, address, viewkey, restoreHeight, isNew);
            if (state === 'busy') return { status: 'Failed', reason: 'The wallet is busy syncing, please retry in a moment', busy: true };
            if (state !== 'open') return { status: 'Failed', reason: 'Could not open the watch-only wallet for this address' };
            if (signedKeyImages.length === 0) {
                return { status: 'OK', imported: 0, height: 0, spent: '0', unspent: '0' };
            }
            const res = await this.callWalletRpc('import_key_images', {
                signed_key_images: signedKeyImages,
                offset: offset
            }, 120000, inst);
            if (!res || res.error) {
                const errMes = (res && res.error && res.error.message) || 'import_key_images failed';
                console.error(`[moneroRpc] import_key_images failed for ${address.slice(0, 8)}...: ${errMes}`);
                return { status: 'Failed', reason: errMes };
            }
            await this.callWalletRpc('store', {}, 60000, inst);
            this._invalidateWalletCaches(address);
            return {
                status: 'OK',
                imported: signedKeyImages.length,
                height: res.height || 0,
                spent: typeof res.spent !== 'undefined' ? String(res.spent) : '0',
                unspent: typeof res.unspent !== 'undefined' ? String(res.unspent) : '0'
            };
        } finally {
            this.releaseRpcLock(inst, lockToken);
        }
    }

    /**
     * Broadcast a browser-signed tx set. The signed set contains the wallet's key images,
     * which submit_transfer imports into the open wallet; it is therefore essential that
     * the user's OWN watch-only wallet is open here (another user's wallet would either
     * reject the set or, worse, be corrupted by foreign key images).
     */
    async submitSignedTransfer(signedTxsetHex, { address, viewkey, restoreHeight = 0, isNew = false } = {}) {
        if (!signedTxsetHex || typeof signedTxsetHex !== 'string') {
            return { status: 'Failed', reason: 'Missing signed transaction data' };
        }
        if (!address) {
            return { status: 'Failed', reason: 'Missing wallet address for signed transaction' };
        }

        const inst = this.instanceFor(address);
        this._noteUserActivity(inst);
        const lockToken = await this.acquireRpcLock(inst, 60000, 'submit_signed');
        if (!lockToken) {
            return { status: 'Failed', reason: 'Wallet RPC busy, please retry in a moment' };
        }

        try {
            const state = await this.ensureWalletOpen(inst, address, viewkey, restoreHeight, isNew);
            if (state === 'busy') return { status: 'Failed', reason: 'The wallet is busy syncing, please retry in a moment', busy: true };
            if (state !== 'open') {
                return { status: 'Failed', reason: 'Could not open the watch-only wallet for this address' };
            }

            const res = await this.callWalletRpc('submit_transfer', {
                tx_data_hex: signedTxsetHex.trim()
            }, 60000, inst);

            if (!res || res.error) {
                const errMes = (res && res.error && res.error.message) || 'Broadcast rejected by daemon';
                // wallet2 imports the key images before relaying; with a multi-tx set the first
                // tx may already be out. Persist what the wallet learned either way.
                if (!(res && res.error && res.error.timeout)) await this.callWalletRpc('store', {}, 60000, inst);
                this._invalidateWalletCaches(address);
                return { status: 'Failed', reason: errMes, maybe_broadcast: true };
            }

            // Persist immediately: the imported key images mark the spent outputs. Losing them
            // (crash before the next autosave) would make the wallet re-offer spent outputs.
            await this.callWalletRpc('store', {}, 60000, inst);
            this._invalidateWalletCaches(address);

            const txHashList = res.tx_hash_list || [];
            return {
                status: 'OK',
                txid: txHashList[0] || '',
                tx_hash_list: txHashList
            };
        } finally {
            this.releaseRpcLock(inst, lockToken);
        }
    }

    /**
     * Store every open wallet (used on API shutdown so scan progress is on disk even if the
     * wallet-rpc containers are stopped right after).
     */
    async storeAllOpenWallets(timeoutMs = 20000) {
        await Promise.all(this.instances.map(async (inst) => {
            if (!inst.openAddress) return;
            const token = await this.acquireRpcLock(inst, 2000, 'shutdown_store');
            if (!token) return;
            try {
                const st = await this.callWalletRpc('store', {}, timeoutMs, inst);
                if (!st || !st.error) inst.lastStoreAt = Date.now();
                console.log(`[moneroRpc] shutdown store on instance ${inst.index}: ${(!st || !st.error) ? 'ok' : st.error.message}`);
            } finally {
                this.releaseRpcLock(inst, token);
            }
        }));
    }

    /**
     * Pool health: version of each wallet-rpc instance and whether its lock is busy.
     */
    async getPoolStatus() {
        const now = Date.now();
        const counts = this._assignedCounts();
        const tip = this.lastKnownDaemonHeight || await this.getDaemonHeight();
        const all = await sessionManager.listWallets();
        const backlog = this.instances.map(() => []);
        for (const a of all) {
            const rec = await sessionManager.getWalletRecord(a);
            if (!rec) continue;
            const inst = this.instanceFor(a);
            const behind = (rec.scannedHeight > 0 && tip > 0) ? Math.max(0, tip - rec.scannedHeight) : null;
            backlog[inst.index].push({
                wallet: a.slice(0, 8) + '...',
                blocks_behind: behind,
                open: inst.openAddress === a,
                last_seen_s: rec.lastSeen ? Math.floor((now - rec.lastSeen) / 1000) : null,
                last_warmed_s: rec.lastWarmed ? Math.floor((now - rec.lastWarmed) / 1000) : null
            });
        }
        return Promise.all(this.instances.map(async (inst) => {
            const v = await this.callWalletRpc('get_version', {}, 5000, inst);
            const mine = backlog[inst.index].sort((x, y) => (y.blocks_behind || 0) - (x.blocks_behind || 0));
            return {
                assigned_wallets: counts[inst.index],
                max_blocks_behind: mine.length ? Math.max(0, ...mine.map(w => w.blocks_behind || 0)) : 0,
                wallets: mine.slice(0, 20),
                index: inst.index,
                url: inst.url,
                version: v && v.version ? v.version : null,
                reachable: Boolean(v && v.version),
                lock_busy: inst.isLockHeld,
                lock_holder: inst.isLockHeld ? (inst.lockHolder || null) : null,
                lock_held_s: inst.isLockHeld && inst.lockSince ? Math.max(0, Math.floor((now - inst.lockSince) / 1000)) : null,
                rpc_busy_seconds_ago: inst.lastBusyAt ? Math.floor((now - inst.lastBusyAt) / 1000) : null,
                queue: inst.lockQueue.length,
                open_wallet: inst.openAddress ? (inst.openAddress.slice(0, 8) + '...') : null,
                idle_seconds: inst.lastUserActivity ? Math.floor((now - inst.lastUserActivity) / 1000) : null,
                last_warmed: inst.lastWarmedAddress ? (inst.lastWarmedAddress.slice(0, 8) + '...') : null
            };
        }));
    }

    /**
     * Keep-warm scheduler. For every instance that has had no user request for a while, open
     * the registered wallet (routed to that instance) that was warmed longest ago, then release
     * the lock immediately: wallet-rpc's own auto-refresh keeps scanning it while it sits open.
     * A user request takes the lock and swaps wallets within seconds, so this never blocks
     * anyone; it only makes returning users' wallets minutes instead of weeks behind.
     */
    async warmIdleWallets() {
        const now = Date.now();
        const all = await sessionManager.listWallets();
        if (all.length === 0) return;

        for (const inst of this.instances) {
            if (inst.isLockHeld || inst.lockQueue.length > 0) continue;
            if (inst.lastUserActivity && (now - inst.lastUserActivity) < config.keepWarmIdleMs) continue;
            if (inst.lastBusyAt && (now - inst.lastBusyAt) < config.keepWarmIdleMs) continue; // still catching up

            // A wallet with an open event stream is in use even if its tab rarely polls.
            if (inst.openAddress && this.hasSubscribers(inst.openAddress)) continue;

            const mine = all.filter(a => this.instanceFor(a) === inst && a !== inst.openAddress);
            if (mine.length === 0) continue;

            // A scan must not stop because its owner closed the tab: wallets that are still
            // behind come first (furthest behind first), then the oldest-warmed synced wallet.
            // Wallets not seen for 30 days are left alone. Genesis (height 0) wallets that never
            // finished are continued only on restore lanes, so they cannot pin a regular
            // instance for hours; on a lane that is exactly what lanes are for.
            const isLane = this._scanLaneIndexes().includes(inst.index);
            const tip = this.lastKnownDaemonHeight || 0;
            const allRecords = await Promise.all(mine.map(async a => ({ address: a, rec: (await sessionManager.getWalletRecord(a)) || {} })));
            const behindOf = (rec) => {
                if (rec.stateAt > 0) return Math.max(0, tip - (parseInt(rec.scannedHeight || '0', 10) || 0));
                const start = rec.generatedHeight > 0 ? rec.generatedHeight : (rec.restoreHeight || 0);
                return tip > start ? tip - start : 0; // never synced: everything since its start
            };
            const records = allRecords.filter(({ rec }) => {
                if ((rec.lastSeen || 0) <= now - 30 * 86400000) return false;
                const genesisUnfinished = (rec.restoreHeight || 0) === 0 && (rec.generatedHeight || 0) === 0 && !(rec.stateAt > 0);
                return !genesisUnfinished || isLane;
            });
            records.sort((x, y) => {
                const bx = behindOf(x.rec) > 100 ? 1 : 0, by = behindOf(y.rec) > 100 ? 1 : 0;
                if (bx !== by) return by - bx;                       // unfinished first
                if (bx && by) return behindOf(y.rec) - behindOf(x.rec); // furthest behind first
                return (x.rec.lastWarmed || 0) - (y.rec.lastWarmed || 0);
            });
            const pick = records[0];
            if (!pick) continue;

            const token = await this.acquireRpcLock(inst, 1000, 'keep_warm');
            if (!token) continue;
            try {
                if (inst.lastUserActivity && (Date.now() - inst.lastUserActivity) < config.keepWarmIdleMs) continue;
                const state = await this.ensureWalletOpen(inst, pick.address, '', pick.rec.restoreHeight || 0, false);
                if (state === 'busy') continue;
                if (state !== 'open') {
                    // No file on disk (never generated here) or wallet-rpc refused: skip it next time too.
                    await sessionManager.markWarmed(pick.address, 0);
                    continue;
                }
                const h = await this.callWalletRpc('get_height', {}, 12000, inst);
                const scanned = (h && h.height && !h.error) ? parseInt(h.height, 10) : 0;
                inst.lastWarmedAddress = pick.address;
                await sessionManager.markWarmed(pick.address, scanned);
                console.log(`[keep-warm] instance ${inst.index}: opened ${pick.address.slice(0, 8)}... (scanned ${scanned})`);
            } finally {
                this.releaseRpcLock(inst, token);
            }
        }
    }

    /**
     * Chain watcher: cheap polls of monerod (block count + mempool hashes). On a new block or a
     * mempool change it drops the per-wallet caches and asks every idle instance to refresh its
     * open wallet right away, so incoming/pending transactions show up within seconds instead of
     * waiting for the next 20 s auto-refresh. (Polling stands in for a ZeroMQ subscription.)
     */
    async watchChain() {
        if (this.watcher.running) return;
        this.watcher.running = true;
        try {
            const [countRes, poolRes] = await Promise.all([
                this.callDaemonJsonRpc('get_block_count'),
                this.callDaemonRest('get_transaction_pool_hashes', {})
            ]);
            const height = countRes && countRes.count ? parseInt(countRes.count, 10) : 0;
            const hashes = (poolRes && Array.isArray(poolRes.tx_hashes)) ? poolRes.tx_hashes.slice().sort() : [];
            const poolKey = crypto.createHash('sha1').update(hashes.join(',')).digest('hex');

            const newBlock = height > 0 && this.watcher.height > 0 && height !== this.watcher.height;
            const poolChanged = this.watcher.poolKey && poolKey !== this.watcher.poolKey;
            if (height > 0) {
                this.watcher.height = height;
                this.lastKnownDaemonHeight = height;
                this._setCache('daemon_height', height, config.daemonHeightCacheTtlMs);
            }
            this.watcher.poolKey = poolKey;
            if (!newBlock && !poolChanged) return;

            this.watcher.lastEvent = { type: newBlock ? 'block' : 'pool', height, pool_size: hashes.length, at: Date.now() };
            this._invalidateAllWalletCaches();

            // Debounce with a trailing edge: events inside the window are not dropped, they are
            // coalesced into one refresh round at the end of the window.
            const since = Date.now() - this.watcher.lastRefreshAt;
            if (since < config.chainRefreshDebounceMs) {
                if (!this.watcher.pendingTimer) {
                    this.watcher.pendingTimer = setTimeout(() => {
                        this.watcher.pendingTimer = null;
                        this._refreshRound(this.watcher.lastEvent).catch(() => {});
                    }, config.chainRefreshDebounceMs - since + 50);
                }
                return;
            }
            await this._refreshRound(this.watcher.lastEvent);
        } finally {
            this.watcher.running = false;
        }
    }

    /**
     * Refresh every open wallet (on instances whose lock is free) and tell subscribers. The
     * refresh reply says whether the wallet received money or fetched blocks; that drives an
     * immediate push for that wallet, independent of the chain-wide notification.
     */
    async _refreshRound(event) {
        this.watcher.lastRefreshAt = Date.now();
        const touched = [];
        await Promise.all(this.instances.map(async (inst) => {
            if (!inst.openAddress || inst.isLockHeld) return;
            const token = await this.acquireRpcLock(inst, 500, 'refresh_round');
            if (!token) return;
            try {
                const r = await this.callWalletRpc('refresh', {}, 20000, inst);
                if (r && !r.error && (r.received_money || (r.blocks_fetched && r.blocks_fetched > 0))) {
                    this._invalidateWalletCaches(inst.openAddress);
                    touched.push(inst.openAddress);
                }
            } finally {
                this.releaseRpcLock(inst, token);
            }
        }));
        if (typeof this.onChainEvent === 'function') {
            try { await this.onChainEvent(event, touched); } catch (e) {}
        }
    }

    /**
     * Restore height from any transaction the user knows belongs to the wallet: the tx's
     * block height minus a small margin. Returns { height, tx_height } or null when the tx
     * is unknown / still in the mempool.
     */
    async getHeightForTxid(txid) {
        if (!/^[0-9a-fA-F]{64}$/.test(String(txid || ''))) return null;
        const cacheKey = `height_for_txid:${txid.toLowerCase()}`;
        const cached = this._getCache(cacheKey);
        if (cached !== null) return cached;

        const res = await this.callDaemonRest('get_transactions', { txs_hashes: [txid], decode_as_json: false });
        if (!res || !Array.isArray(res.txs) || res.txs.length === 0) return null;
        const tx = res.txs[0];
        const txHeight = parseInt(tx.block_height, 10);
        if (tx.in_pool || !Number.isFinite(txHeight) || txHeight <= 0) return null;
        const out = { height: Math.max(0, txHeight - 10), tx_height: txHeight };
        this._setCache(cacheKey, out, 3600000);
        return out;
    }

    /**
     * Convert a calendar date (YYYY-MM-DD, UTC) to a block height suitable as restore
     * height: binary search over block header timestamps, then step back a safety margin
     * so a wallet created on that date can never start scanning after its first output.
     */
    async getHeightForDate(dateStr) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
        if (!m) return null;
        const target = Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)) / 1000;
        if (!Number.isFinite(target)) return null;

        const cacheKey = `height_for_date:${dateStr}`;
        const cached = this._getCache(cacheKey);
        if (cached !== null) return cached;

        const GENESIS_TS = 1397818193; // 2014-04-18
        if (target <= GENESIS_TS) return 0;

        const top = await this.getDaemonHeight();
        if (!(top > 0)) return null;

        const headerTs = async (h) => {
            const r = await this.callDaemonJsonRpc('get_block_header_by_height', { height: h });
            return (r && r.block_header && r.block_header.timestamp) ? r.block_header.timestamp : null;
        };

        let lo = 0;
        let hi = top - 1;
        const topTs = await headerTs(hi);
        if (topTs === null) return null;
        if (target >= topTs) {
            const h = Math.max(0, hi - 1440);
            this._setCache(cacheKey, h, 3600000);
            return h;
        }

        // ~22 iterations for 3.8M blocks
        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            const ts = await headerTs(mid);
            if (ts === null) return null;
            if (ts < target) lo = mid + 1; else hi = mid;
        }
        const SAFETY_BLOCKS = 2 * 720; // two days
        const height = Math.max(0, lo - SAFETY_BLOCKS);
        this._setCache(cacheKey, height, 3600000);
        return height;
    }
}

module.exports = new MoneroRpc();
