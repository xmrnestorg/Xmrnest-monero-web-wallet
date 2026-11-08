/**
 * XmrNest Wallet State & Multi-Account Manager
 * Strictly ephemeral in-memory wallet management: zero disk storage, session wiped completely on refresh or tab close.
 */
(function(window) {
    'use strict';

    var listeners = {
        walletChange: [],
        balanceChange: [],
        syncChange: [],
        transactionsChange: [],
        newTransactions: [],
        keyImagesSynced: [],
        keyImagesSyncFailed: [],
        priceChange: [],
        feesChange: [],
        backendAlert: []
    };

    // In-memory ephemeral wallet list (reset to empty whenever page is reloaded/refreshed)
    var inMemoryWallets = [];

    var WalletState = {
        // Active session properties
        sessionId: '',
        address: '',
        viewkey: '',
        spendkey: '',
        seed: '',
        mainKeys: null,
        currentSubindex: 0,
        restoreHeight: 0,         // effective restore height the backend scans from
        restoreSource: '',        // manual | date | txid | stored | new | genesis
        stale: false,             // last poll was served from the backend's last-known snapshot
        staleAsOf: 0,
        syncing: false,           // wallet has not reached the chain tip yet (balance not final)
        scanStart: null,          // height the server-side wallet file actually scans from

        // Financial & Network State
        balance: null,            // JSBigInt
        unlockedBalance: null,    // JSBigInt
        usdPrice: 0.0,
        feeLevels: null,          // [low, normal, high, urgent] atomic units per byte
        syncStatus: null,
        transactions: [],

        // Polling timers
        _pollTimers: [],
        _events: null,            // EventSource for /api/events
        _eventsRetryMs: 2000,
        _eventsConnected: false,
        _lastTxIds: null,

        /**
         * Subscribe to state change events
         */
        on: function(event, callback) {
            if (listeners[event]) {
                listeners[event].push(callback);
            }
        },

        emit: function(event, data) {
            if (listeners[event]) {
                listeners[event].forEach(function(cb) {
                    try { cb(data); } catch(e) { console.error('Listener error:', e); }
                });
            }
        },

        isSignedIn: function() {
            return Boolean(this.sessionId && this.address);
        },

        /**
         * Get list of connected wallets in current tab memory (ephemeral, wiped on refresh/close)
         */
        getConnectedWallets: function() {
            return inMemoryWallets.slice();
        },

        /**
         * Save or update connected wallet in tab memory
         */
        saveConnectedWallet: function(walletData) {
            var idx = inMemoryWallets.findIndex(function(item) { return item.address === walletData.address; });
            if (idx !== -1) {
                inMemoryWallets[idx] = Object.assign({}, inMemoryWallets[idx], walletData);
            } else {
                walletData.name = 'Wallet ' + (inMemoryWallets.length + 1);
                inMemoryWallets.push(walletData);
            }
            this.emit('walletChange', this);
        },

        /**
         * Update cached balance of a specific address in tab memory
         */
        updateStoredBalance: function(addr, balStr) {
            var changed = false;
            inMemoryWallets.forEach(function(item) {
                if (item.address === addr && item.balance !== balStr) {
                    item.balance = balStr;
                    changed = true;
                }
            });
            if (changed) {
                this.emit('walletChange', this);
            }
        },

        /**
         * Disconnect and remove a wallet from tab memory
         */
        removeConnectedWallet: async function(addr) {
            var target = inMemoryWallets.find(function(item) { return item.address === addr; });
            if (target && target.session_id) {
                await window.XMR_API.logout(target.session_id);
            }

            inMemoryWallets = inMemoryWallets.filter(function(item) { return item.address !== addr; });

            if (this.address === addr) {
                if (inMemoryWallets.length > 0) {
                    await this.switchWallet(inMemoryWallets[0].address);
                } else {
                    this.reset();
                }
            } else {
                this.emit('walletChange', this);
            }
        },

        /**
         * Disconnect all wallets and wipe all sessions
         */
        disconnectAll: async function() {
            for (var i = 0; i < inMemoryWallets.length; i++) {
                if (inMemoryWallets[i].session_id) {
                    await window.XMR_API.logout(inMemoryWallets[i].session_id);
                }
            }
            inMemoryWallets = [];
            try { sessionStorage.clear(); } catch(e) {}
            try { localStorage.clear(); } catch(e) {}
            this.reset();
        },

        /**
         * Reset current in-memory active wallet state
         */
        reset: function() {
            this.stopPolling();
            this.sessionId = '';
            this.address = '';
            this.viewkey = '';
            this.spendkey = '';
            this.seed = '';
            this.mainKeys = null;
            this.currentSubindex = 0;
            this.restoreHeight = 0;
            this.restoreSource = '';
            this.syncing = false;
            this.stale = false;
            this.scanStart = null;
            this.balance = null;
            this.unlockedBalance = null;
            this.syncStatus = null;
            this.transactions = [];
            this.emit('walletChange', this);
        },

        /**
         * Switch active wallet to another connected account
         */
        switchWallet: async function(addr) {
            var wallets = this.getConnectedWallets();
            var w = wallets.find(function(item) { return item.address === addr; });
            if (!w) return false;

            this.stopPolling();

            this.sessionId = w.session_id || '';
            this.address = w.address || '';
            this.viewkey = w.viewkey || '';
            this.spendkey = w.spendkey || '';
            this.seed = w.seed || '';
            this.restoreHeight = w.restore_height || 0;
            this.restoreSource = w.restore_source || '';
            this.currentSubindex = 0;
            // Never show the previous wallet's numbers while this one loads.
            this.balance = null;
            this.unlockedBalance = null;
            this.transactions = [];
            this.syncStatus = null;
            this._lastTxIds = null;
            this.emit('transactionsChange', []);
            this.emit('syncChange', { loading: true });

            // Subaddress keys come from the private keys themselves, which exist for every
            // spendable wallet (25-word seed in any language, Polyseed, or raw keys). The seed
            // string is never re-decoded here.
            this.mainKeys = null;
            if (this.viewkey && this.spendkey) {
                try {
                    this.mainKeys = {
                        view: cnUtil.generate_keys(this.viewkey),
                        spend: cnUtil.generate_keys(this.spendkey)
                    };
                } catch(e) {
                    this.mainKeys = null;
                }
            }

            this.emit('walletChange', this);

            this.startPolling();
            return true;
        },

        /**
         * Initialize active session on page load (Strictly Ephemeral - Session wiped on refresh)
         */
        initFromStorage: async function() {
            // Strictly ephemeral: purge all storage and memory on page reload/refresh
            inMemoryWallets = [];
            try { sessionStorage.clear(); } catch(e) {}
            try { localStorage.clear(); } catch(e) {}
            this.reset();
            return false;
        },

        /**
         * Derive next subaddress
         */
        generateNextSubaddress: async function() {
            if (!this.mainKeys) return null;
            // The index is reserved server-side so it survives logouts and other devices.
            var idx = null;
            try { idx = await window.XMR_API.nextSubaddressIndex(this.sessionId); } catch (e) { idx = null; }
            if (idx === null) return { error: 'Could not reserve a new subaddress index (limit reached or server unavailable).' };
            this.currentSubindex = idx;
            var sub = (typeof deriveSubaddress === 'function')
                ? deriveSubaddress(this.mainKeys, 0, idx)
                : (cnUtil.deriveSubaddress ? cnUtil.deriveSubaddress(this.mainKeys, 0, idx) : null);
            return { address: sub, index: idx };
        },

        /**
         * Polling Loops
         */
        startPolling: function() {
            this.stopPolling();
            var self = this;

            // Immediate initial fetch
            self.pollPrice();
            if (self.sessionId) {
                self.pollFees();
                self.pollState();
            }

            self._pollTimers.push(setInterval(function() { self.pollPrice(); }, 60000));
            self._pollTimers.push(setInterval(function() { if (self.sessionId) self.pollFees(); }, 60000));
            // One request carries balance + sync height + transactions. The event stream pushes
            // changes in between; this is the 15 s safety net that catches anything it missed.
            // While a scan runs the answer comes from the scan log in milliseconds, so poll
            // every 5 s to keep the progress bar moving; 15 s once synced.
            self._pollTimers.push(setInterval(function() {
                if (!self.sessionId) return;
                var since = Date.now() - (self._lastPollAt || 0);
                if (self.syncing ? since >= 4500 : since >= 14500) self.pollState();
            }, 5000));
            // Browsers throttle timers in background tabs: poll as soon as the tab is visible again.
            if (!self._visibilityBound) {
                self._visibilityBound = true;
                document.addEventListener('visibilitychange', function() {
                    if (document.visibilityState === 'visible' && self.sessionId) self.pollState();
                });
            }
            self.connectEvents();
        },

        /**
         * Spent-output sync. A watch-only wallet cannot know which of its outputs were spent
         * from another device or server. With the spend key available in this session we can
         * compute the key images locally and hand them to the backend, which then marks the
         * spends and shows the outgoing history. Runs once per session for a spendable wallet.
         */
        _keyImagesSynced: {},
        _keyImagesSyncing: false,
        syncKeyImages: async function(force) {
            var self = this;
            var sid = self.sessionId;
            if (!sid || !self.spendkey) return { skipped: 'no spend key' };
            if (!force && self._keyImagesSynced[self.address]) return { skipped: 'already synced' };
            if (self._keyImagesSyncing) return { skipped: 'in progress' };
            if (!window.TransactionManager || !window.TransactionManager.loadSigner) return { skipped: 'no signer' };
            self._keyImagesSyncing = true;
            try {
                var ok = await window.TransactionManager.loadSigner();
                if (!ok || self.sessionId !== sid) return { skipped: 'signer unavailable' };

                var exported = await window.XMR_API.exportOutputs(sid);
                if (self.sessionId !== sid) return { skipped: 'wallet switched' };
                if (!exported || exported.status !== 'OK' || typeof exported.outputs_hex !== 'string') {
                    return { error: (exported && exported.reason) || 'export failed', busy: Boolean(exported && exported.busy) };
                }
                var images;
                try {
                    images = await window.MoneroSigner.exportKeyImages(self.address, self.viewkey, self.spendkey, exported.outputs_hex);
                } catch (e) {
                    return { error: 'key image computation failed: ' + e.message };
                }
                if (self.sessionId !== sid) return { skipped: 'wallet switched' };
                var res = await window.XMR_API.importKeyImages(sid, images, 0);
                if (res && res.status === 'OK') {
                    self._keyImagesSynced[self.address] = true;
                    self.emit('keyImagesSynced', { imported: res.imported, spent: res.spent, unspent: res.unspent });
                    setTimeout(function() { if (self.sessionId === sid) self.pollState(); }, 500);
                    return res;
                }
                return { error: (res && res.reason) || 'import failed', busy: Boolean(res && res.busy) };
            } finally {
                self._keyImagesSyncing = false;
            }
        },

        /**
         * Server-sent events: the backend pushes a `state` event whenever this wallet's
         * balance, scan height or transactions change (new block, mempool tx, own broadcast).
         */
        connectEvents: async function() {
            var self = this;
            self.disconnectEvents();
            if (!self.sessionId || typeof EventSource === 'undefined') return;
            var sid = self.sessionId;
            var gen = (self._eventsGen = (self._eventsGen || 0) + 1);
            var token = null;
            try { token = await window.XMR_API.getEventToken(sid); } catch (e) { token = null; }
            if (!token || self.sessionId !== sid) return;
            // A second connect started while we waited for the token: let that one win.
            if (gen !== self._eventsGen || self._events) return;

            var es = new EventSource('/api/events?t=' + encodeURIComponent(token));
            self._events = es;
            es.addEventListener('hello', function() {
                self._eventsConnected = true;
                self._eventsRetryMs = 2000;
            });
            es.addEventListener('state', function(ev) {
                if (self.sessionId !== sid) return;
                try {
                    var data = JSON.parse(ev.data);
                    self._stateSeq = (self._stateSeq || 0) + 1;
                    self._lastAppliedSeq = self._stateSeq;
                    self._missedPolls = 0;
                    self.applyState(data);
                } catch (e) {}
            });
            es.onerror = function() {
                self._eventsConnected = false;
                try { es.close(); } catch (e) {}
                if (self._events === es) self._events = null;
                if (self.sessionId !== sid) return;
                var delay = self._eventsRetryMs;
                self._eventsRetryMs = Math.min(60000, self._eventsRetryMs * 2);
                setTimeout(function() { if (self.sessionId === sid && !self._events) self.connectEvents(); }, delay);
            };
        },

        disconnectEvents: function() {
            if (this._events) {
                try { this._events.close(); } catch (e) {}
            }
            this._events = null;
            this._eventsConnected = false;
        },

        _applyBalance: function(balanceStr, unlockedStr) {
            this.balance = (typeof JSBigInt !== 'undefined') ? new JSBigInt(balanceStr) : balanceStr;
            this.unlockedBalance = (typeof JSBigInt !== 'undefined') ? new JSBigInt(unlockedStr) : unlockedStr;
            var balStr = (typeof formatXmr === 'function') ? formatXmr(this.balance) : '0';
            this.updateStoredBalance(this.address, balStr);
            this.emit('balanceChange', this);
        },

        pollState: async function() {
            if (!this.sessionId) return;
            this._lastPollAt = Date.now();
            var sid = this.sessionId;
            // Sequence numbers: a slow older answer must never overwrite a newer one (it would
            // re-announce transactions and flash an old balance).
            var seq = (this._stateSeq = (this._stateSeq || 0) + 1);
            var data = null;
            try { data = await window.XMR_API.getState(sid); } catch (e) { data = null; }
            if (this.sessionId !== sid) return;
            if (seq < (this._lastAppliedSeq || 0)) return;
            if (!data) {
                // Two missed polls in a row: say so instead of showing a stale "Synced".
                this._missedPolls = (this._missedPolls || 0) + 1;
                if (this._missedPolls === 2) { this.syncStatus = null; this.emit('syncChange', null); }
                return;
            }
            this._missedPolls = 0;
            this._lastAppliedSeq = seq;
            this.applyState(data);
        },

        /**
         * Apply a combined state payload (from a poll or a pushed event).
         */
        applyState: function(data) {
            if (!data) return;
            // A busy answer with no snapshot still tells us one thing: the wallet is syncing.
            if (data.busy && !data.stale) {
                if (data.syncing && data.height) {
                    this.syncing = true;
                    if (data.restore_height && !this.restoreHeight) this.restoreHeight = data.restore_height;
                    if (typeof data.scan_start === 'number') this.scanStart = data.scan_start;
                    this.syncStatus = { current: data.height.current, target: data.height.target, synced: false, syncing: true, stale: false, asOf: 0, scanStart: this.scanStart, queued: Boolean(data.queued), busy: true };
                    this.emit('syncChange', this.syncStatus);
                    this.emit('balanceChange', this);
                }
                return;
            }
            this.stale = Boolean(data.stale);
            this.staleAsOf = data.stale ? (data.as_of || 0) : 0;
            this.syncing = Boolean(data.syncing);
            if (data.restore_height && !this.restoreHeight) this.restoreHeight = data.restore_height;
            if (typeof data.scan_start === 'number') this.scanStart = data.scan_start;
            // "wallet could not be opened" answers carry zeros with wallet_ready=false and no
            // syncing flag: treat them as unknown, keep the current display.
            if (data.wallet_ready === false && !data.syncing && !data.stale) return;
            if (typeof data.balance === 'string' && typeof data.unlocked === 'string' && /^[0-9]+$/.test(data.balance) && /^[0-9]+$/.test(data.unlocked)) {
                this._applyBalance(data.balance, data.unlocked, null);
            }
            if (data.height) {
                this.syncStatus = {
                    current: data.height.current,
                    target: data.height.target,
                    synced: !data.syncing && (data.height.target - data.height.current) <= 1,
                    syncing: Boolean(data.syncing),
                    stale: Boolean(data.stale),
                    asOf: data.stale ? (data.as_of || 0) : 0,
                    scanStart: this.scanStart
                };
                this.emit('syncChange', this.syncStatus);
            } else if (data.height === null) {
                this.syncStatus = null;
                this.emit('syncChange', null);
            }
            // Spent-output sync runs once the wallet is synced (its output list is complete then).
            if (!this.syncing && !this.stale && this.spendkey && !this._keyImagesSynced[this.address] && !this._keyImagesSyncing) {
                var selfKI = this;
                setTimeout(function() {
                    selfKI.syncKeyImages().then(function(r) {
                        if (r && r.error && !r.busy) selfKI.emit('keyImagesSyncFailed', r.error);
                    }).catch(function() {});
                }, 200);
            }
            if (Array.isArray(data.transactions)) {
                // Announce transactions we have not seen in this session (incoming or just broadcast).
                var ids = data.transactions.map(function(t) { return t.txid; });
                if (this._lastTxIds) {
                    var seen = this._lastTxIds;
                    var fresh = data.transactions.filter(function(t) { return t.txid && seen.indexOf(t.txid) === -1; });
                    if (fresh.length) this.emit('newTransactions', fresh);
                }
                this._lastTxIds = ids;
                this.transactions = data.transactions;
                this.emit('transactionsChange', this.transactions);
            }
        },

        pollFees: async function() {
            var data = await window.XMR_API.getFees();
            if (data && Array.isArray(data.fees)) {
                this.feeLevels = data.fees.map(function(v) { return parseInt(v, 10); });
                this.emit('feesChange', this.feeLevels);
            }
        },

        stopPolling: function() {
            this._pollTimers.forEach(clearInterval);
            this._pollTimers = [];
            this.disconnectEvents();
            this._lastTxIds = null;
        },

        pollPrice: async function() {
            var data = await window.XMR_API.getPrice();
            if (data && data.USD) {
                this.usdPrice = parseFloat(data.USD);
                this.emit('priceChange', this.usdPrice);
                this.emit('balanceChange', this);
            }
        }
    };

    window.WalletState = WalletState;
})(window);
