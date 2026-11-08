/**
 * XmrNest REST API Client
 * Clean, lightweight, dependency-free HTTP client for all /api/* endpoints.
 *
 * Only the address, the private VIEW key and a session id ever travel to the server.
 * There is intentionally no method that accepts a spend key.
 */
(function(window) {
    'use strict';

    var XMR_API = {
        /**
         * Helper to perform POST requests with urlencoded data (matching server.js expectations)
         */
        _post: async function(url, data) {
            var params = new URLSearchParams();
            if (data) {
                for (var key in data) {
                    if (Object.prototype.hasOwnProperty.call(data, key)) {
                        params.append(key, data[key]);
                    }
                }
            }

            var resp = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: params.toString()
            });

            if (!resp.ok) {
                throw new Error('API HTTP ' + resp.status + ' error for ' + url);
            }
            return await resp.text();
        },

        /**
         * POST expecting a JSON body. Unlike _post, non-2xx responses are still parsed so the
         * server's `reason` reaches the UI instead of a generic HTTP error.
         */
        _postJson: async function(url, data) {
            var params = new URLSearchParams();
            if (data) {
                for (var key in data) {
                    if (Object.prototype.hasOwnProperty.call(data, key)) {
                        params.append(key, data[key]);
                    }
                }
            }
            var resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params.toString()
            });
            var text = await resp.text();
            try {
                return JSON.parse(text);
            } catch (e) {
                return { status: 'Failed', reason: 'API HTTP ' + resp.status + ' error for ' + url };
            }
        },

        /**
         * Helper to perform GET requests
         */
        _getJson: async function(url) {
            var resp = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json'
                }
            });
            if (!resp.ok) {
                throw new Error('API HTTP ' + resp.status + ' error for ' + url);
            }
            return await resp.json();
        },

        /**
         * Authenticate or create wallet session
         * @param {string} address - Monero primary address
         * @param {string} viewkey - Private view key
         * @param {number} restoreHeight - Scan start block height (optional)
         * @param {string|number} isNew - '1' for new wallet, '0' for restore
         */
        auth: async function(address, viewkey, restoreHeight, isNew, restoreSource, confirmFullScan, pow) {
            var fields = {
                address: address,
                viewkey: viewkey,
                restore_height: restoreHeight || 0,
                restore_source: restoreSource || 'manual',
                isnew: isNew ? '1' : '0',
                confirm_full_scan: confirmFullScan ? '1' : '0'
            };
            if (pow && pow.challenge && pow.nonce) {
                fields.pow_challenge = pow.challenge;
                fields.pow_nonce = pow.nonce;
            }
            var res = await this._post('/api/auth', fields);
            var idx = res.indexOf(':');
            var code = idx === -1 ? res : res.slice(0, idx);
            var rest = idx === -1 ? '' : res.slice(idx + 1);
            if (code === '1') {
                // "1:<sessionId>:<effectiveRestoreHeight>:<source>" (source: manual|date|txid|stored|new|genesis)
                var parts = rest.split(':');
                return {
                    success: true,
                    sessionId: parts[0],
                    restoreHeight: parseInt(parts[1] || '0', 10) || 0,
                    restoreSource: parts[2] || 'manual'
                };
            }
            if (rest.indexOf('POW_REQUIRED:') === 0) {
                // New wallet on this server: the browser must solve a small puzzle first (no IP
                // tracking exists, this is what stops floods of fake wallets).
                var pp = rest.split(':');
                return { success: false, needsPow: true, powChallenge: pp[1], powBits: parseInt(pp[2], 10) || 16, error: 'Proof of work required' };
            }
            if (rest === 'FULL_SCAN_CONFIRM') {
                // No height given and the server has none stored for this wallet.
                return { success: false, needsFullScanConfirm: true, error: 'A full scan from block 0 needs confirmation' };
            }
            return { success: false, error: rest || 'Authentication failed' };
        },

        /**
         * Fetch current XMR exchange price
         */
        getPrice: async function() {
            try {
                return await this._getJson('/api/price');
            } catch (e) {
                console.warn('Failed to load XMR price:', e);
                return null;
            }
        },

        /**
         * One combined poll: balance, sync height, recent transactions.
         * Returns null when the backend is busy (keep the previous values).
         */
        getState: async function(sessionId) {
            var res = await this._postJson('/api/state', { session_id: sessionId });
            if (!res || res.status !== 'OK') return null;
            // busy answers still carry `syncing` + height; applyState knows what to do with them
            return res;
        },

        /**
         * Short-lived token for the server-sent events stream (keeps the session id out of URLs).
         */
        getEventToken: async function(sessionId) {
            var res = await this._postJson('/api/events/token', { session_id: sessionId });
            return (res && res.status === 'OK' && res.token) ? res.token : null;
        },

        /**
         * Block height to use as restore height for a wallet created on `date` (YYYY-MM-DD).
         */
        getHeightForDate: async function(date) {
            try {
                var res = await this._getJson('/api/height-for-date?date=' + encodeURIComponent(date));
                return (res && res.status === 'OK' && Number.isFinite(res.height)) ? res.height : null;
            } catch (e) {
                return null;
            }
        },

        /**
         * Restore height derived from a transaction the user knows belongs to the wallet.
         * Returns { height, txHeight } or null.
         */
        getHeightForTxid: async function(txid) {
            try {
                var res = await this._postJson('/api/height-for-txid', { txid: txid });
                return (res && res.status === 'OK' && Number.isFinite(res.height)) ? { height: res.height, txHeight: res.tx_height } : null;
            } catch (e) {
                return null;
            }
        },

        /**
         * Fetch network fee levels (atomic units per byte) for the 4 priorities.
         * @returns {{fee:number, fees:number[]}|null}
         */
        getFees: async function() {
            try {
                var res = await this._getJson('/api/fees');
                if (res && Array.isArray(res.fees) && res.fees.length === 4) return res;
                return null;
            } catch (e) {
                return null;
            }
        },

        /**
         * Create unsigned transaction on the watch-only backend (zero spend key exposure)
         * @param {string} sessionId
         * @param {string} toAddress   standard, integrated or subaddress
         * @param {string} amount      human readable XMR string (ignored when sweepAll)
         * @param {number} [priority]  1..4
         * @param {boolean} [sweepAll] send entire unlocked balance
         */
        createUnsignedTx: async function(sessionId, toAddress, amount, priority, sweepAll) {
            return await this._postJson('/api/create-unsigned-tx', {
                session_id: sessionId,
                to_address: toAddress,
                amount: amount || '',
                priority: priority || 2,
                sweep_all: sweepAll ? '1' : '0'
            });
        },

        /**
         * Reserve the next subaddress index for this wallet (persisted server-side).
         */
        nextSubaddressIndex: async function(sessionId) {
            var res = await this._postJson('/api/subaddress-next', { session_id: sessionId });
            return (res && res.status === 'OK' && Number.isInteger(res.index)) ? res.index : null;
        },

        /**
         * Full output export of this wallet (hex), for key image computation in the browser.
         */
        exportOutputs: async function(sessionId) {
            return await this._postJson('/api/export-outputs', { session_id: sessionId });
        },

        /**
         * Upload signed key images so the watch-only wallet learns which outputs are spent.
         */
        importKeyImages: async function(sessionId, keyImages, offset) {
            return await this._postJson('/api/import-key-images', {
                session_id: sessionId,
                key_images: JSON.stringify(keyImages || []),
                offset: offset || 0
            });
        },

        /**
         * Broadcast client-signed transaction set
         * @param {string} sessionId
         * @param {string} signedTxsetHex
         * @param {object} [txInfo]
         */
        submitSignedTx: async function(sessionId, signedTxsetHex, txInfo) {
            return await this._postJson('/api/submit-signed-tx', {
                session_id: sessionId,
                signed_txset: signedTxsetHex,
                tx_info: txInfo ? JSON.stringify(txInfo) : ''
            });
        },

        /* ---------------------------------------------------------------- swap (through our server, which forwards to a swap gateway) */

        /** Swap page config: coins, networks, assets with availability, logos, fee percent. */
        swapConfig: async function() {
            try {
                return await this._getJson('/api/swap/config');
            } catch (e) {
                return null;
            }
        },

        /** Live quote. `amount` is the human amount of `from`; the server converts to atomic units. */
        swapQuote: async function(from, to, amount, toAddress) {
            return await this._postJson('/api/swap/quote', { from: from, to: to, amount: amount, to_address: toAddress || '' });
        },

        /** Create an order. Works without a wallet; with one, the order is also saved for that wallet. */
        swapCreate: async function(sessionId, from, to, amount, toAddress, refundAddress) {
            return await this._postJson('/api/swap/create', {
                session_id: sessionId || '', from: from, to: to, amount: amount, to_address: toAddress, refund_address: refundAddress || ''
            });
        },

        swapOrders: async function(sessionId) {
            return await this._postJson('/api/swap/orders', { session_id: sessionId || '' });
        },

        /** Read an order with the order token the browser holds, the wallet session, or (read-only) the receiving address. */
        swapOrder: async function(sessionId, orderId, swapSession, verifyAddress) {
            return await this._postJson('/api/swap/order', { session_id: sessionId || '', order_id: orderId, swap_session: swapSession || '', verify_address: verifyAddress || '' });
        },

        /** action: close-wait | refund-address | payout-address */
        swapAction: async function(sessionId, orderId, swapSession, action, address) {
            return await this._postJson('/api/swap/order/' + action, { session_id: sessionId || '', order_id: orderId, swap_session: swapSession || '', address: address || '' });
        },

        /**
         * End active wallet session
         * @param {string} sessionId
         */
        logout: async function(sessionId) {
            try {
                return await this._post('/api/logout', { session_id: sessionId });
            } catch (e) {
                return false;
            }
        }
    };

    window.XMR_API = XMR_API;
})(window);
