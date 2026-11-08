/**
 * XmrNest UI Controller
 * Manages view switching, account switcher dropdown, toast alerts, QR codes, and transaction list rendering.
 */
(function(window) {
    'use strict';

    var toastTimer = null;
    var currentGeneratedSeed = '';
    var currentGeneratedKeys = null;

    // Fee estimation: daemon fee levels are per byte; a typical 1-in/2-out CLSAG+BP+ tx weighs
    // ~1.5 kB. The exact fee is computed by the wallet and confirmed with the user before signing.
    var EST_TX_WEIGHT_BYTES = 1600;
    var DEFAULT_FEE_LEVELS = [20000, 100000, 500000, 20000000]; // atomic/byte, used until /api/fees answers
    var feeLevels = DEFAULT_FEE_LEVELS.slice();
    var selectedPriority = 2; // 1 Low, 2 Normal, 3 High, 4 Urgent
    var PRIORITY_LABELS = { 1: 'Low', 2: 'Normal', 3: 'High', 4: 'Urgent' };
    var sweepMode = false; // MAX pressed: the fee is taken out of the amount, not added on top
    var amountUnit = 'XMR'; // amount field unit: 'XMR' | 'USD' (the tx is always sent in XMR)
    var exactXmrBeforeUsd = null; // { xmr, usdShown }: restore the exact XMR when toggling back untouched

    /** "0.015000000000" -> "0.015", "10.000" -> "10" */
    function trimZeros(str) {
        str = String(str);
        if (str.indexOf('.') === -1) return str;
        str = str.replace(/0+$/, '');
        return str.endsWith('.') ? str.slice(0, -1) : str;
    }

    /** Float XMR -> exact-looking display string (12 decimals, trailing zeros trimmed). */
    function fmtFloatXmr(v) {
        if (!Number.isFinite(v) || v <= 0) return '0';
        return trimZeros(v.toFixed(12));
    }

    function escapeHtml(str) {
        return String(str === null || typeof str === 'undefined' ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    var UI = {
        /**
         * Display temporary toast alert
         */
        notify: function(text) {
            var t = document.getElementById('toast');
            if (!t) return;
            t.textContent = text;
            t.classList.add('show');
            clearTimeout(toastTimer);
            toastTimer = setTimeout(function() {
                t.classList.remove('show');
            }, 2400);
        },

        /**
         * Switch page view
         */
        showPage: function(id) {
            var signedIn = window.WalletState.isSignedIn();

            if (!signedIn) {
                if (id === 'send' || id === 'receive' || id === 'home') {
                    id = 'welcome';
                }
            } else {
                if (id === 'welcome') {
                    id = 'home';
                }
            }

            var allPages = document.querySelectorAll('.page');
            var allNav = document.querySelectorAll('.nav [data-page]');
            allPages.forEach(function(p) { p.classList.toggle('active', p.id === id); });
            allNav.forEach(function(b) { b.classList.toggle('active', b.dataset.page === id); });

            var sidebar = document.getElementById('sidebar');
            if (sidebar) sidebar.classList.remove('open');

            // Real URLs per page (SEO); the old #hash links still resolve on load.
            var pathFor = { welcome: '/', home: '/', create: '/create', import: '/restore', how: '/how-to-use', swap: '/swap', send: '/send', receive: '/receive' };
            var seo = {
                welcome: ['Monero Web Wallet: Private XMR Wallet Online | XmrNest', 'XmrNest is a Monero web wallet that runs in your browser. Create or restore an XMR wallet in minutes. Your keys never leave your device.'],
                home: ['Your wallet | XmrNest', 'Your XmrNest Monero wallet.'],
                create: ['Create a Monero Wallet: Free 25-Word Seed | XmrNest', 'Create a new Monero wallet in your browser. Get your 25-word XMR seed in seconds. No sign-up, no email. Your seed is never sent to our servers.'],
                import: ['Restore Monero Wallet from Seed or Keys | XmrNest', 'Restore your Monero wallet with your 25-word seed or private keys. Works with seeds from Monero GUI, Cake Wallet and Feather. Keys stay in your browser.'],
                how: ['How to Use a Monero Wallet: Send & Receive XMR | XmrNest', 'Learn how to create a Monero wallet, receive XMR and send it safely in 3 simple steps. Plus easy tips to keep your seed and funds safe.'],
                swap: ['Swap BTC, ETH & USDT to Monero (XMR) | XmrNest', 'Swap BTC, ETH, USDT, USDC, DAI, BNB, SOL, ZEC or TRX to Monero (XMR) and back. No sign-up, no account. Your XMR goes straight to your own wallet.'],
                send: ['Send XMR | XmrNest', 'Send Monero from your XmrNest wallet.'],
                receive: ['Receive XMR | XmrNest', 'Receive Monero in your XmrNest wallet.']
            };
            var target = pathFor[id] || '/';
            try {
                if (window.location.pathname !== target || window.location.hash) {
                    window.history.pushState({ page: id }, '', target);
                }
            } catch (e) {
                window.location.hash = '#' + id;
            }
            if (seo[id]) {
                document.title = seo[id][0];
                var md = document.querySelector('meta[name="description"]');
                if (md) md.setAttribute('content', seo[id][1]);
            }
            window.scrollTo({ top: 0, behavior: 'smooth' });

            if (id === 'create' && !currentGeneratedSeed) {
                this.generateNewSeed();
            }
        },

        /**
         * Toggle authenticated vs unauthenticated UI states
         */
        updateAuthUI: function(signedIn) {
            if (signedIn) {
                document.body.classList.remove('not-signed-in');
                document.body.classList.add('signed-in');
                var navText = document.getElementById('navImportText');
                if (navText) navText.textContent = 'Add / Restore';
            } else {
                document.body.classList.remove('signed-in');
                document.body.classList.add('not-signed-in');
                var navText2 = document.getElementById('navImportText');
                if (navText2) navText2.textContent = 'Restore wallet';
            }
        },

        /**
         * Update balance and USD values across UI
         */
        updateBalanceDisplay: function() {
            var state = window.WalletState;
            var balStr = '0';
            var unlockedStr = '0';

            // Signed in but no balance received yet (first poll pending, instance busy opening the
            // wallet, or wallet switch in progress): say so instead of showing zeros.
            var balanceLoading = state.isSignedIn() && state.balance === null;
            if (typeof formatXmr === 'function' && state.balance) {
                balStr = formatXmr(state.balance);
                unlockedStr = formatXmr(state.unlockedBalance);
            }
            var homePending = document.getElementById('homePending');
            var homePendingSub = document.getElementById('homePendingSub');
            var sendLocked = document.getElementById('sendLocked');
            if (balanceLoading) {
                var hb = document.getElementById('homeBalance');
                var sa = document.getElementById('sendAvailable');
                var hu = document.getElementById('homeBalanceUsd');
                // Animated shimmer bars (see .skel in app.html) instead of "Loading..." text.
                var skel = '<span class="skel" role="status" aria-label="Loading"></span>';
                if (hb) hb.innerHTML = skel;
                if (sa) sa.innerHTML = 'Available: <span class="skel sm" aria-label="loading"></span>';
                if (hu) hu.textContent = '';
                if (homePending) homePending.innerHTML = skel;
                if (homePendingSub) homePendingSub.textContent = '';
                if (sendLocked) sendLocked.textContent = '';
                return;
            }

            var homeBal = document.getElementById('homeBalance');
            var sendAvail = document.getElementById('sendAvailable');
            var homeUsd = document.getElementById('homeBalanceUsd');

            // While the wallet is still scanning, a number would be wrong by construction.
            if (state.isSignedIn() && state.syncing) {
                if (homeBal) homeBal.textContent = 'Syncing...';
                if (homeUsd) homeUsd.textContent = 'Balance appears when the scan reaches the current block';
                if (sendAvail) sendAvail.textContent = 'Available: syncing...';
                if (homePending) homePending.textContent = 'Syncing...';
                if (homePendingSub) homePendingSub.textContent = '';
                if (sendLocked) sendLocked.textContent = '';
                return;
            }

            if (homeBal) homeBal.textContent = balStr + ' XMR';
            if (sendAvail) sendAvail.textContent = 'Available: ' + unlockedStr + ' XMR';

            // Pending = balance - unlocked: incoming outputs (incl. mempool) and our own change,
            // all locked for 10 confirmations.
            var pendingStr = '0';
            if (state.balance && state.unlockedBalance && typeof state.balance.subtract === 'function') {
                var pendingBig = state.balance.subtract(state.unlockedBalance);
                if (pendingBig.compare(0) > 0 && typeof formatXmr === 'function') pendingStr = formatXmr(pendingBig);
            }
            var hasPending = pendingStr !== '0';
            if (homePending) homePending.textContent = pendingStr + ' XMR';
            if (homePendingSub) homePendingSub.textContent = hasPending ? 'Unlocks after 10 confirmations (~20 min)' : 'No pending funds';
            if (sendLocked) sendLocked.textContent = hasPending ? ('Locked: ' + pendingStr + ' XMR (unlocks after 10 confirmations)') : '';
            if (state.isSignedIn()) this.updateSummary();

            var balFloat = parseFloat(balStr || '0');
            if (homeUsd) {
                if (state.usdPrice > 0) {
                    var usdVal = (balFloat * state.usdPrice).toFixed(2);
                    homeUsd.textContent = '≈ $' + usdVal + ' USD';
                } else {
                    homeUsd.textContent = '≈ $0.00 USD';
                }
            }
        },

        /**
         * Render QR Code for recipient address
         */
        renderQr: function(text) {
            var container = document.getElementById('qrCodeContainer');
            if (!container) return;
            container.innerHTML = '';

            if (!text || text.indexOf('Import') !== -1) {
                container.innerHTML = '<div style="font-size:12px;color:var(--gray-500);padding:20px;">QR will appear when wallet is loaded</div>';
                return;
            }

            try {
                if (typeof QRCode !== 'undefined') {
                    new QRCode(container, {
                        text: text,
                        width: 190,
                        height: 190,
                        colorDark: '#121417',
                        colorLight: '#ffffff',
                        correctLevel: (QRCode.CorrectLevel ? QRCode.CorrectLevel.M : 0)
                    });
                }
            } catch(e) {
                console.error('QR rendering error:', e);
            }
        },

        /**
         * Render topbar account switcher dropdown
         */
        renderAccountSwitcher: function() {
            var wallets = window.WalletState.getConnectedWallets();
            var list = document.getElementById('accountList');
            var chip = document.getElementById('walletChipBtn');
            var countBadge = document.getElementById('accountCount');
            var btnLogout = document.getElementById('btnLogout');

            if (countBadge) countBadge.textContent = wallets.length;

            if (wallets.length === 0) {
                if (chip) chip.classList.remove('active');
                if (btnLogout) btnLogout.classList.remove('active');
                if (list) list.innerHTML = '<div style="padding:14px;text-align:center;color:var(--gray-500);font-size:12px">No wallets connected</div>';
                return;
            }

            if (chip) chip.classList.add('active');
            if (btnLogout) btnLogout.classList.add('active');

            var currentAddr = window.WalletState.address;
            var chipAddr = document.getElementById('chipAddress');
            if (chipAddr) {
                chipAddr.textContent = currentAddr ? (currentAddr.slice(0, 6) + '...' + currentAddr.slice(-6)) : 'Select wallet';
            }

            if (!list) return;

            var html = '';
            wallets.forEach(function(w, idx) {
                var isCurrent = (w.address === currentAddr);
                var short = w.address.slice(0, 7) + '...' + w.address.slice(-6);
                var balText = (w.balance ? (w.balance + ' XMR') : '0 XMR');
                var name = w.name || ('Wallet ' + (idx + 1));

                html += '<div class="account-item ' + (isCurrent ? 'current' : '') + '" data-addr="' + escapeHtml(w.address) + '">';
                html += '  <div class="account-item-left">';
                html += '    <div class="account-item-indicator"></div>';
                html += '    <div class="account-item-meta">';
                html += '      <div class="account-item-title">' + escapeHtml(name) + (isCurrent ? ' <span style="font-size:10px;color:var(--green);font-weight:600">(Active)</span>' : '') + '</div>';
                html += '      <div class="account-item-addr">' + short + '</div>';
                html += '    </div>';
                html += '  </div>';
                html += '  <div class="account-item-right">';
                html += '    <div class="account-item-bal">' + balText + '</div>';
                html += '    <button class="account-item-remove" data-remove-addr="' + escapeHtml(w.address) + '" title="Disconnect this wallet">';
                html += '      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
                html += '    </button>';
                html += '  </div>';
                html += '</div>';
            });

            list.innerHTML = html;

            var self = this;
            list.querySelectorAll('.account-item').forEach(function(el) {
                el.addEventListener('click', async function(e) {
                    var removeBtn = e.target.closest('.account-item-remove');
                    if (removeBtn) {
                        e.stopPropagation();
                        var removeAddr = removeBtn.getAttribute('data-remove-addr');
                        if (confirm('Disconnect ' + (removeAddr.slice(0, 6) + '...' + removeAddr.slice(-6)) + '?')) {
                            await window.WalletState.removeConnectedWallet(removeAddr);
                        }
                        return;
                    }
                    var addr = this.getAttribute('data-addr');
                    if (addr !== window.WalletState.address) {
                        await window.WalletState.switchWallet(addr);
                        self.notify('Switched to wallet ' + (addr.slice(0, 6) + '...' + addr.slice(-6)));
                    }
                    document.getElementById('accountDropdown').classList.remove('open');
                    document.getElementById('walletChipBtn').classList.remove('open');
                });
            });
        },

        /**
         * Render transactions list with xmrchain.net block explorer links
         */
        renderTransactions: function(txs) {
            var emptyDiv = document.getElementById('activityEmpty');
            var listDiv = document.getElementById('txList');
            if (!emptyDiv || !listDiv) return;

            if (!txs || txs.length === 0) {
                emptyDiv.style.display = 'block';
                listDiv.style.display = 'none';
                listDiv.innerHTML = '';
                return;
            }

            emptyDiv.style.display = 'none';
            listDiv.style.display = 'grid';
            listDiv.innerHTML = '';

            txs.forEach(function(tx) {
                var isPool = (tx.type === 'pool' || tx.type === 'pendingtx');
                // Unconfirmed txs carry a direction: our own broadcast ('out') or an incoming mempool tx ('in').
                var isOut = (tx.type === 'out') || (isPool && (tx.direction === 'out' || tx.type === 'pendingtx'));
                var badgeClass = isPool ? 'pool' : (isOut ? 'out' : 'in');
                var badgeText = isPool ? '⌛' : (isOut ? '↑' : '↓');
                var sign = isOut ? '-' : '+';
                var title = isPool
                    ? (isOut ? 'Sending (unconfirmed)' : 'Receiving (unconfirmed)')
                    : (isOut ? 'Sent' : 'Received');

                var amtStr = '0';
                if (typeof formatXmr === 'function' && tx.amount) {
                    amtStr = formatXmr(tx.amount);
                }

                var dateStr = '';
                if (tx.time) {
                    var d = new Date(tx.time * 1000);
                    dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                }

                var txidStr = (typeof tx.txid === 'string' && /^[0-9a-fA-F]{64}$/.test(tx.txid)) ? tx.txid : '';
                var shortTxid = txidStr ? (txidStr.slice(0, 8) + '...' + txidStr.slice(-8)) : 'Pending';
                var hasTxid = Boolean(txidStr);
                var txUrl = hasTxid ? ('https://blockchair.com/monero/transaction/' + encodeURIComponent(txidStr)) : '';
                var confText = (typeof tx.confirmations === 'string' && /^[0-9]{1,3}\/[0-9]{1,3}$/.test(tx.confirmations)) ? tx.confirmations : '0/10';
                if (isPool) confText = 'in mempool';

                var item = document.createElement(hasTxid ? 'a' : 'div');
                item.className = 'tx-item' + (hasTxid ? ' tx-clickable' : '');
                if (hasTxid) {
                    item.href = txUrl;
                    item.target = '_blank';
                    item.rel = 'noopener noreferrer';
                    item.title = 'View on Blockchair: ' + txidStr;
                }

                item.innerHTML = [
                    '<div class="tx-left">',
                        '<div class="tx-badge ' + badgeClass + '">' + badgeText + '</div>',
                        '<div class="tx-meta">',
                            '<div class="tx-title">' + title + (hasTxid ? ' <span class="tx-link-icon">↗</span>' : '') + '</div>',
                            '<div class="tx-sub" title="' + txidStr + '">Tx: ' + shortTxid + ' • ' + dateStr + (hasTxid ? ' <span style="color:var(--orange);font-weight:600">(Explorer)</span>' : '') + '</div>',
                            (tx.payment_id ? '<div class="tx-pid">PID: ' + tx.payment_id + '</div>' : ''),
                        '</div>',
                    '</div>',
                    '<div class="tx-right">',
                        '<div class="tx-amount ' + (isOut ? 'out' : 'in') + '">' + sign + amtStr + ' XMR</div>',
                        '<div class="tx-conf">' + confText + '</div>',
                    '</div>'
                ].join('');
                listDiv.appendChild(item);
            });
        },

        /**
         * Generate brand new 25-word Monero recovery seed
         */
        generateNewSeed: function(lang) {
            lang = lang || (document.getElementById('createSeedLang') ? document.getElementById('createSeedLang').value : 'english') || 'english';
            try {
                if (typeof cnUtil === 'undefined' || typeof mn_encode === 'undefined') {
                    console.error('Cryptographic libraries not loaded');
                    return;
                }
                var rawScalar = cnUtil.sc_reduce32(cnUtil.rand_32());
                var keys = cnUtil.create_address(rawScalar);
                var mnemonic = mn_encode(rawScalar, lang);

                currentGeneratedSeed = mnemonic;
                currentGeneratedKeys = {
                    rawScalar: rawScalar,
                    keys: keys,
                    address: cnUtil.pubkeys_to_string(keys.spend.pub, keys.view.pub),
                    viewkey: keys.view.sec,
                    spendkey: keys.spend.sec,
                    seed: mnemonic,
                    lang: lang
                };

                var words = mnemonic.split(' ');
                var container = document.getElementById('seedWordsContainer');
                if (container) {
                    container.innerHTML = '';
                    words.forEach(function(w, idx) {
                        var chip = document.createElement('div');
                        chip.className = 'seed-pill';
                        chip.innerHTML = '<span class="num">' + (idx + 1) + '</span><span class="word">' + w + '</span>';
                        container.appendChild(chip);
                    });
                }

                var chk = document.getElementById('chkSeedSaved');
                if (chk) chk.checked = false;

            } catch (e) {
                console.error('Error generating seed:', e);
                this.notify('Error generating new seed: ' + e.message);
            }
        },

        getGeneratedKeys: function() {
            return currentGeneratedKeys;
        },

        /** Forget the generated seed and wipe it from the page (after the wallet is opened, or on sign-out). */
        clearGeneratedSeed: function() {
            currentGeneratedSeed = '';
            currentGeneratedKeys = null;
            var container = document.getElementById('seedWordsContainer');
            if (container) container.innerHTML = '';
            var chk = document.getElementById('chkSeedSaved');
            if (chk) chk.checked = false;
        },

        getGeneratedSeed: function() {
            return currentGeneratedSeed;
        },

        /**
         * Estimated fee in XMR (float, display only) for the selected priority.
         */
        getSelectedFee: function() {
            var perByte = feeLevels[selectedPriority - 1] || feeLevels[1] || DEFAULT_FEE_LEVELS[1];
            return (perByte * EST_TX_WEIGHT_BYTES) / 1e12;
        },

        /**
         * Update the daemon's per-byte fee levels (4 priorities).
         */
        setFeeLevels: function(levels) {
            if (Array.isArray(levels) && levels.length === 4 && levels.every(function(v) { return Number.isFinite(v) && v > 0; })) {
                feeLevels = levels.slice();
                this.updateSummary();
            }
        },

        getPriority: function() {
            return selectedPriority;
        },

        /**
         * Sending is gated by independent locks; the button shows the most relevant one.
         *   viewOnly : no spend key in this session
         *   scanning : wallet has not reached the chain tip
         *   signer   : WebAssembly signer still loading ('loading') or failed ('failed')
         */
        _sendLocks: { viewOnly: false, loading: false, scanning: false, signer: 'idle' },

        setSendLock: function(name, value) {
            this._sendLocks[name] = value;
            this._renderSendButton();
        },

        /** Backwards-compatible alias: setSendEnabled(false) == scanning lock on. */
        setSendEnabled: function(enabled) {
            this.setSendLock('scanning', !enabled);
        },

        _renderSendButton: function() {
            var btn = document.getElementById('reviewSend');
            var status = document.getElementById('signerStatus');
            if (!btn) return;
            var L = this._sendLocks;
            var text = 'Send transaction', disabled = false, title = '';
            if (L.viewOnly) {
                text = 'View-only wallet: sending unavailable';
                disabled = true;
                title = 'Re-import this wallet with its seed or private spend key to send.';
            } else if (L.loading) {
                text = 'Loading balance...';
                disabled = true;
                title = 'Waiting for the first balance update from the server.';
            } else if (L.scanning) {
                text = 'Scanning wallet... sending unavailable';
                disabled = true;
                title = 'Sending is disabled until the wallet scan reaches the current block.';
            } else if (L.signer === 'loading' || L.signer === 'idle') {
                text = 'Loading signer... (you can keep browsing)';
                disabled = true;
                title = 'The WebAssembly signer is downloading in the background.';
            } else if (L.signer === 'failed') {
                text = 'Signer failed to load - click to retry';
                disabled = false;
                title = 'Retries the signer download, then sends.';
            }
            btn.disabled = disabled;
            btn.textContent = text;
            btn.title = title;
            if (status) {
                var sig = L.signer === 'ready' ? 'Signer ready: transactions are signed locally in your browser.'
                        : L.signer === 'failed' ? 'Signer could not be loaded. Check your connection and retry.'
                        : 'Signer loading in the background...';
                status.textContent = sig;
            }
        },

        setSweepMode: function(on) {
            sweepMode = Boolean(on);
            this.updateSummary();
        },

        setPriority: function(p) {
            p = parseInt(p, 10);
            if (p >= 1 && p <= 4) selectedPriority = p;
            var sumPriority = document.getElementById('sumPriority');
            if (sumPriority) sumPriority.textContent = PRIORITY_LABELS[selectedPriority];
            this.updateSummary();
        },

        /**
         * Update send review summary calculation
         */
        getAmountUnit: function() {
            return amountUnit;
        },

        /**
         * The amount actually sent, in XMR, as a plain decimal string. In USD mode the typed
         * value is converted at the current price (12 decimals, trailing zeros trimmed).
         */
        getAmountXmr: function() {
            var amountInput = document.getElementById('amount');
            if (!amountInput) return '';
            // MAX / sweep: the whole unlocked balance goes, whatever unit is shown.
            if (sweepMode && window.WalletState.unlockedBalance && typeof formatXmr === 'function') {
                return formatXmr(window.WalletState.unlockedBalance);
            }
            var raw = (amountInput.value || '').trim();
            if (!raw) return '';
            if (amountUnit === 'XMR') return raw;
            if (exactXmrBeforeUsd && exactXmrBeforeUsd.usdShown === raw) return exactXmrBeforeUsd.xmr;
            var usd = parseFloat(raw);
            var price = window.WalletState.usdPrice;
            if (!Number.isFinite(usd) || usd <= 0 || !(price > 0)) return '';
            return fmtFloatXmr(usd / price);
        },

        /** Flip the amount field between XMR and USD, converting the typed value so it keeps its worth. */
        toggleAmountUnit: function() {
            var amountInput = document.getElementById('amount');
            var unitEl = document.getElementById('amountUnit');
            var price = window.WalletState.usdPrice;
            var raw = amountInput ? parseFloat(amountInput.value || '') : NaN;
            if (amountUnit === 'XMR') {
                if (!(price > 0)) { this.notify('USD price not available yet'); return; }
                amountUnit = 'USD';
                var usdShown = Number.isFinite(raw) && raw > 0 ? (raw * price).toFixed(2) : '';
                exactXmrBeforeUsd = usdShown ? { xmr: (amountInput.value || '').trim(), usdShown: usdShown } : null;
                if (amountInput) amountInput.value = usdShown;
                if (amountInput) amountInput.step = '0.01';
            } else {
                amountUnit = 'XMR';
                var typed = amountInput ? (amountInput.value || '').trim() : '';
                if (exactXmrBeforeUsd && exactXmrBeforeUsd.usdShown === typed) {
                    if (amountInput) amountInput.value = exactXmrBeforeUsd.xmr; // untouched: exact value back
                } else if (amountInput) {
                    amountInput.value = Number.isFinite(raw) && raw > 0 && price > 0 ? fmtFloatXmr(raw / price) : '';
                }
                exactXmrBeforeUsd = null;
                if (amountInput) amountInput.step = '0.00000001';
            }
            if (unitEl) unitEl.textContent = amountUnit;
            this.updateSummary();
        },

        updateSummary: function() {
            var amountInput = document.getElementById('amount');
            var sumAmount = document.getElementById('sumAmount');
            var sumFee = document.getElementById('sumFee');
            var sumTotal = document.getElementById('sumTotal');
            var converted = document.getElementById('amountConverted');

            if (!amountInput || !sumAmount) return;

            var price = window.WalletState.usdPrice;
            var xmrStr = this.getAmountXmr();
            var val = parseFloat(xmrStr || '0');
            if (!Number.isFinite(val) || val < 0) val = 0;

            if (converted) {
                if (!val) converted.textContent = '';
                else if (amountUnit === 'XMR') converted.textContent = (price > 0) ? ('≈ $' + (val * price).toFixed(2) + ' USD') : '';
                else converted.textContent = '≈ ' + fmtFloatXmr(val) + ' XMR';
            }

            var fee = this.getSelectedFee();
            if (sweepMode) {
                // Whole balance leaves the wallet; the recipient gets balance minus fee.
                sumAmount.textContent = '≈ ' + fmtFloatXmr(Math.max(0, val - fee)) + ' XMR (after fee)';
                if (sumFee) sumFee.textContent = '≈ ' + fmtFloatXmr(fee) + ' XMR';
                if (sumTotal) sumTotal.textContent = fmtFloatXmr(val) + ' XMR';
                return;
            }
            sumAmount.textContent = fmtFloatXmr(val) + ' XMR';
            if (sumFee) sumFee.textContent = '≈ ' + fmtFloatXmr(fee) + ' XMR';
            if (sumTotal) sumTotal.textContent = '≈ ' + fmtFloatXmr(val + fee) + ' XMR';
        }
    };

    window.UI = UI;
})(window);
