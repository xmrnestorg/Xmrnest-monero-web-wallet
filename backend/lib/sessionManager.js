const crypto = require('crypto');
const net = require('net');
const config = require('./config');

const SESSION_TTL_SECONDS = 86400;

/**
 * Minimal RESP (Redis protocol) client. Commands are pipelined over one socket and
 * replies are parsed in order. Everything degrades gracefully to memory-only when
 * Redis is unavailable, so the wallet keeps working without it.
 */
class RedisClient {
    constructor(redisUrl) {
        this.url = redisUrl;
        this.socket = null;
        this.ready = false;
        this.buffer = Buffer.alloc(0);
        this.pending = []; // FIFO of { resolve }
        this.reconnectTimer = null;
        this.connect();
    }

    connect() {
        if (!this.url) return;
        let parsed;
        try { parsed = new URL(this.url); } catch (e) { return; }
        const host = parsed.hostname || '127.0.0.1';
        const port = parseInt(parsed.port || '6379', 10);
        const password = parsed.password ? decodeURIComponent(parsed.password) : '';

        const socket = net.createConnection({ host, port });
        socket.setNoDelay(true);
        socket.on('connect', () => {
            this.socket = socket;
            this.ready = true;
            if (password) this.command(['AUTH', password]).catch(() => {});
        });
        socket.on('data', (chunk) => this._onData(chunk));
        const onDown = () => {
            this.ready = false;
            this.socket = null;
            this.buffer = Buffer.alloc(0);
            while (this.pending.length) this.pending.shift().resolve(null);
            if (!this.reconnectTimer) {
                this.reconnectTimer = setTimeout(() => {
                    this.reconnectTimer = null;
                    this.connect();
                }, 5000);
            }
        };
        socket.on('error', onDown);
        socket.on('close', onDown);
    }

    /**
     * Send one command. Resolves with the parsed reply, or null when Redis is unavailable,
     * errors, or does not answer within 1500ms.
     */
    command(args) {
        if (!this.ready || !this.socket) return Promise.resolve(null);
        return new Promise((resolve) => {
            let settled = false;
            const entry = {
                resolve: (val) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    resolve(val instanceof Error ? null : val);
                }
            };
            const timer = setTimeout(() => entry.resolve(null), 1500);
            this.pending.push(entry);
            let cmd = `*${args.length}\r\n`;
            for (const a of args) {
                const s = String(a);
                cmd += `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
            }
            try {
                this.socket.write(cmd);
            } catch (e) {
                entry.resolve(null);
            }
        });
    }

    _onData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            const parsed = this._parse(0);
            if (!parsed) break;
            this.buffer = this.buffer.subarray(parsed.end);
            const entry = this.pending.shift();
            if (entry) entry.resolve(parsed.value);
        }
    }

    // Returns { value, end } or null if the buffer does not yet hold a full reply.
    _parse(offset) {
        const buf = this.buffer;
        if (buf.length <= offset) return null;
        const lineEnd = buf.indexOf('\r\n', offset);
        if (lineEnd === -1) return null;
        const type = String.fromCharCode(buf[offset]);
        const line = buf.toString('utf8', offset + 1, lineEnd);
        const next = lineEnd + 2;
        switch (type) {
            case '+': return { value: line, end: next };
            case '-': return { value: new Error(line), end: next };
            case ':': return { value: parseInt(line, 10), end: next };
            case '$': {
                const len = parseInt(line, 10);
                if (len === -1) return { value: null, end: next };
                if (buf.length < next + len + 2) return null;
                return { value: buf.toString('utf8', next, next + len), end: next + len + 2 };
            }
            case '*': {
                const count = parseInt(line, 10);
                if (count === -1) return { value: null, end: next };
                const items = [];
                let pos = next;
                for (let i = 0; i < count; i++) {
                    const item = this._parse(pos);
                    if (!item) return null;
                    items.push(item.value);
                    pos = item.end;
                }
                return { value: items, end: pos };
            }
            default:
                // Unknown reply type: drop the line to avoid a stuck parser.
                return { value: null, end: next };
        }
    }
}

class SessionManager {
    constructor() {
        this.memorySessions = new Map();
        this.memoryWalletState = new Map(); // address -> { spentKeyImages: Set, pendingTxs: Map }
        this.memoryWalletRecords = new Map(); // address -> parsed wallet record (non-secret)
        this.memoryWalletSet = new Set();     // registry of known wallet addresses
        this.redis = new RedisClient(config.redisUrl);
        this._sweepTimer = setInterval(() => this._sweepExpired(), 10 * 60 * 1000);
        if (this._sweepTimer.unref) this._sweepTimer.unref();
    }

    get isRedisReady() {
        return this.redis.ready;
    }

    _sweepExpired() {
        const now = Date.now();
        for (const [id, s] of this.memorySessions) {
            if (now - (s.lastActive || s.createdAt || 0) > SESSION_TTL_SECONDS * 1000) {
                this.memorySessions.delete(id);
            }
        }
    }

    _getWalletState(address) {
        if (!this.memoryWalletState.has(address)) {
            this.memoryWalletState.set(address, {
                spentKeyImages: new Set(),
                pendingTxs: new Map()
            });
        }
        return this.memoryWalletState.get(address);
    }

    async createSession(address, viewkey, isNew = false, restoreHeight = 0) {
        const sessionId = crypto.randomBytes(16).toString('hex');
        const sessionData = {
            sessionId,
            address,
            viewkey,
            isNew: isNew ? '1' : '0',
            restoreHeight: parseInt(restoreHeight || 0, 10) || 0,
            createdAt: Date.now(),
            lastActive: Date.now()
        };

        this.memorySessions.set(sessionId, sessionData);
        await this.redis.command(['SETEX', `session:${sessionId}`, String(SESSION_TTL_SECONDS), JSON.stringify(sessionData)]);
        return sessionId;
    }

    async getSession(sessionId) {
        if (!sessionId || typeof sessionId !== 'string' || !/^[0-9a-f]{32}$/.test(sessionId)) return null;

        const mem = this.memorySessions.get(sessionId);
        if (mem) {
            if (Date.now() - (mem.lastActive || mem.createdAt) > SESSION_TTL_SECONDS * 1000) {
                await this.destroySession(sessionId);
                return null;
            }
            mem.lastActive = Date.now();
            return mem;
        }

        // Fall back to Redis so sessions survive an API restart.
        const raw = await this.redis.command(['GET', `session:${sessionId}`]);
        if (typeof raw === 'string') {
            try {
                const data = JSON.parse(raw);
                if (data && data.sessionId === sessionId && data.address && data.viewkey) {
                    data.lastActive = Date.now();
                    this.memorySessions.set(sessionId, data);
                    return data;
                }
            } catch (e) {}
        }
        return null;
    }

    async destroySession(sessionId) {
        if (!sessionId) return;
        this.memorySessions.delete(sessionId);
        await this.redis.command(['DEL', `session:${sessionId}`]);
    }

    /**
     * Per-wallet registry keyed by public address. Holds only non-secret facts we want to
     * remember across sessions, most importantly the restore height, so a re-import or a
     * wallet regeneration never falls back to a scan from genesis.
     */
    _parseWalletRecord(rec) {
        let txs = [];
        try { txs = rec.txs ? JSON.parse(rec.txs) : []; } catch (e) { txs = []; }
        return {
            restoreHeight: parseInt(rec.restoreHeight || '0', 10) || 0,
            source: rec.source || 'unknown',
            subaddrNext: parseInt(rec.subaddrNext || '0', 10) || 0,
            updatedAt: parseInt(rec.updatedAt || '0', 10) || 0,
            lastSeen: parseInt(rec.lastSeen || '0', 10) || 0,
            lastWarmed: parseInt(rec.lastWarmed || '0', 10) || 0,
            // wallet-rpc pool instance this wallet is pinned to (null = not yet placed)
            instance: (rec.instance !== undefined && rec.instance !== '' && Number.isFinite(parseInt(rec.instance, 10))) ? parseInt(rec.instance, 10) : null,
            // the wallet FILE: which filename holds it and the restore height it was generated with
            walletFile: rec.walletFile || null,
            generatedHeight: (rec.generatedHeight !== undefined && rec.generatedHeight !== '') ? (parseInt(rec.generatedHeight, 10) || 0) : null,
            // a later login asked for a higher start height; applied under the instance lock
            pendingRegenerate: parseInt(rec.pendingRegenerate || '0', 10) || 0,
            regenerateDeclined: parseInt(rec.regenerateDeclined || '0', 10) || 0,
            // last-known state (served with stale=true while an instance is busy)
            balance: rec.balance || null,
            unlocked: rec.unlocked || null,
            scannedHeight: parseInt(rec.scannedHeight || '0', 10) || 0,
            blockchainHeight: parseInt(rec.blockchainHeight || '0', 10) || 0,
            stateAt: parseInt(rec.stateAt || '0', 10) || 0,
            txs
        };
    }

    // Memory holds the RAW string fields exactly as Redis does; every read parses, so numbers
    // never drift into strings after an in-memory update.
    async _rawWalletRecord(address) {
        const mem = this.memoryWalletRecords.get(address);
        if (mem) return mem;
        const raw = await this.redis.command(['HGETALL', `wallet:${address}`]);
        if (Array.isArray(raw) && raw.length >= 2) {
            const rec = {};
            for (let i = 0; i + 1 < raw.length; i += 2) rec[raw[i]] = raw[i + 1];
            this.memoryWalletRecords.set(address, rec);
            return rec;
        }
        return null;
    }

    async getWalletRecord(address) {
        if (!address) return null;
        const raw = await this._rawWalletRecord(address);
        return raw ? this._parseWalletRecord(raw) : null;
    }

    async _updateWalletRecord(address, fields) {
        const current = (await this._rawWalletRecord(address)) || {};
        const strFields = {};
        for (const [k, v] of Object.entries(fields)) strFields[k] = typeof v === 'string' ? v : JSON.stringify(v);
        Object.assign(current, strFields);
        this.memoryWalletRecords.set(address, current);
        const args = ['HSET', `wallet:${address}`];
        for (const [k, v] of Object.entries(strFields)) args.push(k, v);
        await this.redis.command(args);
    }

    async saveWalletRecord(address, { restoreHeight, source }) {
        if (!address) return;
        await this._updateWalletRecord(address, {
            restoreHeight: String(parseInt(restoreHeight || 0, 10) || 0),
            source: String(source || 'manual').slice(0, 16),
            updatedAt: String(Date.now())
        });
    }

    /**
     * Registry of every wallet that ever logged in (public address only). Used by the
     * keep-warm scheduler so returning users find a wallet that is minutes, not weeks, behind.
     */
    async registerWallet(address) {
        if (!address) return;
        this.memoryWalletSet.add(address);
        await this.redis.command(['SADD', 'wallets:all', address]);
        await this._updateWalletRecord(address, { lastSeen: String(Date.now()) });
    }

    async listWallets() {
        const stored = await this.redis.command(['SMEMBERS', 'wallets:all']);
        if (Array.isArray(stored)) {
            for (const a of stored) if (typeof a === 'string') this.memoryWalletSet.add(a);
        }
        return Array.from(this.memoryWalletSet);
    }

    async setWalletFile(address, { walletFile, generatedHeight }) {
        if (!address) return;
        await this._updateWalletRecord(address, {
            walletFile: String(walletFile || ''),
            generatedHeight: String(parseInt(generatedHeight || 0, 10) || 0),
            pendingRegenerate: '0'
        });
    }

    async setPendingRegenerate(address, height) {
        if (!address) return;
        await this._updateWalletRecord(address, { pendingRegenerate: String(parseInt(height || 0, 10) || 0) });
    }

    async setRegenerateDeclined(address, height) {
        if (!address) return;
        await this._updateWalletRecord(address, { pendingRegenerate: '0', regenerateDeclined: String(parseInt(height || 0, 10) || 0) });
    }

    async setWalletInstance(address, index) {
        if (!address || !Number.isFinite(index)) return;
        await this._updateWalletRecord(address, { instance: String(index) });
    }

    /**
     * Reserve the next subaddress index for a wallet (account 0). Persisted per wallet so a
     * new login continues after the last one handed out instead of restarting at #1.
     */
    async nextSubaddressIndex(address) {
        if (!address) return null;
        const r = await this.redis.command(['HINCRBY', `wallet:${address}`, 'subaddrNext', '1']);
        let idx;
        if (Number.isInteger(r) && r > 0) {
            idx = r;
        } else {
            const rec = (await this.getWalletRecord(address)) || {};
            idx = (parseInt(rec.subaddrNext || '0', 10) || 0) + 1;
        }
        // Keep the in-memory RAW record in step (it must hold strings, never a parsed record).
        await this._updateWalletRecord(address, { subaddrNext: String(idx) });
        return idx;
    }

    async markWarmed(address, scannedHeight) {
        if (!address) return;
        const fields = { lastWarmed: String(Date.now()) };
        if (Number.isFinite(scannedHeight) && scannedHeight > 0) fields.scannedHeight = String(scannedHeight);
        await this._updateWalletRecord(address, fields);
    }

    /** Persist the last successfully read balance / height / recent txs for stale fallback. */
    async saveWalletState(address, { balance, unlocked, scannedHeight, blockchainHeight, txs }) {
        if (!address) return;
        const fields = { stateAt: String(Date.now()) };
        if (typeof balance === 'string') fields.balance = balance;
        if (typeof unlocked === 'string') fields.unlocked = unlocked;
        if (Number.isFinite(scannedHeight)) fields.scannedHeight = String(scannedHeight);
        if (Number.isFinite(blockchainHeight)) fields.blockchainHeight = String(blockchainHeight);
        if (Array.isArray(txs)) fields.txs = JSON.stringify(txs.slice(0, 10));
        await this._updateWalletRecord(address, fields);
    }

    async getSpentKeyImages(sessionId) {
        const session = await this.getSession(sessionId);
        if (!session) return [];
        const state = this._getWalletState(session.address);
        if (state.spentKeyImages.size === 0) {
            const stored = await this.redis.command(['SMEMBERS', `spent:${session.address}`]);
            if (Array.isArray(stored)) {
                for (const ki of stored) if (typeof ki === 'string') state.spentKeyImages.add(ki);
            }
        }
        return Array.from(state.spentKeyImages);
    }

    async addPendingTx(sessionId, txInfo) {
        const session = await this.getSession(sessionId);
        if (!session || !txInfo || !txInfo.txid) return;
        const state = this._getWalletState(session.address);
        state.pendingTxs.set(txInfo.txid, txInfo);
        try {
            await this.redis.command(['HSET', `pending:${session.address}`, txInfo.txid, JSON.stringify(txInfo)]);
        } catch (e) {}
    }

    async getPendingTxs(sessionId) {
        const session = await this.getSession(sessionId);
        if (!session) return [];
        const state = this._getWalletState(session.address);
        if (state.pendingTxs.size === 0) {
            try {
                const stored = await this.redis.command(['HGETALL', `pending:${session.address}`]);
                if (Array.isArray(stored)) {
                    for (let i = 1; i < stored.length; i += 2) {
                        const parsed = JSON.parse(stored[i]);
                        if (parsed && parsed.txid) state.pendingTxs.set(parsed.txid, parsed);
                    }
                }
            } catch (e) {}
        }
        return Array.from(state.pendingTxs.values());
    }

    async removePendingTx(sessionId, txid) {
        const session = await this.getSession(sessionId);
        if (!session || !txid) return;
        const state = this._getWalletState(session.address);
        state.pendingTxs.delete(txid);
        try {
            await this.redis.command(['HDEL', `pending:${session.address}`, txid]);
        } catch (e) {}
    }
    /* ------------------------------------------------------------ swap orders */

    /**
     * Swap orders are keyed by wallet address so they survive reloads and re-logins. The
     * record holds the gateway's `orderToken` (see docs/swap-gateway-api.md); it lets the
     * wallet read the order again from another browser and is never returned to the browser
     * (see swapClient.historyRow).
     */
    async addSwapOrder(address, record) {
        if (!address || !record || !record.orderId) return;
        const key = `swaps:${address}`;
        await this.redis.command(['HSET', key, record.orderId, JSON.stringify(record)]);
        await this.redis.command(['EXPIRE', key, String(90 * 86400)]); // swap history is not kept forever
        // keep the hash bounded: drop the oldest beyond 50
        const all = await this.listSwapOrders(address);
        if (all.length > 50) {
            const extra = all.slice(50).map(r => r.orderId);
            if (extra.length) await this.redis.command(['HDEL', key, ...extra]);
        }
    }

    async listSwapOrders(address) {
        if (!address) return [];
        const raw = await this.redis.command(['HGETALL', `swaps:${address}`]);
        const out = [];
        if (Array.isArray(raw)) {
            for (let i = 0; i + 1 < raw.length; i += 2) {
                try {
                    const rec = JSON.parse(raw[i + 1]);
                    if (rec && rec.orderId) out.push(rec);
                } catch (e) {}
            }
        }
        out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return out;
    }

    async getSwapOrder(address, orderId) {
        if (!address || !orderId) return null;
        const raw = await this.redis.command(['HGET', `swaps:${address}`, String(orderId)]);
        if (typeof raw !== 'string') return null;
        try {
            const rec = JSON.parse(raw);
            return (rec && rec.orderId) ? rec : null;
        } catch (e) {
            return null;
        }
    }

    async updateSwapOrder(address, orderId, patch) {
        const rec = await this.getSwapOrder(address, orderId);
        if (!rec) return null;
        Object.assign(rec, patch || {});
        await this.redis.command(['HSET', `swaps:${address}`, rec.orderId, JSON.stringify(rec)]);
        await this.redis.command(['EXPIRE', `swaps:${address}`, String(90 * 86400)]);
        return rec;
    }
}

module.exports = new SessionManager();
