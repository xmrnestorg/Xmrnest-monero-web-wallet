/**
 * XmrNest Swap page: any supported coin -> XMR, or XMR -> any supported coin.
 * Open to everyone; no wallet needed.
 *
 * The browser never talks to a swap service directly: everything goes through /api/swap/* on
 * our server, which forwards to the swap gateway it is configured with (docs/swap-gateway-api.md).
 * Each created order comes back with an order token (`swap_session`) that this module keeps in
 * localStorage (`xmrnest_swap_orders`, exempt from the privacy purge) and sends back to read or
 * act on the order. When a wallet is open the server also records the order under its address.
 */
(function(window) {
    'use strict';

    var QUOTE_DEBOUNCE_MS = 650;
    var POLL_MS = 12000;
    var POLL_MAX_MS = 60000;
    var STORE_KEY = 'xmrnest_swap_orders';

    var cfg = null;
    var assets = {};   // key -> asset
    var coins = {};    // symbol -> coin
    var chains = {};   // key -> chain
    var fromKey = 'BTC';
    var toKey = 'XMR';
    var quote = null;
    var quoteTimer = null;
    var quoteSeq = 0;
    var activeOrder = null;
    var activeSession = '';
    var pollTimer = null;
    var pollDelay = POLL_MS;
    var countdownTimer = null;
    var creating = false;
    var lastQrAddress = '';
    var pendingAction = null;
    var picker = { side: null, coin: null };

    var EXPLORERS = {
        monero: 'https://blockchair.com/monero/transaction/', zcash: 'https://blockchair.com/zcash/transaction/',
        btc: 'https://blockchair.com/bitcoin/transaction/', eth: 'https://blockchair.com/ethereum/transaction/',
        arb: 'https://blockchair.com/arbitrum-one/transaction/', base: 'https://blockchair.com/base/transaction/',
        bsc: 'https://blockchair.com/bnb/transaction/', sol: 'https://blockchair.com/solana/transaction/',
        tron: 'https://tronscan.org/#/transaction/'
    };
    var ADDRESS_SHAPES = {
        xmr: /^[48][1-9A-HJ-NP-Za-km-z]{94}$/,
        btc: /^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
        evm: /^0x[0-9a-fA-F]{40}$/,
        sol: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
        tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
        zec: /^(t[13][a-km-zA-HJ-NP-Z1-9]{33}|u1[a-z0-9]{40,}|zs1[a-z0-9]{70,})$/
    };
    var PLACEHOLDERS = {
        xmr: 'Monero address (starts with 4 or 8)', btc: 'Bitcoin address (bc1… or 1… / 3…)', evm: '0x… address',
        sol: 'Solana address', tron: 'Tron address (starts with T)', zec: 'Zcash address (t1… or u1…)'
    };

    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function(c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function fmtUsd(v) { var n = Number(v); return Number.isFinite(n) ? '$' + n.toFixed(2) : ''; }
    function shortHash(h) { return h ? h.slice(0, 10) + '…' + h.slice(-6) : ''; }
    function signedIn() { return window.WalletState && window.WalletState.isSignedIn(); }
    function sid() { return (signedIn() && window.WalletState.sessionId) || ''; }
    function asset(key) { return assets[key] || null; }
    function chainOf(a) { return a ? chains[a.chain] : null; }
    function family(a) { var c = chainOf(a); return c ? c.family : ''; }
    function validAddr(a, addr) {
        if (!a) return false;
        if (family(a) === 'xmr' && window.TransactionManager && window.TransactionManager.validateDestination) {
            var d = window.TransactionManager.validateDestination(addr);
            return Boolean(d && (d.type === 'standard' || d.type === 'subaddress'));
        }
        var re = ADDRESS_SHAPES[family(a)];
        return Boolean(re && re.test(addr));
    }
    function logoHtml(url, label, size) {
        var s = size || 24;
        // No inline handlers (CSP): a broken image is swapped for its letter by the capture-phase
        // error listener installed in init().
        if (url) return '<img src="' + esc(url) + '" alt="" width="' + s + '" height="' + s + '" loading="lazy" data-fallback="' + esc(String(label || '?').charAt(0)) + '">';
        return '<span class="coin-dot">' + esc(String(label || '?').charAt(0)) + '</span>';
    }
    function showError(msg) {
        var el = $('swapError');
        if (!el) return;
        if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
        el.textContent = msg;
        el.style.display = 'block';
    }

    /* ------------------------------------------------------------------ local order store */

    function loadLocal() {
        try { var v = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
    }
    function saveLocal(list) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 50))); } catch (e) {}
    }
    function rememberOrder(rec) {
        var list = loadLocal().filter(function(r) { return r.order_id !== rec.order_id; });
        list.unshift(rec);
        saveLocal(list);
    }
    function localOrder(orderId) {
        return loadLocal().filter(function(r) { return r.order_id === orderId; })[0] || null;
    }
    function patchLocal(orderId, patch) {
        var list = loadLocal();
        var hit = false;
        list.forEach(function(r) { if (r.order_id === orderId) { Object.assign(r, patch); hit = true; } });
        if (hit) saveLocal(list);
    }

    /* ------------------------------------------------------------------ config / selection */

    async function loadConfig() {
        cfg = await window.XMR_API.swapConfig();
        if (!cfg || cfg.status !== 'OK' || !cfg.enabled) {
            $('swapUnavailable').style.display = 'block';
            ['swapPayAmount', 'swapRecipientAddress', 'swapRefundAddress'].forEach(function(id) { if ($(id)) $(id).disabled = true; });
            cfg = cfg || { enabled: false, assets: [], coins: [], chains: [] };
            refreshGate();
            return;
        }
        assets = {}; coins = {}; chains = {};
        cfg.coins.forEach(function(c) { coins[c.symbol] = c; });
        cfg.chains.forEach(function(c) { chains[c.key] = c; });
        cfg.assets.forEach(function(a) { assets[a.key] = a; });
        // Service name and terms link are whatever the configured gateway reports.
        if (cfg.name) Array.prototype.forEach.call(document.querySelectorAll('.swapProviderName'), function(el) { el.textContent = cfg.name; });
        var termsNote = $('swapTermsNote'), termsLink = $('swapTermsLink');
        if (termsNote && termsLink) {
            if (cfg.terms_url) { termsLink.href = cfg.terms_url; termsNote.hidden = false; } else { termsNote.hidden = true; }
        }
        var names = [];
        cfg.coins.forEach(function(c) { if (c.symbol !== 'XMR' && cfg.assets.some(function(a) { return a.coin === c.symbol && (a.can_send || a.can_receive); })) names.push(c.symbol); });
        if ($('swapDetailCoins') && names.length) $('swapDetailCoins').textContent = names.join(', ');
        if (!asset(fromKey) || !asset(fromKey).can_send) fromKey = (cfg.assets.filter(function(a) { return a.coin !== 'XMR' && a.can_send; })[0] || {}).key || 'BTC';
        renderSelection();
        refreshGate();
    }

    function renderSelection() {
        var f = asset(fromKey), t = asset(toKey);
        [['From', f], ['To', t]].forEach(function(p) {
            var a = p[1];
            if (!a) return;
            var c = coins[a.coin] || {}, ch = chainOf(a) || {};
            $('swap' + p[0] + 'Logo').innerHTML = logoHtml(c.logo, a.coin, 24);
            $('swap' + p[0] + 'Sym').textContent = a.coin;
            $('swap' + p[0] + 'Net').textContent = ch.name || '';
        });
        if (t) {
            var fam = family(t);
            $('swapRecipientLabel').textContent = 'Your ' + t.coin + ' address' + (fam !== 'xmr' ? ' (' + (chainOf(t) || {}).name + ')' : '');
            $('swapRecipientAddress').placeholder = PLACEHOLDERS[fam] || 'Address';
            $('swapUseMyAddress').style.display = (fam === 'xmr') ? '' : 'none';
        }
        if (f) {
            var ffam = family(f);
            $('swapRefundLabel').innerHTML = 'Refund address <span class="muted" style="font-weight:600">(optional, recommended)</span>';
            $('swapRefundAddress').placeholder = 'Your own ' + f.coin + ' address' + (ffam !== 'xmr' ? ' on ' + (chainOf(f) || {}).name : '');
            $('swapRefundHelp').textContent = 'If the swap can\'t be completed, your ' + f.coin + ' is returned to this address.';
            $('swapRefundUseMine').style.display = (ffam === 'xmr') ? '' : 'none';
        }
        updatePayUsd();
    }

    function setSide(side, key) {
        var a = asset(key);
        if (!a) return;
        quote = null;
        if (side === 'from') {
            fromKey = key;
            if (a.coin === 'XMR' && asset(toKey).coin === 'XMR') toKey = firstNonXmr('can_receive');
            if (a.coin !== 'XMR' && asset(toKey).coin !== 'XMR') toKey = 'XMR';
        } else {
            toKey = key;
            if (a.coin === 'XMR' && asset(fromKey).coin === 'XMR') fromKey = firstNonXmr('can_send');
            if (a.coin !== 'XMR' && asset(fromKey).coin !== 'XMR') fromKey = 'XMR';
        }
        $('swapRecipientAddress').value = '';
        $('swapRefundAddress').value = '';
        renderSelection();
        refreshGate();
        scheduleQuote();
    }

    function firstNonXmr(flag) {
        var hit = cfg.assets.filter(function(a) { return a.coin !== 'XMR' && a[flag]; })[0];
        return hit ? hit.key : 'BTC';
    }

    function flip() {
        var f = fromKey; fromKey = toKey; toKey = f;
        quote = null;
        var amt = ($('swapGetAmount').value || '').trim();
        if (amt && parseFloat(amt) > 0) $('swapPayAmount').value = amt;
        $('swapRecipientAddress').value = '';
        $('swapRefundAddress').value = '';
        renderSelection();
        refreshGate();
        scheduleQuote();
    }

    /* ------------------------------------------------------------------ picker */

    function openPicker(side) {
        picker = { side: side, coin: null };
        $('swapPickerSearch').value = '';
        $('swapPicker').classList.add('open');
        renderPicker();
        setTimeout(function() { $('swapPickerSearch').focus(); }, 50);
    }
    function closePicker() { $('swapPicker').classList.remove('open'); }

    function renderPicker() {
        var flag = picker.side === 'from' ? 'can_send' : 'can_receive';
        var q = ($('swapPickerSearch').value || '').trim().toLowerCase();
        var list = $('swapPickerList');
        var back = $('swapPickerBack');
        var html = '';
        if (!picker.coin) {
            $('swapPickerTitle').textContent = picker.side === 'from' ? 'Coin to send' : 'Coin to receive';
            back.style.display = 'none';
            cfg.coins.forEach(function(c) {
                var nets = cfg.assets.filter(function(a) { return a.coin === c.symbol && a[flag]; });
                if (!nets.length) return;
                if (q && c.symbol.toLowerCase().indexOf(q) === -1 && c.name.toLowerCase().indexOf(q) === -1) return;
                var netName = (chainOf(nets[0]) || {}).name || '';
                var sub = nets.length > 1 ? nets.length + ' networks' : (netName && netName !== c.name ? 'on ' + netName : '');
                html += '<div class="picker-row" data-coin="' + esc(c.symbol) + '">' + logoHtml(c.logo, c.symbol, 30) +
                    '<div><strong>' + esc(c.symbol) + '</strong><div class="muted" style="font-size:12px">' + esc(c.name) + (sub ? ' · ' + esc(sub) : '') + '</div></div></div>';
            });
        } else {
            $('swapPickerTitle').textContent = picker.coin + ': choose the network';
            back.style.display = '';
            cfg.assets.filter(function(a) { return a.coin === picker.coin && a[flag]; }).forEach(function(a) {
                var ch = chainOf(a) || {};
                if (q && (ch.name || '').toLowerCase().indexOf(q) === -1) return;
                html += '<div class="picker-row" data-asset="' + esc(a.key) + '">' + logoHtml(ch.logo, ch.name, 30) +
                    '<div><strong>' + esc(ch.name) + '</strong><div class="muted" style="font-size:12px">' + esc(picker.coin) + (a.note ? ' (' + esc(a.note) + ')' : '') + ' on ' + esc(ch.name) + '</div></div></div>';
            });
        }
        list.innerHTML = html || '<div class="muted" style="font-size:13px; padding:8px 0;">Nothing matches.</div>';
    }

    function pickerClick(ev) {
        var row = ev.target.closest('.picker-row');
        if (!row) return;
        if (row.dataset.coin) {
            var flag = picker.side === 'from' ? 'can_send' : 'can_receive';
            var nets = cfg.assets.filter(function(a) { return a.coin === row.dataset.coin && a[flag]; });
            if (nets.length === 1) { setSide(picker.side, nets[0].key); closePicker(); return; }
            picker.coin = row.dataset.coin;
            $('swapPickerSearch').value = '';
            renderPicker();
            return;
        }
        if (row.dataset.asset) { setSide(picker.side, row.dataset.asset); closePicker(); }
    }

    /* ------------------------------------------------------------------ quotes */

    function updatePayUsd() {
        var el = $('swapPayUsd');
        var a = asset(fromKey);
        var amt = parseFloat(($('swapPayAmount').value || '').trim());
        if (a && a.price_usd && amt > 0) el.textContent = '≈ ' + fmtUsd(amt * a.price_usd) + ' USD';
        else el.textContent = '';
    }

    function clearQuote(msg) {
        quote = null;
        $('swapGetAmount').value = '';
        $('swapGetUsd').textContent = '';
        $('swapGetRate').textContent = msg || 'Enter an amount to see a live quote.';
        $('swapPayMin').textContent = '';
        refreshGate();
    }

    function scheduleQuote() {
        if (quoteTimer) clearTimeout(quoteTimer);
        quoteTimer = setTimeout(requestQuote, QUOTE_DEBOUNCE_MS);
    }

    async function requestQuote() {
        if (!cfg || !cfg.enabled) return;
        var f = asset(fromKey), t = asset(toKey);
        if (!f || !t) return;
        var amount = ($('swapPayAmount').value || '').trim();
        if (!/^[0-9]*\.?[0-9]+$/.test(amount) && !/^[0-9]+\.?$/.test(amount)) { clearQuote(); return; }
        if (!(parseFloat(amount) > 0)) { clearQuote(); return; }
        var to = ($('swapRecipientAddress').value || '').trim();
        var seq = ++quoteSeq;
        $('swapGetRate').textContent = 'Getting a live quote…';
        var res = await window.XMR_API.swapQuote(fromKey, toKey, amount, validAddr(t, to) ? to : '');
        if (seq !== quoteSeq) return;
        if (!res || res.status !== 'OK') {
            if (res && res.code === 'amount_below_minimum' && res.min_amount_usd) $('swapPayMin').textContent = 'Minimum ≈ ' + fmtUsd(res.min_amount_usd);
            clearQuote((res && res.reason) || 'Could not get a quote right now.');
            return;
        }
        quote = res;
        $('swapGetAmount').value = res.to_amount_human || '';
        $('swapGetUsd').textContent = res.to_usd ? '≈ ' + fmtUsd(res.to_usd) + ' USD' : '';
        // The catalog minimum is only a hint; a quote that succeeded below it proves it is not binding.
        $('swapPayMin').textContent = (res.min_deposit_usd && Number(res.from_usd) >= res.min_deposit_usd) ? 'Minimum ≈ ' + fmtUsd(res.min_deposit_usd) : '';
        var feeTxt = '';
        if (typeof res.fee_fraction === 'number' && res.fee_fraction > 0) feeTxt = (res.fee_fraction * 100).toFixed(res.fee_fraction * 100 % 1 ? 1 : 0) + '% service fee';
        if (res.integrator_fee && res.integrator_fee.percent) feeTxt += (feeTxt ? ' + ' : '') + res.integrator_fee.percent + '% XmrNest fee';
        var rate = '';
        var fromN = parseFloat(res.from_amount_human), toN = parseFloat(res.to_amount_human);
        if (fromN > 0 && toN > 0) rate = '1 ' + f.coin + ' ≈ ' + (toN / fromN).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') + ' ' + t.coin;
        $('swapGetRate').textContent = (rate ? rate + ' · ' : '') + (feeTxt || 'fees included in the rate') + '. Estimate, the final amount can differ slightly.';
        if ($('swapDetailFee')) $('swapDetailFee').textContent = feeTxt ? feeTxt.replace(' service fee', '') + (res.total_fee_usd ? ' (≈ ' + fmtUsd(res.total_fee_usd) + ')' : '') : 'Shown in the quote';
        refreshGate();
    }

    function refreshGate() {
        var btn = $('swapSubmit');
        if (!btn) return;
        var f = asset(fromKey), t = asset(toKey);
        var to = ($('swapRecipientAddress').value || '').trim();
        var help = $('swapRecipientHelp');
        if (help && t) {
            if (to && !validAddr(t, to)) { help.textContent = 'This does not look like a valid ' + t.coin + ' address for ' + (chainOf(t) || {}).name + '.'; help.style.color = '#c0392b'; }
            else { help.textContent = 'Your ' + t.coin + ' will be sent to this address.'; help.style.color = ''; }
        }
        var refund = ($('swapRefundAddress').value || '').trim();
        var rhelp = $('swapRefundHelp');
        if (rhelp && f) {
            if (refund && !validAddr(f, refund)) { rhelp.textContent = 'This does not look like a valid ' + f.coin + ' address.'; rhelp.style.color = '#c0392b'; }
            else { rhelp.textContent = 'If the swap can\'t be completed, your ' + f.coin + ' is returned to this address.'; rhelp.style.color = ''; }
        }
        btn.disabled = true;
        if (!cfg || !cfg.enabled) { btn.textContent = 'Swaps unavailable'; return; }
        if (creating) { btn.textContent = 'Creating your order…'; return; }
        if (!quote) { btn.textContent = 'Enter an amount'; return; }
        if (!to) { btn.textContent = 'Enter your ' + t.coin + ' address'; return; }
        if (!validAddr(t, to)) { btn.textContent = 'Check your ' + t.coin + ' address'; return; }
        if (refund && !validAddr(f, refund)) { btn.textContent = 'Check the refund address'; return; }
        btn.textContent = 'Start swap: send ' + quote.from_amount_human + ' ' + f.coin + ', get ≈ ' + quote.to_amount_human + ' ' + t.coin;
        btn.disabled = false;
    }

    async function createOrder() {
        if (creating || !quote) return;
        var f = asset(fromKey), t = asset(toKey);
        // The quote must describe exactly what is on screen now (pair and typed amount).
        var typed = ($('swapPayAmount').value || '').trim().replace(/^0+(?=\d)/, '').replace(/\.$/, '');
        if (quote.from !== fromKey || quote.to !== toKey || parseFloat(typed) !== parseFloat(quote.from_amount_human)) {
            quote = null; refreshGate(); scheduleQuote();
            showError('The quote is out of date. Please wait for the new quote and try again.');
            return;
        }
        showError('');
        creating = true;
        refreshGate();
        try {
            var res = await window.XMR_API.swapCreate(sid(), fromKey, toKey, quote.from_amount_human, ($('swapRecipientAddress').value || '').trim(), ($('swapRefundAddress').value || '').trim());
            if (!res || res.status !== 'OK') {
                showError((res && res.reason) || 'The swap order could not be created. Please try again.');
                return;
            }
            if (res.history) rememberOrder(Object.assign({}, res.history, { swap_session: res.swap_session || '' }));
            showOrder(res, res.swap_session || '');
            renderHistory();
            window.UI.notify('Swap order created. Send your ' + f.coin + ' now.');
        } catch (e) {
            // A timed-out create may still have created an order upstream: never re-post blindly.
            showError('No answer from the server. Check "Your swaps" below before trying again.');
            renderHistory();
        } finally {
            creating = false;
            refreshGate();
        }
    }

    /* ------------------------------------------------------------------ order card */

    function showOrder(view, swapSession) {
        activeOrder = view;
        activeSession = swapSession || '';
        $('swapFormCard').style.display = 'none';
        $('swapOrderCard').style.display = 'block';
        lastQrAddress = '';
        render(view);
        startCountdown();
        pollDelay = POLL_MS;
        if (!view.terminal) schedulePoll(POLL_MS); else stopPoll();
        $('swapOrderCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function hideOrder() {
        stopPoll();
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
        activeOrder = null;
        activeSession = '';
        lastQrAddress = '';
        $('swapOrderCard').style.display = 'none';
        $('swapFormCard').style.display = 'block';
        quote = null;
        $('swapPayAmount').value = '';
        clearQuote();
    }

    var BADGES = {
        awaiting_deposit: ['wait', 'Waiting for deposit'], processing: ['run', 'In progress'], action_required: ['wait', 'Action needed'],
        paused: ['wait', 'Paused'], completed: ['ok', 'Completed'], refunded: ['ok', 'Refunded'], expired: ['bad', 'Expired'], failed: ['bad', 'Failed']
    };
    var STAGE_STEP = { confirming: 1, routing: 2, trading: 2, sending: 3, refunding: -1 };

    function stepIndex(view) {
        var cs = view.customer_state || {};
        if (cs.kind === 'awaiting_deposit') return view.deposit_observed ? 1 : 0;
        if (cs.kind === 'processing') return STAGE_STEP[cs.stage] !== undefined ? STAGE_STEP[cs.stage] : 1;
        if (cs.kind === 'completed') return 4;
        return -1;
    }

    function link(chainKey, hash) {
        var base = EXPLORERS[chainKey];
        var mono = 'font-family:ui-monospace,Menlo,monospace;font-size:12px';
        if (!base) return '<span style="' + mono + '">' + esc(shortHash(hash)) + '</span>';
        return '<a href="' + base + encodeURIComponent(hash) + '" target="_blank" rel="noopener" style="color:var(--orange);' + mono + '">' + esc(shortHash(hash)) + '</a>';
    }

    function render(view) {
        var cs = view.customer_state || { kind: view.order_status };
        var sym = view.deposit_symbol || view.from_symbol || '';
        var toSym = view.delivered_symbol || view.to_symbol || '';
        var depChain = chains[view.deposit_chain] || {};
        var fromXmr = view.deposit_chain === 'monero';

        $('swapOrderTitle').textContent = cs.kind === 'completed' ? 'Swap completed' : (cs.kind === 'awaiting_deposit' ? 'Send ' + (view.deposit_amount_human || '') + ' ' + sym : 'Swap ' + sym + ' → ' + toSym);
        var badge = BADGES[cs.kind] || ['', cs.kind || view.order_status || ''];
        $('swapOrderBadge').className = 'status-badge ' + badge[0];
        $('swapOrderBadge').textContent = badge[1];
        $('swapOrderSteps').children[3].textContent = 'Sending ' + toSym;

        var idx = stepIndex(view);
        var bad = cs.kind === 'failed' || cs.kind === 'expired' || cs.kind === 'refunded' || (cs.kind === 'processing' && cs.stage === 'refunding');
        Array.prototype.forEach.call($('swapOrderSteps').children, function(el) {
            var i = parseInt(el.dataset.step, 10);
            el.className = 'swap-step' + (bad ? (i <= 1 ? ' error' : '') : (i < idx ? ' done' : (i === idx ? ' active' : '')));
        });

        var depositVisible = cs.kind === 'awaiting_deposit' || (cs.kind === 'paused' && cs.reason === 'below_minimum');
        $('swapDepositBlock').style.display = depositVisible ? 'block' : 'none';
        if (depositVisible) {
            $('swapDepositAmount').value = (view.deposit_amount_human || '') + ' ' + sym;
            $('swapDepositAddress').value = view.deposit_address || '';
            $('swapDepositNetwork').textContent = depChain.name ? 'Network: ' + depChain.name : '';
            var forms = (view.deposit_address_forms || []).filter(function(f) { return f.address !== view.deposit_address; });
            $('swapDepositForms').innerHTML = forms.map(function(f) {
                return '<div class="help" style="justify-content:flex-start; gap:6px; word-break:break-all;"><span>' + esc(f.kind === 'shielded' ? 'Shielded address:' : 'Transparent address:') + '</span><span style="font-family:ui-monospace,Menlo,monospace">' + esc(f.address) + '</span></div>';
            }).join('');
            if (view.deposit_address && view.deposit_address !== lastQrAddress) {
                lastQrAddress = view.deposit_address;
                var qr = $('swapOrderQr');
                qr.innerHTML = '';
                try {
                    if (typeof QRCode !== 'undefined') new QRCode(qr, { text: view.deposit_address, width: 190, height: 190, colorDark: '#121417', colorLight: '#ffffff', correctLevel: (QRCode.CorrectLevel ? QRCode.CorrectLevel.M : 0) });
                } catch (e) {}
            }
            $('swapSendFromWalletBlock').style.display = (fromXmr && !view.read_only && activeSession && signedIn() && window.WalletState.spendkey && cs.kind === 'awaiting_deposit' && !view.deposit_observed) ? 'block' : 'none';
        }

        var notice = '', noticeClass = 'note', showClose = false, actionLabel = '', actionPrefill = '';
        pendingAction = null;
        var confTxt = (typeof view.confirmations === 'number' && view.required_confirmations) ? ' Confirmations: ' + view.confirmations + '/' + view.required_confirmations + '.' : '';
        var support = ' If you need help, contact support with your order id.';

        if (cs.kind === 'awaiting_deposit') {
            if (cs.notice && cs.notice.kind === 'below_expected') {
                noticeClass = 'note orange-note';
                notice = '<strong>We received less than expected</strong> (' + esc(view.observed_deposit_amount_human || '?') + ' ' + esc(sym) + '). Send the rest to the same address before the deadline, or continue with what arrived. The order continues automatically when the deadline passes.';
                showClose = true;
            } else if (cs.notice && cs.notice.kind === 'below_minimum') {
                noticeClass = 'note orange-note';
                notice = '<strong>Deposit below the minimum.</strong> At least ' + esc(view.minimum_deposit_human || '?') + ' ' + esc(sym) + ' is needed in total. Send the rest to the same address and the swap continues on its own.';
            } else if (view.deposit_observed) {
                notice = 'Your deposit was seen and is confirming.' + confTxt + ' You can close this page; your ' + esc(toSym) + ' arrives at the address you gave.';
            } else {
                notice = 'Send <strong>exactly ' + esc(view.deposit_amount_human || '') + ' ' + esc(sym) + '</strong>' + (depChain.name ? ' on ' + esc(depChain.name) : '') + ' to the address above in one payment, before the deadline. The swap starts as soon as the deposit is seen. If you send more, everything is swapped.';
            }
        } else if (cs.kind === 'processing') {
            var stageText = {
                confirming: 'Deposit received, waiting for network confirmations.' + confTxt,
                routing: 'Swapping your ' + sym + ' to ' + toSym + '.',
                trading: 'Swapping your ' + sym + ' to ' + toSym + '.',
                sending: 'Sending ' + toSym + ' to your address. It shows up within a few minutes.',
                refunding: 'The swap could not be completed. Your ' + sym + ' is being refunded.'
            }[cs.stage] || 'Your swap is in progress.' + confTxt;
            if (cs.notice && cs.notice.kind === 'checking') stageText += ' The deposit is being checked.';
            notice = esc(stageText) + ' You can leave this page; the swap continues on its own.';
        } else if (cs.kind === 'action_required') {
            noticeClass = 'note orange-note';
            if (cs.action === 'refund_address') {
                pendingAction = 'refund-address';
                var rr = view.refund_recovery || {};
                notice = '<strong>Refund: we need an address.</strong> ' + esc(rr.amount_human || '') + ' ' + esc(rr.asset_symbol || sym) + ' will be returned' + (rr.kind === 'wrong_chain' ? ' (the deposit arrived on an unexpected network)' : '') + '. Enter an address you control for that coin' + (chains[rr.chain] ? ' on ' + esc(chains[rr.chain].name) : '') + '. It can be set only once.';
                actionLabel = 'Refund address for ' + (rr.asset_symbol || sym);
                actionPrefill = rr.suggested_address || '';
            } else if (cs.action === 'payout_address') {
                pendingAction = 'payout-address';
                notice = '<strong>Payout needs a new address.</strong> The ' + esc(toSym) + ' could not be delivered to the original address. Enter a new ' + esc(toSym) + ' address to receive it.';
                actionLabel = toSym + ' address for the payout';
                actionPrefill = (view.to_chain === 'monero' && signedIn()) ? window.WalletState.address : '';
            } else {
                notice = 'This order is waiting for a decision that XmrNest does not support (' + esc(cs.action) + ').' + support;
            }
        } else if (cs.kind === 'paused') {
            noticeClass = 'note orange-note';
            notice = cs.reason === 'below_minimum'
                ? '<strong>Paused: deposit below the minimum.</strong>' + (view.minimum_deposit_human ? ' Top up to at least ' + esc(view.minimum_deposit_human) + ' ' + esc(sym) + ' at the same address and the swap continues.' : support)
                : '<strong>Paused.</strong> The swap could not be completed and a refund is being prepared. Keep this order open.';
        } else if (cs.kind === 'completed') {
            var got = view.actual_output_human || view.funded_expected_output_human || view.expected_output_human || '';
            notice = '<strong>Done.</strong> ' + esc(got) + ' ' + esc(toSym) + ' was sent to your address.' + (view.receiving_tx_hash && EXPLORERS[view.to_chain] ? ' <a href="' + EXPLORERS[view.to_chain] + encodeURIComponent(view.receiving_tx_hash) + '" target="_blank" rel="noopener" style="color:var(--orange)">View transaction</a>.' : '') + ' It appears once the network confirms it.';
        } else if (cs.kind === 'refunded') {
            notice = '<strong>Refunded.</strong> Your ' + esc(sym) + ' was returned' + (view.refund && view.refund.to_address ? ' to ' + esc(view.refund.to_address) : '') + '.';
        } else if (cs.kind === 'expired') {
            noticeClass = 'note orange-note';
            notice = '<strong>Expired.</strong> No deposit arrived before the deadline, so this order is closed. Do not send coins to the deposit address any more.' + (view.refund_recovery ? ' A refund of ' + esc(view.refund_recovery.amount_human || '') + ' ' + esc(view.refund_recovery.asset_symbol || sym) + ' is ' + (view.refund_recovery.phase === 'address_required' ? 'waiting for an address' : 'in progress') + '.' : ' If you sent coins late,' + support.replace(' If you need help,', ''));
        } else if (cs.kind === 'failed') {
            noticeClass = 'note orange-note';
            notice = '<strong>Failed.</strong> ' + esc(view.error_message || 'The swap could not be completed.') + (view.refund_recovery ? ' A refund of ' + esc(view.refund_recovery.amount_human || '') + ' ' + esc(view.refund_recovery.asset_symbol || sym) + ' is ' + (view.refund_recovery.phase === 'address_required' ? 'waiting for an address' : 'in progress') + '.' : support);
        } else {
            notice = 'Status: ' + esc(cs.kind || view.order_status);
        }
        if (view.read_only && (pendingAction || showClose)) {
            notice += ' <em>This view is read-only: open the swap from the browser or wallet that created it to act on it.</em>';
            pendingAction = null; showClose = false;
        }
        $('swapOrderNotice').className = noticeClass;
        $('swapOrderNotice').innerHTML = notice;
        $('swapCloseWaitBlock').style.display = showClose ? 'block' : 'none';
        $('swapActionBlock').style.display = pendingAction ? 'block' : 'none';
        if (pendingAction) {
            $('swapActionLabel').textContent = actionLabel;
            if (!$('swapActionAddress').value) $('swapActionAddress').value = actionPrefill;
        }

        var mono = 'font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all';
        var rows = [];
        rows.push(['You send', esc(view.observed_deposit_amount_human || view.deposit_amount_human || '') + ' ' + esc(sym) + (depChain.name ? ' <span class="muted">(' + esc(depChain.name) + ')</span>' : '')]);
        var get = view.actual_output_human ? view.actual_output_human + ' ' + toSym : ((view.funded_expected_output_human || view.expected_output_human) ? '≈ ' + (view.funded_expected_output_human || view.expected_output_human) + ' ' + toSym : '');
        rows.push([view.actual_output_human ? 'You received' : 'You get (estimate)', esc(get)]);
        rows.push(['To', '<span style="' + mono + '">' + esc(view.to_address || '') + '</span>']);
        if (view.deposit_tx_hash) rows.push(['Deposit tx', link(view.deposit_chain, view.deposit_tx_hash)]);
        if (view.receiving_tx_hash) rows.push(['Payout tx', link(view.to_chain, view.receiving_tx_hash)]);
        if (view.refund && view.refund.tx_hash) rows.push(['Refund tx', link(view.refund.chain || view.deposit_chain, view.refund.tx_hash)]);
        if (view.refund_address) rows.push(['Refund address', '<span style="' + mono + '">' + esc(view.refund_address) + '</span>']);
        rows.push(['Order id', '<span style="' + mono + '">' + esc(view.order_id) + '</span>']);
        if (view.created_at) rows.push(['Created', esc(new Date(view.created_at).toLocaleString())]);
        $('swapOrderDetails').innerHTML = rows.map(function(r) { return '<div class="summary-row"><span>' + r[0] + '</span><strong style="text-align:right">' + r[1] + '</strong></div>'; }).join('');
    }

    function startCountdown() {
        if (countdownTimer) clearInterval(countdownTimer);
        var el = $('swapOrderCountdown');
        var tick = function() {
            if (!activeOrder || !activeOrder.expires_at || (activeOrder.customer_state || {}).kind !== 'awaiting_deposit') { el.textContent = ''; return; }
            var diff = new Date(activeOrder.expires_at).getTime() - Date.now();
            if (diff <= 0) { el.textContent = 'Deadline passed'; return; }
            var m = Math.floor(diff / 60000), s = Math.floor((diff % 60000) / 1000);
            el.textContent = 'Send before: ' + m + 'm ' + (s < 10 ? '0' : '') + s + 's';
        };
        tick();
        countdownTimer = setInterval(tick, 1000);
    }

    /** XMR -> coin with a spendable wallet open: fill the Send page with the deposit details. */
    function sendFromWallet() {
        if (!activeOrder || !signedIn()) return;
        var addrEl = $('sendAddress'), amtEl = $('amount');
        if (!addrEl || !amtEl) return;
        if (window.UI.getAmountUnit && window.UI.getAmountUnit() === 'USD' && window.UI.toggleAmountUnit) window.UI.toggleAmountUnit();
        addrEl.value = activeOrder.deposit_address || '';
        amtEl.value = activeOrder.deposit_amount_human || '';
        try { amtEl.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
        if (window.UI.updateSummary) window.UI.updateSummary();
        window.UI.showPage('send');
        window.UI.notify('Deposit address and amount filled in. Check them, then press Send.');
    }

    /* ------------------------------------------------------------------ polling */

    function stopPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }
    function schedulePoll(ms) {
        stopPoll();
        if (document.hidden) return;
        pollTimer = setTimeout(pollOrder, ms);
    }

    var pollSeq = 0;
    async function pollOrder() {
        pollTimer = null;
        if (!activeOrder) return;
        var orderId = activeOrder.order_id;
        var seq = ++pollSeq;
        var res;
        try {
            res = await window.XMR_API.swapOrder(sid(), orderId, activeSession, activeSession ? '' : activeOrder.to_address);
        } catch (e) { res = null; }
        if (!activeOrder || activeOrder.order_id !== orderId) return;
        if (seq !== pollSeq) return; // a newer read is in flight or already applied
        if (!res || res.status !== 'OK') {
            pollDelay = (res && res.code === 'rate_limited' && res.retry_after) ? Math.min(POLL_MAX_MS, res.retry_after * 1000 + 1000) : Math.min(POLL_MAX_MS, pollDelay * 2);
            schedulePoll(pollDelay);
            return;
        }
        pollDelay = POLL_MS;
        var prevKind = (activeOrder.customer_state || {}).kind;
        var kind = (res.customer_state || {}).kind;
        activeOrder = res;
        render(res);
        patchLocal(orderId, { kind: kind, order_status: res.order_status });
        if (prevKind !== kind) renderHistory();
        if (res.terminal) {
            stopPoll();
            if (kind === 'completed' && prevKind !== 'completed') window.UI.notify('Swap completed.');
            return;
        }
        schedulePoll(POLL_MS);
    }

    async function openOrder(orderId, verifyAddress) {
        showError('');
        var local = localOrder(orderId);
        var swapSession = (local && local.swap_session) || '';
        var res = await window.XMR_API.swapOrder(sid(), orderId, swapSession, (!swapSession && !sid()) ? (verifyAddress || '') : (verifyAddress || ''));
        if (!res || res.status !== 'OK') { window.UI.notify((res && res.reason) || 'Could not load this swap'); return false; }
        if (!local && !res.read_only) rememberOrder({ order_id: orderId, swap_session: swapSession, created_at: res.created_at ? Date.parse(res.created_at) : Date.now(), from_symbol: res.from_symbol, to_symbol: res.to_symbol, from_chain: res.deposit_chain, to_chain: res.to_chain, deposit_amount_human: res.deposit_amount_human, expected_output_human: res.expected_output_human, kind: (res.customer_state || {}).kind, order_status: res.order_status, expires_at: res.expires_at });
        showOrder(res, swapSession);
        return true;
    }

    /* ------------------------------------------------------------------ actions */

    async function closeWait() {
        if (!activeOrder) return;
        var btn = $('swapCloseWait');
        btn.disabled = true;
        try {
            var res = await window.XMR_API.swapAction(sid(), activeOrder.order_id, activeSession, 'close-wait', '');
            if (res && res.status === 'OK') { window.UI.notify('Continuing with the amount received'); pollOrder(); }
            else window.UI.notify((res && res.reason) || 'Could not close the wait');
        } finally { btn.disabled = false; }
    }

    async function submitAction() {
        if (!activeOrder || !pendingAction) return;
        var addr = ($('swapActionAddress').value || '').trim();
        if (addr.length < 10) { window.UI.notify('Enter a valid address'); return; }
        var btn = $('swapActionSubmit');
        btn.disabled = true;
        try {
            var res = await window.XMR_API.swapAction(sid(), activeOrder.order_id, activeSession, pendingAction, addr);
            if (res && res.status === 'OK') { window.UI.notify('Address saved'); $('swapActionAddress').value = ''; pollOrder(); }
            else window.UI.notify((res && res.reason) || 'Could not save the address');
        } finally { btn.disabled = false; }
    }

    /* ------------------------------------------------------------------ history */

    async function renderHistory() {
        var list = loadLocal().slice();
        if (sid()) {
            try {
                var res = await window.XMR_API.swapOrders(sid());
                if (res && res.status === 'OK' && Array.isArray(res.orders)) {
                    res.orders.forEach(function(o) { if (!list.some(function(r) { return r.order_id === o.order_id; })) list.push(o); });
                }
            } catch (e) {}
        }
        list.sort(function(a, b) { return (b.created_at || 0) - (a.created_at || 0); });
        var el = $('swapHistoryList');
        if (!list.length) { el.innerHTML = '<div class="muted" style="font-size:13px;">No swaps yet.</div>'; return; }
        el.innerHTML = list.map(function(o) {
            var b = BADGES[o.kind] || BADGES[o.order_status] || ['', o.kind || o.order_status || ''];
            return '<div class="swap-history-row" data-order="' + esc(o.order_id) + '">' +
                '<div><strong>' + esc(o.deposit_amount_human || '') + ' ' + esc(o.from_symbol || '') + ' → ≈ ' + esc(o.expected_output_human || '') + ' ' + esc(o.to_symbol || 'XMR') + '</strong>' +
                '<div class="muted" style="font-size:12px">' + esc(o.created_at ? new Date(o.created_at).toLocaleString() : '') + ' · ' + esc(o.order_id) + '</div></div>' +
                '<span class="status-badge ' + b[0] + '">' + esc(b[1]) + '</span></div>';
        }).join('');
    }

    /* ------------------------------------------------------------------ wiring */

    function copyFrom(id) {
        var el = $(id);
        if (!el) return;
        var text = el.value || el.textContent || '';
        if (id === 'swapDepositAmount') text = text.split(' ')[0];
        try {
            navigator.clipboard.writeText(text).then(function() { window.UI.notify('Copied'); });
        } catch (e) {
            el.select && el.select();
            document.execCommand && document.execCommand('copy');
            window.UI.notify('Copied');
        }
    }

    function init() {
        if (!$('swapPayAmount')) return;
        $('swapPayAmount').addEventListener('input', function() {
            this.value = this.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
            quote = null;
            refreshGate();
            updatePayUsd();
            scheduleQuote();
        });
        // Logo fallback without inline handlers: image errors do not bubble, so capture them.
        document.addEventListener('error', function(ev) {
            var img = ev.target;
            if (!img || img.tagName !== 'IMG' || !img.dataset || !img.dataset.fallback) return;
            var span = document.createElement('span');
            span.className = 'coin-dot';
            span.textContent = img.dataset.fallback;
            img.replaceWith(span);
        }, true);
        $('swapFromBtn').addEventListener('click', function() { if (cfg && cfg.enabled) openPicker('from'); });
        $('swapToBtn').addEventListener('click', function() { if (cfg && cfg.enabled) openPicker('to'); });
        $('swapFlip').addEventListener('click', function() { if (cfg && cfg.enabled) flip(); });
        $('swapPickerClose').addEventListener('click', closePicker);
        $('swapPickerBack').addEventListener('click', function() { picker.coin = null; $('swapPickerSearch').value = ''; renderPicker(); });
        $('swapPickerSearch').addEventListener('input', renderPicker);
        $('swapPickerList').addEventListener('click', pickerClick);
        $('swapPicker').addEventListener('click', function(ev) { if (ev.target === $('swapPicker')) closePicker(); });
        document.addEventListener('keydown', function(ev) { if (ev.key === 'Escape') closePicker(); });

        $('swapRecipientAddress').addEventListener('input', function() { refreshGate(); if (validAddr(asset(toKey), this.value.trim())) scheduleQuote(); });
        $('swapRefundAddress').addEventListener('input', refreshGate);
        $('swapUseMyAddress').addEventListener('click', function() {
            if (!signedIn()) { window.UI.notify('Open or restore a wallet first'); return; }
            $('swapRecipientAddress').value = window.WalletState.address;
            refreshGate();
            scheduleQuote();
            window.UI.notify('Your wallet address was filled in');
        });
        $('swapRefundUseMine').addEventListener('click', function() {
            if (!signedIn()) { window.UI.notify('Open or restore a wallet first'); return; }
            $('swapRefundAddress').value = window.WalletState.address;
            refreshGate();
        });
        $('swapSubmit').addEventListener('click', createOrder);
        $('swapNewSwap').addEventListener('click', hideOrder);
        $('swapOrderRefresh').addEventListener('click', function() { if (activeOrder) pollOrder(); });
        $('swapCloseWait').addEventListener('click', closeWait);
        $('swapActionSubmit').addEventListener('click', submitAction);
        $('swapSendFromWallet').addEventListener('click', sendFromWallet);
        Array.prototype.forEach.call(document.querySelectorAll('#swapOrderCard [data-copy]'), function(b) {
            b.addEventListener('click', function() { copyFrom(b.dataset.copy); });
        });
        $('swapHistoryList').addEventListener('click', function(ev) {
            var row = ev.target.closest('.swap-history-row');
            if (row && row.dataset.order) openOrder(row.dataset.order, '');
        });
        $('swapFindBtn').addEventListener('click', async function() {
            var id = ($('swapFindId').value || '').trim(), addr = ($('swapFindAddress').value || '').trim();
            if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id)) { window.UI.notify('Enter the order id'); return; }
            if (await openOrder(id, addr)) { $('swapFindId').value = ''; $('swapFindAddress').value = ''; }
        });

        window.WalletState.on('walletChange', function() {
            renderSelection();
            refreshGate();
            renderHistory();
            if (activeOrder) render(activeOrder);
        });
        document.addEventListener('visibilitychange', function() {
            if (document.hidden) stopPoll();
            else if (activeOrder && !activeOrder.terminal) pollOrder();
        });

        loadConfig().then(renderHistory).catch(function(e) {
            console.warn('swap init failed', e);
            $('swapUnavailable').style.display = 'block';
            refreshGate();
        });
    }

    window.Swap = { init: init, openOrder: openOrder };
})(window);
