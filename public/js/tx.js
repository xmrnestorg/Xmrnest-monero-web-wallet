/**
 * XmrNest Transaction Manager
 *
 * Non-custodial send flow:
 *   1. The backend's WATCH-ONLY wallet (address + private view key only) selects inputs,
 *      picks decoys and builds an UNSIGNED transaction set (monero-wallet-rpc `transfer`
 *      / `sweep_all` with do_not_relay). It cannot sign: it has no spend key.
 *   2. The browser signs that set with the private spend key using the monero-ts
 *      WebAssembly wallet (MoneroSigner). The spend key never leaves the browser.
 *   3. The signed set is sent back and broadcast via `submit_transfer`, which also
 *      imports the resulting key images so the watch-only wallet knows what was spent.
 */
(function(window) {
    'use strict';

    // Mainnet base58 prefixes (varint-encoded hex): standard 18, integrated 19, subaddress 42.
    var ADDRESS_PREFIXES = {
        '12': { type: 'standard', length: 95 },
        '13': { type: 'integrated', length: 106 },
        '2a': { type: 'subaddress', length: 95 }
    };

    /**
     * Validate any mainnet Monero destination address (standard, integrated or subaddress)
     * including its 4-byte Keccak checksum. cnUtil.decode_address only understands standard
     * and integrated prefixes, which made every send to a subaddress ("8...") fail.
     */
    function validateDestination(addr) {
        if (typeof addr !== 'string') return null;
        if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(addr)) return null;
        var hex;
        try {
            hex = cnBase58.decode(addr);
        } catch (e) {
            return null;
        }
        var prefix = hex.slice(0, 2);
        var meta = ADDRESS_PREFIXES[prefix];
        if (!meta || addr.length !== meta.length) return null;
        var payloadLen = 2 + 64 + 64 + (meta.type === 'integrated' ? 16 : 0);
        if (hex.length !== payloadLen + 8) return null;
        var checksum = hex.slice(payloadLen);
        var expected = cnUtil.cn_fast_hash(hex.slice(0, payloadLen)).slice(0, 8);
        if (checksum !== expected) return null;
        return { type: meta.type, paymentId: meta.type === 'integrated' ? hex.slice(130, 146) : null };
    }

    function atomicToXmr(atomic) {
        try {
            return (typeof formatXmr === 'function') ? formatXmr(String(atomic)) : String(atomic);
        } catch (e) {
            return String(atomic);
        }
    }

    var SIGNER_SRC = '/js/monero-signer.js?v=ephemeral_8';
    var signerPromise = null;

    /**
     * Load the WebAssembly signer (2 MB gzipped) on demand. It used to be a deferred <script>,
     * which held back DOMContentLoaded and therefore every button on the page until it had
     * parsed. Now the page is interactive immediately and the signer is fetched in the
     * background after a login that can spend, or at the latest right before signing.
     */
    var signerState = 'idle'; // idle | loading | ready | failed

    function setSignerState(state) {
        signerState = state;
        try {
            window.dispatchEvent(new CustomEvent('monero-signer', { detail: { state: state } }));
        } catch (e) {}
    }

    function loadMoneroSigner() {
        if (window.MoneroSigner && typeof window.MoneroSigner.signTransaction === 'function') {
            if (signerState !== 'ready') setSignerState('ready');
            return Promise.resolve(true);
        }
        if (signerPromise) return signerPromise;
        setSignerState('loading');
        signerPromise = new Promise(function(resolve) {
            var el = document.createElement('script');
            el.src = SIGNER_SRC;
            el.async = true;
            el.onload = function() {
                var ok = Boolean(window.MoneroSigner && typeof window.MoneroSigner.signTransaction === 'function');
                setSignerState(ok ? 'ready' : 'failed');
                if (!ok) signerPromise = null;
                resolve(ok);
            };
            el.onerror = function() {
                signerPromise = null;
                setSignerState('failed');
                resolve(false);
            };
            document.head.appendChild(el);
        });
        return signerPromise;
    }

    async function waitForSigner(onStatus) {
        if (window.MoneroSigner && typeof window.MoneroSigner.signTransaction === 'function') return true;
        onStatus('Loading Monero WebAssembly signer...');
        var ok = await loadMoneroSigner();
        if (ok) return true;
        for (var i = 0; i < 100; i++) {
            if (window.MoneroSigner && typeof window.MoneroSigner.signTransaction === 'function') return true;
            await new Promise(function(resolve) { setTimeout(resolve, 200); });
        }
        return false;
    }

    var TransactionManager = {
        validateDestination: validateDestination,
        /** Re-broadcast an already signed set (safe to repeat: same key images). */
        resubmit: async function(sessionId, signedTxsetHex, txInfo) {
            var r = await window.XMR_API.submitSignedTx(sessionId, signedTxsetHex, txInfo);
            if (r && r.status === 'OK') return { success: true, txid: r.txid || '', txids: r.tx_hash_list || [r.txid] };
            return { success: false, reason: (r && (r.reason || r.error)) || 'Broadcast rejected', busy: Boolean(r && r.busy) };
        },
        loadSigner: loadMoneroSigner,
        signerState: function() { return signerState; },

        /**
         * Compose, sign, and broadcast a Monero transaction.
         * @param {object} opts
         * @param {string}   opts.toAddress   Destination (standard, integrated or subaddress)
         * @param {string}   opts.amountStr   Human readable XMR amount, e.g. "0.05" (ignored when sweepAll)
         * @param {boolean}  [opts.sweepAll]  Send the whole unlocked balance (MAX button)
         * @param {number}   [opts.priority]  1..4 = unimportant / normal / elevated / priority
         * @param {function} [opts.onStatus]  Progress callback
         * @param {function} [opts.onConfirm] async ({amountAtomic, feeAtomic, toAddress, txCount}) => boolean.
         *                                    Called with the REAL fee before anything is signed or broadcast.
         */
        send: async function(opts) {
            var toAddr = (opts.toAddress || '').trim();
            var amtStr = (opts.amountStr || '').trim();
            var sweepAll = Boolean(opts.sweepAll);
            var onStatus = opts.onStatus || function() {};
            var onConfirm = opts.onConfirm || async function() { return true; };
            var priority = parseInt(opts.priority, 10);
            if (!(priority >= 1 && priority <= 4)) priority = 2;

            var state = window.WalletState;
            if (!state.isSignedIn()) {
                throw new Error('Please import or connect your wallet first.');
            }

            // Snapshot the active wallet NOW so a wallet switch during the (slow) build/sign
            // steps cannot pair wallet A's unsigned tx with wallet B's keys.
            var sessionId = state.sessionId;
            var fromAddress = state.address;
            var viewkey = state.viewkey;
            var spendkey = state.spendkey;

            var dest = validateDestination(toAddr);
            if (!dest) {
                throw new Error('Please enter a valid Monero address (standard 4..., subaddress 8..., or integrated address).');
            }
            var transaction_amount = null;
            if (!sweepAll) {
                if (!/^[0-9]*\.?[0-9]*$/.test(amtStr) || amtStr === '' || amtStr === '.') {
                    throw new Error('Please enter a valid amount.');
                }
                try {
                    transaction_amount = new JSBigInt(cnUtil.parseMoney(amtStr));
                } catch (e) {
                    throw new Error('Please enter a valid amount.');
                }
                if (transaction_amount.compare(0) <= 0) {
                    throw new Error('Please enter an amount greater than 0.');
                }
                if (!state.unlockedBalance) {
                    throw new Error('Your balance has not loaded yet. Please wait a moment and try again.');
                }
                if (transaction_amount.compare(state.unlockedBalance) > 0) {
                    throw new Error('The amount you entered exceeds your available unlocked balance.');
                }
            } else if (!state.unlockedBalance || state.unlockedBalance.compare(0) <= 0) {
                throw new Error('No unlocked balance available to send.');
            }

            if (state.syncStatus && !state.syncStatus.synced) {
                throw new Error('The wallet is still scanning the blockchain (' + Math.max(0, state.syncStatus.target - state.syncStatus.current) + ' blocks behind). Please wait until it is synced before sending.');
            }

            if (!spendkey || !/^[0-9a-fA-F]{64}$/.test(spendkey)) {
                throw new Error('Your private spend key is required to sign outgoing transactions. Please re-import this wallet with its recovery seed or private spend key.');
            }

            // 1. Watch-only backend builds the unsigned transaction (no key material involved).
            onStatus(sweepAll ? 'Building sweep transaction (watch-only)...' : 'Building transaction (watch-only)...');
            var unsignedRes = await window.XMR_API.createUnsignedTx(sessionId, toAddr, sweepAll ? '' : amtStr, priority, sweepAll);
            if (!unsignedRes || unsignedRes.status !== 'OK' || !unsignedRes.unsigned_txset) {
                var errReason = (unsignedRes && (unsignedRes.reason || unsignedRes.error)) || 'Failed to construct transaction';
                throw new Error(errReason);
            }

            // 2 + 3. Sign locally. The signer DECODES the unsigned set with the wallet keys first
            // and refuses to sign unless every destination is the address the user typed, the
            // amount matches (unless sweeping) and any change returns to this wallet's primary
            // address (a sweep must leave none). The confirmation dialog shows those decoded
            // values, not numbers the server reported.
            if (!(await waitForSigner(onStatus))) {
                throw new Error('Monero WebAssembly signer is still loading. Please wait a moment and try again.');
            }
            onStatus('Checking the transaction before signing...');
            var amountAtomic = transaction_amount ? transaction_amount.toString() : '0';
            var feeAtomic = '0';
            var txCount = 1;
            var signedTxsetHex = await window.MoneroSigner.signTransaction(fromAddress, viewkey, spendkey, unsignedRes.unsigned_txset, unsignedRes.outputs_hex || '', {
                toAddress: toAddr,
                amountAtomic: sweepAll ? null : transaction_amount.toString(),
                onReview: async function(review) {
                    amountAtomic = review.amountAtomic;
                    feeAtomic = review.feeAtomic;
                    txCount = review.txCount;
                    var changeAtomic = review.changeAtomic || '0';
                    return await onConfirm({
                        amountAtomic: amountAtomic,
                        feeAtomic: feeAtomic,
                        changeAtomic: changeAtomic,
                        amountXmr: atomicToXmr(amountAtomic),
                        feeXmr: atomicToXmr(feeAtomic),
                        changeXmr: atomicToXmr(changeAtomic),
                        toAddress: toAddr,
                        txCount: txCount,
                        sweep: sweepAll
                    });
                }
            });
            if (!signedTxsetHex || typeof signedTxsetHex !== 'string' || !/^[0-9a-fA-F]+$/.test(signedTxsetHex)) {
                throw new Error('WebAssembly signing failed to produce a valid signed transaction.');
            }
            onStatus('Signed. Broadcasting to the Monero network...');

            // 4. Broadcast.
            var txInfo = {
                amount: amountAtomic,
                address: toAddr,
                fee: feeAtomic
            };
            var submitRes;
            try {
                submitRes = await window.XMR_API.submitSignedTx(sessionId, signedTxsetHex, txInfo);
            } catch (netErr) {
                // The signed set is kept so the SAME transaction can be re-broadcast (identical key
                // images: the network cannot pay twice). Building a new one could.
                var e1 = new Error('No answer from the server while broadcasting. The transaction may already be on the network.');
                e1.signedTxsetHex = signedTxsetHex; e1.txInfo = txInfo; e1.sessionId = sessionId; e1.maybeBroadcast = true;
                throw e1;
            }

            if (submitRes && submitRes.status === 'OK') {
                var finalTxid = submitRes.txid || '';
                onStatus('Transaction submitted! TXID: ' + finalTxid.slice(0, 16) + '...');
                setTimeout(function() {
                    if (window.WalletState.sessionId === sessionId) {
                        window.WalletState.pollState();
                    }
                }, 1500);

                return {
                    success: true,
                    txid: finalTxid,
                    txids: submitRes.tx_hash_list || [finalTxid],
                    amount: atomicToXmr(amountAtomic),
                    fee: atomicToXmr(feeAtomic)
                };
            }

            var submitErr = (submitRes && (submitRes.reason || submitRes.error)) || 'Transaction broadcast rejected';
            var e2 = new Error(submitErr);
            if (submitRes && (submitRes.busy || submitRes.maybe_broadcast)) {
                e2.signedTxsetHex = signedTxsetHex; e2.txInfo = txInfo; e2.sessionId = sessionId; e2.maybeBroadcast = Boolean(submitRes.maybe_broadcast);
            }
            throw e2;
        }
    };

    window.TransactionManager = TransactionManager;
})(window);
