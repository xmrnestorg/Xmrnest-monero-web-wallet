/**
 * XmrNest Application Entrypoint
 * Bootstraps the application, binds DOM events, handles routing, and synchronizes wallet lifecycle.
 */
(function() {
    'use strict';

    document.addEventListener('DOMContentLoaded', async function() {
        var UI = window.UI;
        var WalletState = window.WalletState;
        var XMR_API = window.XMR_API;
        var TransactionManager = window.TransactionManager;

        // 0. Start the WebAssembly signer download right away, but off the critical path: the
        //    page is already interactive (all handlers below are bound synchronously) and only
        //    the Send button waits for it.
        window.addEventListener('monero-signer', function(ev) {
            UI.setSendLock('signer', ev.detail && ev.detail.state ? ev.detail.state : 'idle');
        });
        var kickSigner = function() { if (TransactionManager.loadSigner) TransactionManager.loadSigner(); };
        if (typeof requestIdleCallback === 'function') requestIdleCallback(kickSigner, { timeout: 1500 });
        else setTimeout(kickSigner, 300);

        // 1. Bind State Event Listeners to UI
        WalletState.on('walletChange', function(state) {
            var signedIn = state.isSignedIn();
            UI.updateAuthUI(signedIn);
            UI.renderAccountSwitcher();
            // A switch or sign-out must not carry the previous wallet's send form state.
            sendSweepAll = false;
            UI.setSweepMode(false);
            var amtEl = document.getElementById('amount');
            if (amtEl) amtEl.value = '';
            if (!signedIn) clearSecretInputs();

            UI.setSendLock('viewOnly', signedIn && !state.spendkey);
            UI.setSendLock('loading', signedIn && state.unlockedBalance === null);
            if (signedIn && state.spendkey && TransactionManager.loadSigner) {
                TransactionManager.loadSigner(); // spent-output sync runs automatically once the wallet is synced
            }
            var balNote = document.getElementById('balanceNote');
            if (balNote) {
                balNote.textContent = (signedIn && !state.spendkey)
                    ? 'View-only session: funds spent from another wallet or server may still be counted. Log in once with the seed or spend key to sync spent outputs.'
                    : '';
            }

            if (signedIn) {
                var shortAddr = state.address.slice(0, 6) + '...' + state.address.slice(-6);
                var chipAddr = document.getElementById('chipAddress');
                if (chipAddr) chipAddr.textContent = shortAddr;

                var recInput = document.getElementById('receiveAddress');
                if (recInput) recInput.value = state.address;

                var addrType = document.getElementById('addressType');
                if (addrType) addrType.textContent = 'Primary';

                var addrLabel = document.getElementById('addressLabel');
                if (addrLabel) addrLabel.textContent = 'Main address';

                UI.renderQr(state.address);
            } else {
                var homeBal = document.getElementById('homeBalance');
                if (homeBal) homeBal.textContent = '0 XMR';

                var homeUsd = document.getElementById('homeBalanceUsd');
                if (homeUsd) homeUsd.textContent = '≈ $0.00 USD';

                var recInput2 = document.getElementById('receiveAddress');
                if (recInput2) recInput2.value = 'Import wallet to view address';

                var sendAvail = document.getElementById('sendAvailable');
                if (sendAvail) sendAvail.textContent = 'Available: 0 XMR';
                var sendLocked0 = document.getElementById('sendLocked');
                if (sendLocked0) sendLocked0.textContent = '';
                var homePending0 = document.getElementById('homePending');
                if (homePending0) homePending0.textContent = '0 XMR';
                var homePendingSub0 = document.getElementById('homePendingSub');
                if (homePendingSub0) homePendingSub0.textContent = 'No pending funds';

                UI.renderQr('');
                UI.renderTransactions([]);
                renderSyncBanner(null);
            }

            UI.updateBalanceDisplay();
        });

        WalletState.on('balanceChange', function() {
            UI.updateBalanceDisplay();
            UI.setSendLock('loading', WalletState.isSignedIn() && WalletState.unlockedBalance === null);
        });

        // Home-page progress banner while the wallet scans; hidden once synced.
        function renderSyncBanner(sync) {
            var banner = document.getElementById('syncBanner');
            if (!banner) return;
            var title = document.getElementById('syncBannerTitle');
            var detail = document.getElementById('syncBannerDetail');
            var fill = document.getElementById('syncBarFill');
            var show = Boolean(sync && WalletState.isSignedIn() && (sync.syncing || (!sync.synced && !sync.stale && !sync.loading)));
            banner.style.display = show ? 'block' : 'none';
            if (!show) return;
            var startH = (typeof sync.scanStart === 'number' && sync.scanStart > 0) ? sync.scanStart : (WalletState.restoreHeight || 0);
            var cur = sync.current || 0, target = sync.target || 0;
            var pct = 0;
            if (target > startH && cur >= startH) pct = Math.min(100, Math.floor(((cur - startH) / (target - startH)) * 100));
            if (sync.queued) {
                if (title) title.textContent = 'Waiting for a scanning slot';
                if (detail) detail.textContent = 'Another wallet is being restored on this server right now. Yours will start from block ' + startH.toLocaleString() + ' as soon as a slot is free. You can close this page and come back later.';
            } else if (cur < startH) {
                if (title) title.textContent = 'Preparing wallet: 0%';
                if (detail) detail.textContent = 'fast-forwarding to block ' + startH.toLocaleString();
            } else {
                if (title) title.textContent = 'Scanning blocks: ' + pct + '%';
                if (detail) detail.textContent = cur.toLocaleString() + ' / ' + target.toLocaleString() + (startH > 0 ? ' (from ' + startH.toLocaleString() + ')' : ' (from the first block)')
                    + (sync.busy && cur <= startH ? '. You can close this page; the scan continues on the server.' : '');
            }
            if (fill) fill.style.width = pct + '%';
        }

        WalletState.on('syncChange', function(sync) {
            renderSyncBanner(sync);
            var el = document.getElementById('topbarStatus');
            if (!el) return;
            if (!sync) {
                el.textContent = 'Monero node unreachable - balances may be stale';
                return;
            }
            if (sync.loading) {
                el.textContent = 'Loading wallet...';
                UI.setSendEnabled(false);
                return;
            }
            // scanStart = the height the server-side wallet FILE actually starts from (may differ
            // from the height typed at login if the file was created earlier without one).
            var startH = (typeof sync.scanStart === 'number') ? sync.scanStart : (WalletState.restoreHeight || 0);
            if (sync.syncing && sync.queued) {
                el.textContent = 'Waiting for a scanning slot: another wallet is being restored on this server. Yours starts from block ' + startH.toLocaleString() + ' as soon as a slot is free.';
                UI.setSendEnabled(false);
                UI.updateBalanceDisplay();
                return;
            }
            if (sync.syncing && startH > 0 && sync.current < startH) {
                el.textContent = 'Preparing wallet: fast-forwarding block headers to ' + startH.toLocaleString() + ' (no scanning yet)';
                UI.setSendEnabled(false);
                UI.updateBalanceDisplay();
                return;
            }
            if (sync.syncing) {
                var remaining = Math.max(0, sync.target - sync.current);
                var span = startH > 0 ? ('from block ' + startH.toLocaleString() + ' to ' + sync.target.toLocaleString()) : ('from the first block to ' + sync.target.toLocaleString() + ' (wallet was created without a restore height)');
                var pctTop = (sync.target > startH && sync.current >= startH) ? (' ' + Math.min(100, Math.floor(((sync.current - startH) / (sync.target - startH)) * 100)) + '%') : '';
                el.textContent = 'Syncing' + pctTop + ': scanning ' + span + (remaining > 0 && sync.current > 0 ? ' (' + remaining.toLocaleString() + ' remaining)' : '') + '. Balance appears when done.';
                UI.setSendEnabled(false);
                UI.updateBalanceDisplay();
                return;
            }
            if (sync.stale) {
                var when = sync.asOf ? new Date(sync.asOf * 1000).toLocaleTimeString() : 'earlier';
                el.textContent = 'Showing last known state (as of ' + when + ', block ' + sync.current + ') - updating...';
                UI.setSendEnabled(false);
                return;
            }
            if (sync.synced) {
                el.textContent = 'Connected to Monero network (Synced at block ' + sync.target + ')';
                UI.updateBalanceDisplay();
            } else {
                var behind = Math.max(0, sync.target - sync.current);
                var start = WalletState.restoreHeight || 0;
                var pct = '';
                if (sync.target > start && sync.current >= start) {
                    pct = ' ' + Math.min(100, Math.floor(((sync.current - start) / (sync.target - start)) * 100)) + '%';
                }
                var note = (WalletState.restoreSource === 'genesis') ? ' - full scan from the first block, this takes a long time' : '';
                el.textContent = 'Scanning wallet' + pct + ': ' + sync.current + ' / ' + sync.target + ' (' + behind + ' blocks behind' + note + ')';
            }
            UI.setSendEnabled(sync.synced);
        });

        WalletState.on('priceChange', function() {
            UI.updateSummary();
        });

        WalletState.on('feesChange', function(levels) {
            UI.setFeeLevels(levels);
        });

        WalletState.on('transactionsChange', function(txs) {
            UI.renderTransactions(txs);
        });

        WalletState.on('keyImagesSynced', function(info) {
            if (info && info.imported > 0) {
                UI.notify('Spent outputs synced (' + info.imported + ' key images). Balance updated.');
            }
        });

        WalletState.on('keyImagesSyncFailed', function(reason) {
            UI.notify('Spent-output sync failed: ' + reason);
        });

        // "Ka-ching" when money moves. Preloaded once; browsers allow playback because the user
        // has already interacted with the page (login click) by the time a transaction arrives.
        var kaching = null;
        try {
            kaching = new Audio('/sounds/kaching.mp3?v=1');
            kaching.preload = 'auto';
            kaching.volume = 0.6;
        } catch (e) { kaching = null; }
        var lastKachingAt = 0;
        function playKaching() {
            if (!kaching) return;
            var now = Date.now();
            if (now - lastKachingAt < 1500) return; // several txs in one update -> one sound
            lastKachingAt = now;
            try {
                kaching.currentTime = 0;
                var p = kaching.play();
                if (p && typeof p.catch === 'function') p.catch(function() {}); // autoplay blocked: stay silent
            } catch (e) {}
        }

        WalletState.on('newTransactions', function(fresh) {
            var moneyMoved = false;
            fresh.forEach(function(tx) {
                var amt = (typeof formatXmr === 'function' && tx.amount) ? formatXmr(tx.amount) : '';
                var isOut = tx.type === 'out' || tx.direction === 'out' || tx.type === 'pendingtx';
                var pending = tx.type === 'pool' || tx.type === 'pendingtx';
                UI.notify((isOut ? 'Outgoing ' : 'Incoming ') + amt + ' XMR' + (pending ? ' (unconfirmed)' : ' confirmed'));
                moneyMoved = true;
            });
            if (moneyMoved) playKaching();
        });

        // 2. Navigation & Sidebar
        document.addEventListener('click', function(e) {
            var btn = e.target.closest('[data-page]');
            if (btn) {
                if (btn.tagName === 'A' || btn.classList.contains('brand')) e.preventDefault();
                var target = btn.dataset.page;
                if (target) UI.showPage(target);
            }
        });

        var menuBtn = document.getElementById('menuBtn');
        if (menuBtn) {
            menuBtn.addEventListener('click', function() {
                var sidebar = document.getElementById('sidebar');
                if (sidebar) sidebar.classList.toggle('open');
            });
        }

        // 3. Topbar Account Dropdown
        var chipBtn = document.getElementById('walletChipBtn');
        if (chipBtn) {
            chipBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                var dd = document.getElementById('accountDropdown');
                if (dd) dd.classList.toggle('open');
                this.classList.toggle('open');
            });
        }

        document.addEventListener('click', function(e) {
            var wrap = document.getElementById('accountSwitcherWrap');
            if (wrap && !wrap.contains(e.target)) {
                var dd = document.getElementById('accountDropdown');
                if (dd) dd.classList.remove('open');
                if (chipBtn) chipBtn.classList.remove('open');
            }
        });

        var btnConnectNew = document.getElementById('btnConnectNew');
        if (btnConnectNew) {
            btnConnectNew.addEventListener('click', function(e) {
                e.stopPropagation();
                var dd = document.getElementById('accountDropdown');
                if (dd) dd.classList.remove('open');
                if (chipBtn) chipBtn.classList.remove('open');
                var sw = document.getElementById('seedWords');
                if (sw) sw.value = '';
                var ka = document.getElementById('keyAddress');
                if (ka) ka.value = '';
                var kv = document.getElementById('keyView');
                if (kv) kv.value = '';
                var ks = document.getElementById('keySpend');
                if (ks) ks.value = '';
                ['restoreHeight', 'restoreMonth', 'restoreYear', 'restoreTxid'].forEach(function(id) {
                    var el = document.getElementById(id);
                    if (el) el.value = '';
                });
                ['restoreDateHint', 'restoreTxidHint'].forEach(function(id) {
                    var el = document.getElementById(id);
                    if (el) el.textContent = '';
                });
                restoreSource = 'manual';
                UI.showPage('import');
            });
        }

        var btnDisconnectAll = document.getElementById('btnDisconnectAll');
        if (btnDisconnectAll) {
            btnDisconnectAll.addEventListener('click', async function(e) {
                e.stopPropagation();
                if (confirm('Are you sure you want to disconnect all connected wallets?')) {
                    await WalletState.disconnectAll();
                    UI.notify('All wallets disconnected');
                    UI.showPage('welcome');
                }
            });
        }

        var btnLogout = document.getElementById('btnLogout');
        if (btnLogout) {
            btnLogout.addEventListener('click', async function() {
                if (!WalletState.address) return;
                if (confirm('Are you sure you want to disconnect this wallet?')) {
                    await WalletState.removeConnectedWallet(WalletState.address);
                    UI.notify('Wallet disconnected');
                    if (!WalletState.isSignedIn()) UI.showPage('welcome');
                }
            });
        }

        /**
         * Proof of work for NEW wallets: find a nonce so that keccak(challenge+address+nonce)
         * starts with `bits` zero bits. Runs in slices so the page stays responsive.
         */
        async function solvePow(challenge, address, bits, onProgress) {
            var addrHex = '';
            for (var i = 0; i < address.length; i++) addrHex += ('0' + address.charCodeAt(i).toString(16)).slice(-2);
            var prefix = challenge + addrHex;
            var expected = Math.pow(2, bits);
            var nonce = Math.floor(Math.random() * 0xffffffff) >>> 0;
            var tries = 0;
            var start = Date.now();
            // Slices of 12k hashes (~40 ms on a laptop, ~250 ms on a slow phone) between yields:
            // few enough yields that a throttled background tab still finishes in seconds.
            while (true) {
                for (var k = 0; k < 12000; k++) {
                    var nonceHex = ('00000000' + (nonce >>> 0).toString(16)).slice(-8);
                    var h = cnUtil.cn_fast_hash(prefix + nonceHex);
                    var zeros = 0;
                    for (var c = 0; c < h.length; c++) {
                        var v = parseInt(h.charAt(c), 16);
                        if (v === 0) { zeros += 4; continue; }
                        zeros += (v < 2) ? 3 : (v < 4) ? 2 : (v < 8) ? 1 : 0;
                        break;
                    }
                    if (zeros >= bits) return nonceHex;
                    nonce = (nonce + 1) >>> 0;
                    tries++;
                }
                if (onProgress) onProgress(Math.min(99, Math.round(100 * tries / expected)), Date.now() - start);
                await new Promise(function(r) { setTimeout(r, 0); });
            }
        }

        /**
         * Run an auth call; when the server answers POW_REQUIRED (first time this wallet is seen
         * here), solve the puzzle and retry with the solution.
         */
        async function authWithPow(address, btn, doAuth) {
            var res = await doAuth(null);
            var rounds = 0;
            while (!res.success && res.needsPow && rounds < 3) {
                rounds++;
                var label = btn ? btn.textContent : '';
                var nonce = await solvePow(res.powChallenge, address, res.powBits, function(pct) {
                    if (btn) btn.textContent = 'Checking you are not a robot... ' + pct + '%';
                });
                if (btn) btn.textContent = label;
                res = await doAuth({ challenge: res.powChallenge, nonce: nonce });
            }
            return res;
        }

        /** Wipe seed / key fields so nothing secret stays visible in the page afterwards. */
        function clearSecretInputs() {
            ['seedWords', 'keyView', 'keySpend'].forEach(function(id) {
                var el = document.getElementById(id);
                if (el) el.value = '';
            });
            UI.clearGeneratedSeed();
        }

        // 4. Create Account Controls
        var btnRegen = document.getElementById('btnRegenerateSeed');
        if (btnRegen) {
            btnRegen.addEventListener('click', function() {
                UI.generateNewSeed();
                UI.notify('New seed generated');
            });
        }

        var btnCopySeed = document.getElementById('btnCopyGeneratedSeed');
        if (btnCopySeed) {
            btnCopySeed.addEventListener('click', function() {
                var seed = UI.getGeneratedSeed();
                if (!seed) return;
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(seed).then(function() {
                        UI.notify('Seed words copied to clipboard!');
                    }).catch(function() {
                        prompt('Copy your seed phrase:', seed);
                    });
                } else {
                    prompt('Copy your seed phrase:', seed);
                }
            });
        }

        var selLang = document.getElementById('createSeedLang');
        if (selLang) {
            selLang.addEventListener('change', function() {
                UI.generateNewSeed(this.value);
            });
        }

        var btnCreateAcc = document.getElementById('btnCreateAccount');
        if (btnCreateAcc) {
            btnCreateAcc.addEventListener('click', async function() {
                var keys = UI.getGeneratedKeys();
                var seed = UI.getGeneratedSeed();
                if (!keys || !seed || keys.seed !== seed) {
                    // Never open a wallet on a seed the user has not seen on screen.
                    alert('No seed is shown yet. Press "New seed", write down all 25 words, then open the wallet.');
                    return;
                }

                var chk = document.getElementById('chkSeedSaved');
                if (chk && !chk.checked) {
                    alert('Please check the box confirming you have written down and stored your 25-word recovery seed.');
                    chk.focus();
                    return;
                }

                var btn = this;
                btn.disabled = true;
                btn.textContent = 'Creating wallet session...';

                try {
                    var authRes = await authWithPow(keys.address, btn, function(pow) { return XMR_API.auth(keys.address, keys.viewkey, 0, 1, 'new', false, pow); });
                    if (authRes.success) {
                        WalletState.saveConnectedWallet({
                            session_id: authRes.sessionId,
                            address: keys.address,
                            viewkey: keys.viewkey,
                            spendkey: keys.spendkey,
                            seed: keys.seed,
                            restore_height: authRes.restoreHeight,
                            restore_source: authRes.restoreSource,
                            balance: '0',
                            last_active: Date.now()
                        });
                        await WalletState.switchWallet(keys.address);
                        clearSecretInputs();
                        UI.notify('New Monero wallet created successfully!');
                        UI.showPage('home');
                    } else {
                        alert('Authentication failed: ' + authRes.error);
                    }
                } catch (e) {
                    alert('Connection error communicating with wallet server.');
                } finally {
                    btn.disabled = false;
                    btn.textContent = "Open wallet";
                }
            });
        }

        // 5. Restore Wallet Controls
        document.querySelectorAll('[data-import]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                document.querySelectorAll('[data-import]').forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');
                var isSeed = (btn.dataset.import === 'seed');
                var sImp = document.getElementById('seedImport');
                var kImp = document.getElementById('keysImport');
                if (sImp) sImp.hidden = !isSeed;
                if (kImp) kImp.hidden = isSeed;
            });
        });

        // Where the restore height came from: manual | date | txid | polyseed (sent to the backend and stored per wallet)
        var restoreSource = 'manual';

        // Seed field: masked by default; eye toggle reveals, Paste reads the clipboard.
        var seedToggleBtn = document.getElementById('seedToggle');
        if (seedToggleBtn) {
            seedToggleBtn.addEventListener('click', function() {
                var ta = document.getElementById('seedWords');
                if (!ta) return;
                var masked = ta.classList.toggle('seed-masked');
                seedToggleBtn.innerHTML = masked ? '&#128065; Show' : '&#128065; Hide';
                seedToggleBtn.setAttribute('aria-pressed', masked ? 'false' : 'true');
            });
        }
        var seedPasteBtn = document.getElementById('seedPaste');
        if (seedPasteBtn) {
            seedPasteBtn.addEventListener('click', async function() {
                var ta = document.getElementById('seedWords');
                if (!ta) return;
                try {
                    var text = await navigator.clipboard.readText();
                    if (!text || !text.trim()) { UI.notify('Clipboard is empty'); return; }
                    ta.value = text.trim().replace(/\s+/g, ' ');
                    ta.dispatchEvent(new Event('input'));
                    UI.notify('Seed pasted');
                } catch (e) {
                    UI.notify('Clipboard access was blocked by the browser; paste with Ctrl+V / Cmd+V instead.');
                    ta.focus();
                }
            });
        }

        // Live hint under the seed box: word count, and for a Polyseed its embedded creation month.
        var seedWordsInput = document.getElementById('seedWords');
        if (seedWordsInput) {
            seedWordsInput.addEventListener('input', function() {
                var hint = document.getElementById('seedHint');
                if (!hint) return;
                var words = this.value.trim().split(/\s+/).filter(Boolean);
                if (words.length === 0) { hint.textContent = ''; return; }
                if (words.length === 16 && window.Polyseed) {
                    try {
                        var ps = window.Polyseed.decode(this.value);
                        hint.textContent = ps.encrypted
                            ? 'Polyseed detected, but it is passphrase-encrypted (not supported).'
                            : 'Polyseed detected: wallet created around ' + ps.birthdayDate.slice(0, 7) + '. The restore height will be set automatically.';
                    } catch (e) {
                        hint.textContent = '16 words: ' + e.message;
                    }
                    return;
                }
                hint.textContent = words.length + ' word' + (words.length === 1 ? '' : 's') + (words.length === 25 || words.length === 13 ? '' : ' (25-word seed or 16-word Polyseed expected)');
            });
        }
        var restoreHeightInput = document.getElementById('restoreHeight');
        if (restoreHeightInput) {
            restoreHeightInput.addEventListener('input', function() { restoreSource = 'manual'; });
        }

        // Creation date -> restore height (avoids a full scan from block 0 for imported wallets)
        // Creation month + year -> restore height: first day of that month minus one week, so an
        // approximate answer still lands before the wallet's first output.
        var restoreMonthSel = document.getElementById('restoreMonth');
        var restoreYearSel = document.getElementById('restoreYear');
        if (restoreMonthSel && restoreYearSel) {
            var monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
            monthNames.forEach(function(m, i) {
                var o = document.createElement('option');
                o.value = String(i + 1);
                o.textContent = m;
                restoreMonthSel.appendChild(o);
            });
            var thisYear = new Date().getUTCFullYear();
            for (var y = thisYear; y >= 2014; y--) {
                var oy = document.createElement('option');
                oy.value = String(y);
                oy.textContent = String(y);
                restoreYearSel.appendChild(oy);
            }
            var monthYearSeq = 0;
            var onMonthYear = async function() {
                var hint = document.getElementById('restoreDateHint');
                var m = parseInt(restoreMonthSel.value, 10);
                var y = parseInt(restoreYearSel.value, 10);
                if (!(m >= 1 && m <= 12) || !(y >= 2014)) { if (hint) hint.textContent = ''; return; }
                var seq = ++monthYearSeq;
                var start = new Date(Date.UTC(y, m - 1, 1) - 7 * 86400000);
                var dateStr = start.getUTCFullYear() + '-' + ('0' + (start.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + start.getUTCDate()).slice(-2);
                if (hint) hint.textContent = 'Looking up the block for ' + monthNames[m - 1] + ' ' + y + '...';
                var h = await XMR_API.getHeightForDate(dateStr);
                if (seq !== monthYearSeq) return; // a newer selection superseded this one
                if (h === null) {
                    if (hint) hint.textContent = 'Could not resolve that month right now; enter a height manually or leave 0.';
                    return;
                }
                if (restoreHeightInput) restoreHeightInput.value = String(h);
                restoreSource = 'date';
                if (hint) hint.textContent = '\u2248 starts from block ' + h.toLocaleString();
            };
            restoreMonthSel.addEventListener('change', onMonthYear);
            restoreYearSel.addEventListener('change', onMonthYear);
        }

        // Known transaction id -> restore height (exact, from the chain)
        var restoreTxidInput = document.getElementById('restoreTxid');
        if (restoreTxidInput) {
            restoreTxidInput.addEventListener('change', async function() {
                var hint = document.getElementById('restoreTxidHint');
                var txid = this.value.trim();
                if (!txid) { if (hint) hint.textContent = ''; return; }
                if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
                    if (hint) hint.textContent = 'A transaction ID is 64 hex characters.';
                    return;
                }
                if (hint) hint.textContent = 'Looking up the block of that transaction...';
                var info = await XMR_API.getHeightForTxid(txid);
                if (!info) {
                    if (hint) hint.textContent = 'Transaction not found on chain (check the ID, or it may still be unconfirmed).';
                    return;
                }
                if (restoreHeightInput) restoreHeightInput.value = String(info.height);
                restoreSource = 'txid';
                if (hint) hint.textContent = 'Transaction is in block ' + info.txHeight + '; restore height set to ' + info.height + '.';
            });
        }

        var restoreBtn = document.getElementById('restoreBtn');
        if (restoreBtn) {
            restoreBtn.addEventListener('click', async function() {
                var sImp = document.getElementById('seedImport');
                var isSeed = sImp ? !sImp.hidden : true;
                var btn = this;
                btn.disabled = true;
                btn.textContent = 'Connecting wallet...';

                try {
                    var addr = '', view = '', spend = '', cleanSeed = '';
                    if (isSeed) {
                        var rawSeed = document.getElementById('seedWords').value.trim().replace(/\s+/g, ' ');
                        if (!rawSeed) {
                            alert('Please enter your recovery seed words.');
                            btn.disabled = false;
                            btn.textContent = 'Restore wallet';
                            return;
                        }
                        var keys;
                        if (window.Polyseed && window.Polyseed.looksLikePolyseed(rawSeed)) {
                            // 16-word Polyseed: the creation month is inside the seed, so the restore
                            // height can be derived without asking the user.
                            var ps;
                            try {
                                ps = window.Polyseed.decode(rawSeed);
                            } catch (e) {
                                alert('Polyseed error: ' + e.message);
                                btn.disabled = false;
                                btn.textContent = 'Restore wallet';
                                return;
                            }
                            if (ps.encrypted) {
                                alert('This Polyseed is passphrase-encrypted, which this wallet does not support yet.');
                                btn.disabled = false;
                                btn.textContent = 'Restore wallet';
                                return;
                            }
                            btn.textContent = 'Deriving keys from Polyseed...';
                            var psKey = await window.Polyseed.deriveKey(ps);
                            // The PBKDF2 output is a raw 256-bit value. wallet2 reduces it modulo the
                            // curve order BEFORE deriving the view key (keccak of the reduced spend
                            // key). create_address only reduces the spend half, so reduce here first
                            // or the address differs from Cake / Feather for most seeds.
                            keys = cnUtil.create_address(cnUtil.sc_reduce32(psKey));
                            cleanSeed = rawSeed.toLowerCase();
                            var rhInput = document.getElementById('restoreHeight');
                            if (rhInput && !(parseInt(rhInput.value, 10) > 0)) {
                                var psHeight = await XMR_API.getHeightForDate(ps.birthdayDate);
                                if (psHeight !== null) {
                                    rhInput.value = String(psHeight);
                                    restoreSource = 'polyseed';
                                }
                            }
                        } else {
                            var seedLang = (typeof findseedlanguage === 'function') ? findseedlanguage(rawSeed) : 'english';
                            cleanSeed = (seedLang === 'german') ? rawSeed : rawSeed.toLowerCase();
                            var decoded = null;
                            try {
                                decoded = mn_decode(cleanSeed, seedLang);
                            } catch (seedErr) {
                                // mn_decode throws plain strings ("invalid word in mnemonic", checksum failure)
                                alert('Invalid seed: ' + ((seedErr && seedErr.message) || String(seedErr)) + '\nPlease double-check your 25 words.');
                                btn.disabled = false;
                                btn.textContent = 'Restore wallet';
                                return;
                            }
                            if (!decoded) {
                                alert('Invalid seed words! Please double-check your recovery seed.');
                                btn.disabled = false;
                                btn.textContent = 'Restore wallet';
                                return;
                            }
                            keys = cnUtil.create_address(decoded);
                        }
                        addr = cnUtil.pubkeys_to_string(keys.spend.pub, keys.view.pub);
                        view = keys.view.sec;
                        spend = keys.spend.sec;
                    } else {
                        addr = document.getElementById('keyAddress').value.trim();
                        view = document.getElementById('keyView').value.trim();
                        spend = document.getElementById('keySpend').value.trim();

                        if (addr.length !== 95 || !/^[1-9A-HJ-NP-Za-km-z]{95}$/.test(addr)) {
                            alert('Invalid primary Monero address format (must be 95 characters).');
                            btn.disabled = false;
                            btn.textContent = 'Restore wallet';
                            return;
                        }
                        if (view.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(view)) {
                            alert('Invalid private view key format (must be 64 hex characters).');
                            btn.disabled = false;
                            btn.textContent = 'Restore wallet';
                            return;
                        }
                        view = view.toLowerCase();

                        // Verify the keys actually belong to this address before creating a session,
                        // otherwise a typo only surfaces later as an obscure signing failure.
                        var decodedAddr;
                        try {
                            decodedAddr = cnUtil.decode_address(addr);
                        } catch (e) {
                            alert('Invalid Monero address (checksum failed). Please re-check it.');
                            btn.disabled = false;
                            btn.textContent = 'Restore wallet';
                            return;
                        }
                        if (cnUtil.sec_key_to_pub(view) !== decodedAddr.view) {
                            alert('This private view key does not belong to this address.');
                            btn.disabled = false;
                            btn.textContent = 'Restore wallet';
                            return;
                        }
                        if (spend) {
                            if (!/^[0-9a-fA-F]{64}$/.test(spend)) {
                                alert('Invalid private spend key format (must be 64 hex characters, or leave it empty for view-only).');
                                btn.disabled = false;
                                btn.textContent = 'Restore wallet';
                                return;
                            }
                            spend = spend.toLowerCase();
                            if (cnUtil.sec_key_to_pub(spend) !== decodedAddr.spend) {
                                alert('This private spend key does not belong to this address.');
                                btn.disabled = false;
                                btn.textContent = 'Restore wallet';
                                return;
                            }
                        }
                        cleanSeed = 'Imported via Private Keys';
                    }

                    var rHeightInput = document.getElementById('restoreHeight');
                    var rHeightVal = rHeightInput ? parseInt(rHeightInput.value.trim() || '0', 10) : 0;
                    if (isNaN(rHeightVal) || rHeightVal < 0) rHeightVal = 0;

                    var authRes = await authWithPow(addr, btn, function(pow) { return XMR_API.auth(addr, view, rHeightVal, 0, rHeightVal > 0 ? restoreSource : 'manual', false, pow); });
                    if (!authRes.success && authRes.needsFullScanConfirm) {
                        // The server has no stored height for this wallet either: a scan from the
                        // first block would start. Ask explicitly instead of guessing a height.
                        var proceed = confirm(
                            'No restore height, creation date or transaction ID was given, and this wallet has not been imported here before.\n\n' +
                            'The wallet will be scanned from the very first block. This can take hours. Funds appear as the scan passes them, and sending is disabled until the scan reaches the current block.\n\n' +
                            'Continue with a full scan? (Cancel to enter a creation date or an old transaction ID.)');
                        if (!proceed) {
                            btn.disabled = false;
                            btn.textContent = 'Restore wallet';
                            return;
                        }
                        authRes = await authWithPow(addr, btn, function(pow) { return XMR_API.auth(addr, view, 0, 0, 'manual', true, pow); });
                    }
                    if (authRes.success) {
                        if (authRes.restoreSource === 'stored' && rHeightVal === 0) {
                            UI.notify('Using the restore height saved for this wallet earlier (block ' + authRes.restoreHeight + ')');
                        }
                        WalletState.saveConnectedWallet({
                            session_id: authRes.sessionId,
                            address: addr,
                            viewkey: view,
                            spendkey: spend,
                            seed: cleanSeed,
                            restore_height: authRes.restoreHeight,
                            restore_source: authRes.restoreSource,
                            balance: '0',
                            last_active: Date.now()
                        });
                        await WalletState.switchWallet(addr);
                        clearSecretInputs();
                        UI.notify('Wallet connected successfully!');
                        UI.showPage('home');
                    } else {
                        alert('Authentication failed: ' + authRes.error);
                    }
                } catch(err) {
                    console.error(err);
                    alert('Error restoring wallet: ' + ((err && err.message) || String(err)));
                } finally {
                    btn.disabled = false;
                    btn.textContent = 'Restore wallet';
                }
            });
        }

        // 6. Send Page Controls
        var amountInput = document.getElementById('amount');
        // When MAX is pressed we send the whole unlocked balance with `sweep_all`, letting the
        // wallet compute the exact fee (a float "balance - estimated fee" always under/overshoots).
        var sendSweepAll = false;
        if (amountInput) {
            amountInput.addEventListener('input', function() {
                sendSweepAll = false;
                UI.setSweepMode(false);
            });
        }

        document.querySelectorAll('#priority button').forEach(function(btn) {
            btn.addEventListener('click', function() {
                document.querySelectorAll('#priority button').forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');
                UI.setPriority(btn.dataset.priority);
            });
        });

        var unitToggle = document.getElementById('amountUnitToggle');
        if (unitToggle) {
            unitToggle.addEventListener('click', function() {
                UI.toggleAmountUnit();
            });
        }

        var btnMaxAmount = document.getElementById('btnMaxAmount');
        if (btnMaxAmount) {
            btnMaxAmount.addEventListener('click', function() {
                if (!WalletState.unlockedBalance || typeof moneroBalance !== 'function') {
                    UI.notify('No unlocked balance available yet');
                    return;
                }
                if (amountInput) {
                    if (UI.getAmountUnit() === 'USD' && WalletState.usdPrice > 0) {
                        amountInput.value = (parseFloat(formatXmr(WalletState.unlockedBalance)) * WalletState.usdPrice).toFixed(2);
                    } else {
                        amountInput.value = formatXmr(WalletState.unlockedBalance);
                    }
                    sendSweepAll = true;
                    UI.setSweepMode(true);
                    UI.notify('Sending entire unlocked balance (fee is deducted from it)');
                }
            });
        }

        var reviewSendBtn = document.getElementById('reviewSend');
        if (reviewSendBtn) {
            reviewSendBtn.addEventListener('click', async function() {
                var toAddr = (document.getElementById('sendAddress') ? document.getElementById('sendAddress').value : '').trim();
                var amtStr = UI.getAmountXmr(); // always XMR, converted from USD if that unit is selected
                var pidEl = document.getElementById('paymentId');
                var sweep = sendSweepAll;

                var btn = this;
                if (WalletState.syncStatus && !WalletState.syncStatus.synced) {
                    var behindNow = Math.max(0, WalletState.syncStatus.target - WalletState.syncStatus.current);
                    alert('This wallet is still scanning the blockchain (' + behindNow + ' blocks behind). Sending is disabled until the scan reaches the current block, otherwise the balance and spendable outputs would be incomplete.');
                    return;
                }
                btn.disabled = true;

                try {
                    var res = await TransactionManager.send({
                        toAddress: toAddr,
                        amountStr: amtStr,
                        sweepAll: sweep,
                        priority: UI.getPriority(),
                        onStatus: function(msg) {
                            btn.textContent = msg;
                            UI.notify(msg);
                        },
                        onConfirm: async function(info) {
                            btn.textContent = 'Waiting for your confirmation...';
                            var lines = [
                                'Please confirm this transaction (it will be signed locally and broadcast):',
                                '',
                                'To: ' + info.toAddress,
                                'Amount: ' + info.amountXmr + ' XMR' + (info.sweep ? ' (entire unlocked balance)' : ''),
                                'Network fee: ' + info.feeXmr + ' XMR',
                                (info.changeAtomic && info.changeAtomic !== '0') ? ('Change back to this wallet: ' + info.changeXmr + ' XMR') : '',
                                info.txCount > 1 ? ('Split into ' + info.txCount + ' transactions') : '',
                                '',
                                'Monero transactions cannot be reversed.'
                            ].filter(function(l, i, arr) { return !(l === '' && arr[i - 1] === ''); });
                            return confirm(lines.join('\n'));
                        }
                    });

                    if (res && res.success) {
                        var shortHash = res.txid.slice(0, 8) + '...' + res.txid.slice(-8);
                        UI.notify('Transaction broadcast successfully! TxID: ' + shortHash);
                        alert('Transaction sent successfully!\n\nTxID: ' + (res.txids && res.txids.length > 1 ? res.txids.join('\n') : res.txid) + '\nAmount: ' + res.amount + ' XMR\nFee: ' + res.fee + ' XMR');

                        if (amountInput) amountInput.value = '';
                        sendSweepAll = false;
                        UI.setSweepMode(false);
                        var sendAddrInput = document.getElementById('sendAddress');
                        if (sendAddrInput) sendAddrInput.value = '';
                        if (pidEl) pidEl.value = '';
                        UI.updateSummary();
                        UI.showPage('home');
                    }
                } catch(err) {
                    console.error('Send error:', err);
                    if (err && err.signedTxsetHex) {
                        // Signed but not confirmed as broadcast: offer to re-send the SAME signed
                        // transaction. Building a new one could pay the recipient twice.
                        var again = true;
                        var msg = (err.maybeBroadcast ? 'The transaction was signed and MAY already be on the network.' : 'The transaction was signed but the server could not broadcast it yet (' + err.message + ').') +
                            '\n\nDo NOT create a new transaction. Retry broadcasting the same signed transaction now?';
                        while (again && confirm(msg)) {
                            btn.textContent = 'Re-broadcasting the signed transaction...';
                            var rr = await TransactionManager.resubmit(err.sessionId, err.signedTxsetHex, err.txInfo);
                            if (rr.success) {
                                again = false;
                                alert('Transaction sent successfully!\n\nTxID: ' + (rr.txids && rr.txids.length > 1 ? rr.txids.join('\n') : rr.txid));
                                if (amountInput) amountInput.value = '';
                                sendSweepAll = false;
                                UI.setSweepMode(false);
                                var sa = document.getElementById('sendAddress');
                                if (sa) sa.value = '';
                                UI.updateSummary();
                                WalletState.pollState();
                                UI.showPage('home');
                            } else {
                                msg = 'Still not broadcast: ' + rr.reason + '\n\nRetry the same signed transaction? (Check History first if unsure.)';
                            }
                        }
                        if (again) { alert('The signed transaction was not re-sent. Check History before creating a new transaction.'); WalletState.pollState(); }
                    } else {
                        alert('Error sending transaction: ' + ((err && err.message) || String(err)));
                    }
                } finally {
                    btn.disabled = false;
                    btn.textContent = 'Send transaction';
                }
            });
        }

        // 7. Receive Page Controls
        var copyAddrBtn = document.getElementById('copyAddress');
        if (copyAddrBtn) {
            copyAddrBtn.addEventListener('click', async function() {
                var addr = document.getElementById('receiveAddress') ? document.getElementById('receiveAddress').value : '';
                if (!addr || addr.indexOf('Import') !== -1) {
                    UI.notify('No wallet address loaded yet');
                    return;
                }
                try {
                    await navigator.clipboard.writeText(addr);
                    UI.notify('Address copied to clipboard');
                } catch(e) {
                    var tempInput = document.createElement('input');
                    tempInput.value = addr;
                    document.body.appendChild(tempInput);
                    tempInput.select();
                    document.execCommand('copy');
                    document.body.removeChild(tempInput);
                    UI.notify('Address copied');
                }
            });
        }

        var newSubBtn = document.getElementById('newSubaddress');
        if (newSubBtn) {
            newSubBtn.addEventListener('click', async function() {
                if (!WalletState.mainKeys) {
                    UI.notify('Please import wallet from seed to generate subaddresses');
                    return;
                }
                newSubBtn.disabled = true;
                var sub = null;
                try { sub = await WalletState.generateNextSubaddress(); } finally { newSubBtn.disabled = false; }
                if (sub && sub.error) {
                    UI.notify(sub.error);
                    return;
                }
                if (sub && sub.address) {
                    var recInput = document.getElementById('receiveAddress');
                    if (recInput) recInput.value = sub.address;
                    var addrType = document.getElementById('addressType');
                    if (addrType) addrType.textContent = 'Subaddress';
                    var addrLabel = document.getElementById('addressLabel');
                    if (addrLabel) addrLabel.textContent = 'Subaddress #' + sub.index;
                    UI.renderQr(sub.address);
                    UI.notify('Subaddress #' + sub.index + ' generated');
                }
            });
        }

        // 8. Swap Page (crypto <-> XMR through the swap gateway, see swap.js)
        if (window.Swap) window.Swap.init();

        // 9. Strict Ephemeral Session & Automatic Reload/Close Storage Purge
        function purgePersistentStorage() {
            try {
                // Swap orders hold no keys (order ids + order tokens) and must survive
                // a reload, otherwise a guest loses the way to follow their swap.
                var swaps = localStorage.getItem('xmrnest_swap_orders');
                localStorage.removeItem('xmr_connected_wallets');
                localStorage.removeItem('xmr_active_wallet_id');
                localStorage.removeItem('xmr_session');
                localStorage.clear();
                sessionStorage.clear();
                if (swaps) localStorage.setItem('xmrnest_swap_orders', swaps);
            } catch(e) {}
        }

        // Purge immediately on startup and whenever window/tab is closed
        purgePersistentStorage();
        window.addEventListener('beforeunload', purgePersistentStorage);
        window.addEventListener('pagehide', purgePersistentStorage);

        // 9. URL Hash Routing
        var pathToPage = { '/': 'welcome', '/create': 'create', '/restore': 'import', '/import': 'import', '/how-to-use': 'how', '/how': 'how', '/swap': 'swap', '/send': 'send', '/receive': 'receive', '/app.html': 'welcome', '/index.html': 'welcome' };

        function resolveRoute() {
            var hash = window.location.hash.replace(/^#\/?/, '').replace('.html', '');
            if (!hash) {
                // Path-based URL (server-rendered pages) or the body hint the server injected.
                var p = window.location.pathname.replace(/\/+$/, '') || '/';
                hash = pathToPage[p] || document.body.getAttribute('data-route') || '';
            }
            if (hash === 'dashboard' || hash === 'overview') hash = 'home';
            if (hash === 'login') hash = 'import';
            if (hash === 'create_account' || hash === 'create' || hash === 'generate') hash = 'create';

            if (!WalletState.isSignedIn()) {
                if (hash === 'import' || hash === 'create' || hash === 'how' || hash === 'swap') {
                    return hash;
                }
                return 'welcome';
            } else {
                if (['home', 'send', 'receive', 'import', 'how', 'create', 'swap'].indexOf(hash) !== -1) {
                    return hash;
                }
                return 'home';
            }
        }

        function onRouteChange() {
            var route = resolveRoute();
            UI.showPage(route);
            if (route === 'send' && WalletState.spendkey && TransactionManager.loadSigner) {
                TransactionManager.loadSigner();
            }
        }
        window.addEventListener('hashchange', onRouteChange);
        window.addEventListener('popstate', onRouteChange);

        // 10. Initial Session Boot
        await WalletState.initFromStorage();
        UI.showPage(resolveRoute());
    });
})();
