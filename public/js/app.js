/**
 * HYPE MINER — Telegram Mini App client
 */
(function () {
  'use strict';

  const API = '/api';
  let token = localStorage.getItem('hype_token') || null;
  let adminToken = localStorage.getItem('hype_admin_token') || null;
  // Full HQ power — only these Telegram IDs (owner)
  const OWNER_TELEGRAM_IDS = ['8990854464'];
  function isAppOwner(u) {
    const id = String((u && (u.telegramId || u.telegram_id)) || '');
    return OWNER_TELEGRAM_IDS.includes(id);
  }
  let user = null;
  let mineStatus = null;
  let cooldownTimer = null;
  let chartTf = '1h';
  let chartTimer = null;

  const tg = window.Telegram?.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor('#050810'); tg.setBackgroundColor('#050810'); } catch (_) {}
  }

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return document.querySelectorAll(sel); }

  function toast(msg, type = '') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show ' + type;
    setTimeout(() => el.classList.remove('show'), 3000);
  }

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (tg?.initData) headers['X-Telegram-Init-Data'] = tg.initData;
    const res = await fetch(API + path, {
      ...opts,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || 'Request failed');
    return data;
  }

  function setLoadingMessage(main, sub, showRetry) {
    const t = $('#loading-text') || $('#loading-screen .loading-text');
    const s = $('#loading-sub');
    const screen = $('#loading-screen');
    if (t) t.textContent = main || 'Initializing HYPE Miner…';
    if (s) s.textContent = sub || '';
    if (screen) {
      if (showRetry) screen.classList.add('show-retry');
      else screen.classList.remove('show-retry');
    }
  }

  async function authenticate() {
    // CRITICAL: always re-auth with Telegram when initData exists
    // so each Telegram user gets THEIR own profile (never reuse another user's JWT)
    if (tg?.initData) {
      try {
        const startParam =
          (tg.initDataUnsafe && tg.initDataUnsafe.start_param) ||
          null;
        const data = await api('/auth/telegram', {
          method: 'POST',
          body: { initData: tg.initData, startParam }
        });
        token = data.token;
        user = data.user;
        localStorage.setItem('hype_token', token);

        // Same phone / different Telegram account → HQ must not leak
        const tgId = String(user.telegramId || '');
        const prevTg = localStorage.getItem('hype_tg_id') || '';
        const adminTg = localStorage.getItem('hype_admin_tg') || '';
        if ((prevTg && prevTg !== tgId) || (adminToken && adminTg && adminTg !== tgId)) {
          adminToken = null;
          localStorage.removeItem('hype_admin_token');
          localStorage.removeItem('hype_admin_tg');
        }
        localStorage.setItem('hype_tg_id', tgId);
        return true;
      } catch (err) {
        setLoadingMessage('Login failed', err.message || 'Telegram auth error', true);
        return false;
      }
    }

    // No Telegram initData — try saved token only if it still works
    if (token) {
      try {
        const { user: u } = await api('/auth/me');
        user = u;
        return true;
      } catch (_) {
        token = null;
        localStorage.removeItem('hype_token');
      }
    }

    try {
      let clientId = localStorage.getItem('hype_client_id');
      if (!clientId) {
        clientId = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('hype_client_id', clientId);
      }
      const data = await api('/auth/session', { method: 'POST', body: { name: 'Miner', clientId } });
      token = data.token;
      user = data.user;
      localStorage.setItem('hype_token', token);
      return true;
    } catch (err) {
      const msg = (err && err.message) || '';
      if (msg.includes('Telegram') || msg.includes('403') || msg.includes('Open HYPE')) {
        setLoadingMessage(
          'Open from Telegram',
          'This app only works inside Telegram. Open the bot link and launch HYPE Miner from there.',
          true
        );
      } else {
        setLoadingMessage(
          'Connection error',
          msg || 'Cannot reach server. Check network and try again.',
          true
        );
      }
      return false;
    }
  }

  function updateHeader() {
    if (!user) return;
    const name = user.firstName || user.username || 'Miner';
    $('#header-username').textContent = name;
    $('#header-level').textContent = 'Lvl ' + (user.minerLevel || 1);
    const av = $('#user-avatar');
    if (user.photoUrl) av.innerHTML = `<img src="${user.photoUrl}" alt="" />`;
    else av.textContent = (name[0] || 'H').toUpperCase();
  }

  function updateMineUI(status) {
    mineStatus = status;
    const bal = status.balance;
    const hold = status.holdingBalance;
    $('#balance').textContent = bal.toFixed(4);
    $('#holding').textContent = hold.toFixed(4) + ' HYPE';
    $('#mine-reward').textContent = '+' + status.settings.rate.toFixed(4);
    $('#tier-level').textContent = 'Level ' + status.minerLevel + ' / 1000';
    if ($('#mine-level')) $('#mine-level').textContent = status.minerLevel;
    if ($('#mine-level-text')) $('#mine-level-text').textContent = status.minerLevel;
    $('#energy-text').textContent = status.energy + ' / ' + status.maxEnergy;
    $('#energy-fill').style.width = Math.min(100, (status.energy / status.maxEnergy) * 100) + '%';
    $('#today-pnl').textContent = '+' + (status.dailyMined * status.settings.rate || 0).toFixed(4) + ' HYPE';
    // approx USD if market price available later
    const px = window.__hypePrice;
    if (px && $('#usd-approx')) {
      $('#usd-approx').textContent = '≈ $' + (bal * px).toFixed(4) + ' USD';
    }

    const btn = $('#mine-btn');
    if (status.canMine) {
      btn.disabled = false;
      $('#cooldown').textContent = 'Ready';
    } else {
      btn.disabled = true;
      if (status.cooldownRemaining > 0) {
        $('#cooldown').textContent = status.cooldownRemaining + 's';
        startCooldown(status.cooldownRemaining);
      } else if (status.energy < status.settings.energyCost) {
        $('#cooldown').textContent = 'Low energy';
      } else {
        $('#cooldown').textContent = 'Daily limit';
      }
    }
    $('#claim-holding-btn').style.display = hold > 0.01 ? 'block' : 'none';
  }

  function startCooldown(seconds) {
    if (cooldownTimer) clearInterval(cooldownTimer);
    let left = seconds;
    cooldownTimer = setInterval(() => {
      left--;
      if (left <= 0) {
        clearInterval(cooldownTimer);
        loadMineStatus();
      } else $('#cooldown').textContent = left + 's';
    }, 1000);
  }

  function showPage(name) {
    if (!name) return;
    // Alias
    if (name === 'friends') name = 'squad';
    try {
      $$('.page').forEach(p => p.classList.remove('active'));
      $$('.nav-item').forEach(n => n.classList.remove('active'));
      const page = $('#page-' + name);
      if (page) {
        page.classList.add('active');
        // scroll content to top so Friends is visible
        const main = $('#pages');
        if (main) main.scrollTop = 0;
      } else {
        console.warn('Page not found:', name);
        return;
      }
      const nav = document.querySelector('.nav-item[data-page="' + name + '"]');
      if (nav) nav.classList.add('active');
      if (name === 'tasks') loadTasks();
      if (name === 'squad') loadSquad();
      if (name === 'leaderboard') loadLeaderboard();
      if (name === 'market') loadMarket();
      if (name === 'profile') loadProfile();
      if (name === 'mine') loadMineStatus();
      if (name === 'admin') refreshAdminUI();
    } catch (err) {
      console.error('showPage', name, err);
      toast((err && err.message) || 'Page error', 'error');
    }
  }

  async function loadMineStatus() {
    try {
      const status = await api('/mine/status');
      updateMineUI(status);
      if (user) {
        user.balance = status.balance;
        user.holdingBalance = status.holdingBalance;
        user.minerLevel = status.minerLevel;
      }
    } catch (err) { toast(err.message, 'error'); }
  }

  async function doMine() {
    const btn = $('#mine-btn');
    if (btn.disabled) return;
    btn.classList.add('tapped');
    setTimeout(() => btn.classList.remove('tapped'), 180);
    try {
      const result = await api('/mine/tap', { method: 'POST' });
      toast('+' + result.reward.toFixed(4) + ' HYPE', 'success');
      if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred('medium');
      await loadMineStatus();
    } catch (err) {
      toast(err.message, 'error');
      await loadMineStatus();
    }
  }

  async function claimHolding() {
    try {
      const r = await api('/mine/claim-holding', { method: 'POST' });
      toast('Unlocked ' + r.unlocked + ' HYPE', 'success');
      await loadMineStatus();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function loadTasks() {
    const list = $('#tasks-list');
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    try {
      const { tasks } = await api('/tasks');
      if (!tasks.length) {
        list.innerHTML = '<div class="empty-state">No tasks available</div>';
        return;
      }
      list.innerHTML = tasks.map(t => {
        let action = '';
        if (t.status === 'claimed') action = '<button class="btn secondary" disabled>Done</button>';
        else if (t.status === 'completed') action = `<button class="btn primary" data-claim="${t.id}">Claim</button>`;
        else action = `<button class="btn primary" data-complete="${t.id}">Go</button>`;
        // Show exactly the name admin wrote — no extra description clutter
        const name = t.title || 'Task';
        return `<div class="task-item">
          <div class="task-icon">✓</div>
          <div class="task-body"><h4>${esc(name)}</h4>
          <div class="task-reward">+${t.reward} HYPE</div></div>
          <div class="task-action">${action}</div></div>`;
      }).join('');
      list.querySelectorAll('[data-complete]').forEach(b => b.addEventListener('click', () => completeTask(b.dataset.complete)));
      list.querySelectorAll('[data-claim]').forEach(b => b.addEventListener('click', () => claimTask(b.dataset.claim)));
    } catch (err) {
      list.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
    }
  }

  async function completeTask(id) {
    try {
      const { tasks } = await api('/tasks');
      const task = tasks.find(t => String(t.id) === String(id));
      if (task?.targetUrl) {
        const url = task.targetUrl;
        const isTg = /t\.me\//i.test(url) || url.startsWith('tg://');
        if (isTg && tg?.openTelegramLink) tg.openTelegramLink(url);
        else if (tg?.openLink) tg.openLink(url);
        else window.open(url, '_blank');
      }
      await api('/tasks/' + id + '/complete', { method: 'POST' });
      toast('Task complete — claim reward', 'success');
      loadTasks();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function claimTask(id) {
    try {
      const r = await api('/tasks/' + id + '/claim', { method: 'POST' });
      toast('+' + r.reward + ' HYPE', 'success');
      loadTasks();
      loadMineStatus();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function loadSquad() {
    try {
      const data = await api('/referral');
      const count = data.friendsCount != null ? data.friendsCount : (data.friends || []).length;
      if ($('#friends-count')) $('#friends-count').textContent = String(count);
      const bonus = data.bonusPerInvite != null ? data.bonusPerInvite : 25;
      const pct = data.commissionPct != null ? data.commissionPct : 5;
      if ($('#bonus-amount')) $('#bonus-amount').textContent = '+' + bonus;
      if ($('#commission-pct')) $('#commission-pct').textContent = pct + '%';
      // Red-circle block: always mirrors HQ settings
      if ($('#info-bonus-label')) $('#info-bonus-label').textContent = '+' + bonus + ' HYPE / friend';
      if ($('#info-commission-label')) $('#info-commission-label').textContent = pct + '% of squad mining';
      if ($('#how-invite-text')) {
        $('#how-invite-text').innerHTML =
          '<strong>Invite bonus</strong> — Share your link. When a friend joins, <strong>+' + bonus +
          ' HYPE</strong> goes to holding. Holding unlocks over time.';
      }
      if ($('#how-team-text')) {
        $('#how-team-text').innerHTML =
          '<strong>Team mining share</strong> — You receive <strong>' + pct +
          '%</strong> of every HYPE your squad mines into holding.';
      }
      if ($('#invite-link')) $('#invite-link').value = data.inviteLink || '';
      if ($('#channel-button-link')) {
        $('#channel-button-link').value = data.channelButtonUrl || data.inviteLink || '';
      }
      window.__hypeShareText = data.shareText || '';
      if ($('#squad-miners')) $('#squad-miners').textContent = count + ' miners';
      const list = $('#squad-list');
      if (!list) return;
      const friends = Array.isArray(data.friends) ? data.friends : [];
      if (!friends.length) {
        list.innerHTML = '<div class="empty-state">No friends yet. Share your link!</div>';
      } else {
        list.innerHTML = friends.map(f => {
          const name = esc(f.firstName || f.username || 'Miner');
          const lvl = f.level != null ? f.level : 1;
          const comm = f.commissionEarned != null ? f.commissionEarned : 0;
          return '<div class="squad-member"><span>' + name + ' · Lvl ' + lvl + '</span>' +
            '<span style="color:var(--cyan)">+' + comm + '</span></div>';
        }).join('');
      }
    } catch (err) {
      console.error('loadSquad', err);
      const list = $('#squad-list');
      if (list) list.innerHTML = '<div class="empty-state">' + esc(err.message || 'Could not load friends') + '</div>';
      toast(err.message || 'Friends load failed', 'error');
    }
  }


  async function loadLeaderboard() {
    const list = $('#leaderboard-list');
    if (list) list.innerHTML = '<div class="empty-state">Loading…</div>';
    try {
      const data = await api('/leaderboard');
      const leaders = Array.isArray(data.leaders) ? data.leaders : [];
      if ($('#lb-total')) $('#lb-total').textContent = (data.totalPlayers || leaders.length) + ' players';

      const me = data.myEntry;
      if (me) {
        if ($('#lb-my-rank')) $('#lb-my-rank').textContent = me.rank != null ? '#' + me.rank : '—';
        const nm = me.firstName || me.username || 'You';
        if ($('#lb-my-name')) $('#lb-my-name').textContent = nm + (me.isMe ? ' (you)' : '');
        if ($('#lb-my-meta')) $('#lb-my-meta').textContent = 'Lvl ' + (me.level || 1);
        if ($('#lb-my-hype')) $('#lb-my-hype').textContent = Number(me.totalMined || 0).toFixed(2);
      }

      if (!list) return;
      if (!leaders.length) {
        list.innerHTML = '<div class="empty-state">No miners yet — start mining!</div>';
        return;
      }
      list.innerHTML = leaders.map(u => {
        const name = esc(u.firstName || u.username || 'Miner');
        const medal = u.rank === 1 ? '🥇' : u.rank === 2 ? '🥈' : u.rank === 3 ? '🥉' : '#' + u.rank;
        const meClass = u.isMe ? ' lb-me' : '';
        return '<div class="lb-row' + meClass + '">' +
          '<span class="lb-rank">' + medal + '</span>' +
          '<div class="lb-info"><strong>' + name + '</strong>' +
          '<span class="muted small">Lvl ' + (u.level || 1) + '</span></div>' +
          '<div class="lb-hype"><img src="/assets/hype-coin.png" alt="" class="token-logo-xs" /> ' +
          Number(u.totalMined || 0).toFixed(2) + '</div></div>';
      }).join('');
    } catch (err) {
      console.error('loadLeaderboard', err);
      if (list) list.innerHTML = '<div class="empty-state">' + esc(err.message || 'Failed') + '</div>';
      toast(err.message || 'Leaderboard failed', 'error');
    }
  }

  /** Live-looking HYPE chart (visual). Uses API price when available. */
  function drawChart(seedPrice) {
    const canvas = $('#hype-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 360;
    const h = 160;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const points = 48;
    const base = seedPrice || 0.024;
    const data = [];
    let v = base * (0.92 + Math.random() * 0.08);
    const t = Date.now() / 1000;
    for (let i = 0; i < points; i++) {
      const wave = Math.sin((i + t / 8) * 0.35) * 0.0015 + Math.sin((i + t / 5) * 0.12) * 0.001;
      v = Math.max(0.01, v + wave + (Math.random() - 0.48) * 0.0008);
      data.push(v);
    }
    const min = Math.min(...data) * 0.995;
    const max = Math.max(...data) * 1.005;
    const range = max - min || 0.001;

    // grid
    ctx.strokeStyle = 'rgba(0,232,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 4; i++) {
      const y = (h / 4) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    // area fill
    const path = new Path2D();
    data.forEach((p, i) => {
      const x = (i / (points - 1)) * w;
      const y = h - ((p - min) / range) * (h - 16) - 8;
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    });
    const lastX = w;
    const lastY = h - ((data[data.length - 1] - min) / range) * (h - 16) - 8;
    ctx.beginPath();
    data.forEach((p, i) => {
      const x = (i / (points - 1)) * w;
      const y = h - ((p - min) / range) * (h - 16) - 8;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(lastX, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(0,232,255,0.28)');
    grad.addColorStop(1, 'rgba(0,232,255,0.01)');
    ctx.fillStyle = grad;
    ctx.fill();

    // line
    ctx.beginPath();
    data.forEach((p, i) => {
      const x = (i / (points - 1)) * w;
      const y = h - ((p - min) / range) * (h - 16) - 8;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#00e8ff';
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // end dot
    ctx.beginPath();
    ctx.arc(lastX - 2, lastY, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#00e8ff';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,232,255,0.4)';
    ctx.lineWidth = 6;
    ctx.stroke();

    return data[data.length - 1];
  }

  async function loadMarket() {
    try {
      const data = await api('/market');
      const n = data.network || {};
      let price = data.price != null ? Number(data.price) : null;
      // visual live price derived from pool activity when no external feed
      if (price == null) {
        const base = 0.022 + Math.min(0.02, (n.minedPercent || 0) / 5000);
        price = base;
      }
      window.__hypePrice = price;
      const change = data.change24h != null ? data.change24h : (Math.random() * 4 - 1).toFixed(2);
      const high = (price * 1.04).toFixed(4);
      const low = (price * 0.92).toFixed(4);
      const cap = data.marketCap != null ? data.marketCap : Math.round((n.targetCap || 2e6) * price);
      const vol = data.volume24h != null ? data.volume24h : Math.round(cap * 0.2);

      if ($('#m-price')) {
        $('#m-price').innerHTML = '$' + price.toFixed(4) +
          ' <span style="color:var(--green);font-size:12px">+' + change + '%</span>';
      }
      if ($('#m-cap')) $('#m-cap').textContent = '$' + Number(cap).toLocaleString();
      if ($('#m-vol')) $('#m-vol').textContent = '$' + Number(vol).toLocaleString();
      if ($('#m-hl')) $('#m-hl').innerHTML = '$' + high + ' / <span style="color:#ff6b6b">$' + low + '</span>';

      if ($('#pool-mini')) {
        $('#pool-mini').textContent =
          'Pool ' + (n.minedPercent || 0).toFixed(2) + '% mined · ' +
          Number(n.totalMined || 0).toLocaleString() + ' HYPE · ' +
          (n.activeMiners || 0) + ' miners';
      }

      drawChart(price);
      if (chartTimer) clearInterval(chartTimer);
      chartTimer = setInterval(() => drawChart(window.__hypePrice || price), 2500);
    } catch (err) {
      if ($('#pool-mini')) $('#pool-mini').textContent = err.message;
    }
  }

  async function loadProfile() {
    try {
      const data = await api('/profile');
      const u = data.user;
      user = u;
      updateHeader();
      const name = u.firstName || u.username || 'Miner';
      $('#profile-name').textContent = name;
      $('#profile-id').textContent = '@' + (u.username || 'miner') + ' · ID ' + u.telegramId;
      $('#profile-balance').textContent = u.balance.toFixed(4);
      if ($('#profile-holding')) $('#profile-holding').textContent = (u.holdingBalance || 0).toFixed(4) + ' HYPE';
      $('#profile-total').textContent = u.totalMined.toFixed(4);
      if ($('#mine-level')) $('#mine-level').textContent = u.minerLevel;
      if ($('#mine-level-text')) $('#mine-level-text').textContent = u.minerLevel;
      const av = $('#profile-avatar');
      if (u.photoUrl) av.innerHTML = `<img src="${u.photoUrl}" alt="" />`;
      else av.textContent = (name[0] || 'H').toUpperCase();

      updateWalletButtons(u.walletAddress);

      if ($('#verify-label')) {
        if (u.isVerified) {
          $('#verify-label').textContent = 'VERIFIED';
          $('#verify-label').style.color = 'var(--green)';
        } else {
          $('#verify-label').textContent = 'NOT VERIFIED';
          $('#verify-label').style.color = '';
        }
      }

      try {
        const w = await api('/wallet/overview');
        const b = w.balances || {};
        if ($('#bal-hype')) $('#bal-hype').textContent = b.hype;
        if ($('#bal-ton')) $('#bal-ton').textContent = b.ton;
        if ($('#bal-gram')) $('#bal-gram').textContent = b.gram;
        if ($('#bal-usdt')) $('#bal-usdt').textContent = b.usdtCredited;

        // TON treasury — 0.1 TON verification
        const tv = w.tonVerify || {};
        if ($('#ton-treasury-address')) $('#ton-treasury-address').value = tv.address || '';
        if ($('#ton-verify-amt')) {
          $('#ton-verify-amt').textContent = (tv.amount != null ? tv.amount : 0.1) + ' TON';
        }
        if ($('#ton-verify-status')) {
          if (w.isVerified || u.isVerified) {
            $('#ton-verify-status').textContent = 'Verified ✓';
          } else if (!tv.address) {
            $('#ton-verify-status').textContent = 'TON treasury not set by admin yet';
          } else if (!u.walletAddress) {
            $('#ton-verify-status').textContent = 'Connect wallet first, then pay 0.1 TON';
          } else {
            $('#ton-verify-status').textContent = 'Send 0.1 TON to treasury, paste TX, wait for admin confirm';
          }
        }

        // USDT treasury — 0.5 USDT unlock withdrawals
        if ($('#dep-min')) $('#dep-min').textContent = w.minUsdtDeposit;
        if ($('#deposit-address')) $('#deposit-address').value = w.deposit?.address || '';
        if ($('#deposit-network')) {
          $('#deposit-network').textContent =
            'Network: ' + (w.deposit?.network || 'BEP20') + ' · USDT Treasury';
        }
        if ($('#deposit-amount-hint') && w.minUsdtDeposit != null) {
          $('#deposit-amount-hint').innerHTML =
            'Amount: <strong>' + w.minUsdtDeposit + ' USDT</strong> only';
        }
        if ($('#unlock-status')) {
          $('#unlock-status').textContent = w.withdrawUnlocked
            ? 'Withdrawals unlocked ✓'
            : 'Pay ' + w.minUsdtDeposit + ' USDT to USDT treasury after swap, then submit TX';
        }

        // Withdraw gate notice
        const gate = $('#withdraw-gate-msg');
        if (gate) {
          if (!u.walletAddress) {
            gate.textContent = '⚠ Connect your wallet first.';
          } else if (!(w.isVerified || u.isVerified)) {
            gate.textContent = '⚠ Pay 0.1 TON to verify account, then wait for admin confirm.';
          } else if (!w.withdrawUnlocked) {
            gate.textContent = '⚠ Pay ' + (w.minUsdtDeposit || 0.5) + ' USDT to unlock withdrawals, then wait for admin confirm.';
          } else if (!w.withdrawalsEnabled) {
            gate.textContent = '⏳ Withdrawal window closed. Admin will open it soon.';
          } else {
            gate.textContent = '✓ You can request withdrawal. Admin will mark it Successfully Paid after transfer.';
          }
        }
      } catch (_) {}

      // Recent withdrawals status for user
      try {
        const hist = await api('/wallet/history');
        const list = hist.withdrawals || [];
        const last = Array.isArray(list) ? list[0] : null;
        const wr = $('#withdraw-result');
        if (wr && last) {
          if (last.status === 'completed') {
            wr.textContent = 'Last withdrawal: Successfully Paid ✓';
            wr.style.color = 'var(--green)';
          } else if (last.status === 'pending' || last.status === 'processing') {
            wr.textContent = 'Last withdrawal: Pending admin payment…';
            wr.style.color = '';
          } else if (last.status === 'rejected') {
            wr.textContent = 'Last withdrawal: Rejected (refunded)';
            wr.style.color = '#ff8a80';
          }
        }
      } catch (_) {}

      try {
        const rates = await api('/swap/rates');
        if ($('#swap-rates')) {
          $('#swap-rates').textContent =
            '1 HYPE = ' + rates.hypeToTon + ' TON · ' + rates.hypeToGram + ' HYPE GRAM';
        }
      } catch (_) {}
    } catch (err) { toast(err.message, 'error'); }
  }

  function updateWalletButtons(walletAddress) {
    const connectBtn = $('#connect-wallet-btn');
    const discBtn = $('#disconnect-wallet-btn');
    const hint = $('#wallet-options-hint');
    const jump = $('#btn-connect-wallet-jump');
    if (walletAddress) {
      const short = walletAddress.slice(0, 6) + '…' + walletAddress.slice(-4);
      if ($('#wallet-status')) $('#wallet-status').textContent = 'Connected: ' + short;
      // Profile: only Disconnect (no Connect)
      if (connectBtn) connectBtn.classList.add('hidden');
      if (discBtn) {
        discBtn.classList.remove('hidden');
        discBtn.innerHTML = '<img src="/assets/ton.svg" alt="" class="btn-logo" /> DISCONNECT WALLET';
      }
      if (hint) hint.textContent = 'Connected · ' + short;
      // Mine top button: shows Disconnect (tap to disconnect)
      if (jump) {
        jump.innerHTML = '<img src="/assets/ton.svg" alt="" class="token-logo-xs" style="margin-right:4px" /> Disconnect';
        jump.classList.add('connected');
        jump.dataset.walletState = 'connected';
      }
    } else {
      if ($('#wallet-status')) $('#wallet-status').textContent = 'Wallet not connected';
      // Profile: only Connect
      if (connectBtn) {
        connectBtn.classList.remove('hidden');
        connectBtn.innerHTML = '<img src="/assets/ton.svg" alt="" class="btn-logo" /> CONNECT WALLET';
      }
      if (discBtn) discBtn.classList.add('hidden');
      if (hint) hint.textContent = 'Tonkeeper · Telegram Wallet · MyTonWallet';
      if (jump) {
        jump.innerHTML = '<img src="/assets/ton.svg" alt="" class="token-logo-xs" style="margin-right:4px" /> Connect Wallet';
        jump.classList.remove('connected');
        jump.dataset.walletState = 'disconnected';
      }
    }
  }

  function saveWalletAddress(address) {
    const trimmed = (address || '').trim();
    if (!trimmed) return;
    // Accept TonConnect raw (0:hex) and user-friendly EQ/UQ
    if (!trimmed.startsWith('EQ') && !trimmed.startsWith('UQ') &&
        !trimmed.startsWith('eq') && !trimmed.startsWith('uq') &&
        !trimmed.startsWith('0:')) {
      return toast('Invalid TON wallet address', 'error');
    }
    api('/wallet/address', { method: 'POST', body: { address: trimmed } })
      .then(() => {
        toast('Wallet connected ✓', 'success');
        if (user) user.walletAddress = trimmed;
        updateWalletButtons(trimmed);
        loadProfile();
        loadMineStatus();
      })
      .catch(err => toast(err.message, 'error'));
  }

  async function disconnectWallet() {
    try {
      // Disconnect TonConnect session if any
      if (tonConnectUI && tonConnectUI.connected) {
        try { await tonConnectUI.disconnect(); } catch (_) {}
      }
      await api('/wallet/address', { method: 'POST', body: { address: '', disconnect: true } });
      toast('Wallet disconnected', 'success');
      if (user) user.walletAddress = null;
      updateWalletButtons(null);
      loadProfile();
    } catch (err) {
      // Fallback: clear locally if API rejects empty
      try {
        await api('/wallet/disconnect', { method: 'POST', body: {} });
        toast('Wallet disconnected', 'success');
        if (user) user.walletAddress = null;
        updateWalletButtons(null);
        loadProfile();
      } catch (e2) {
        toast(err.message || e2.message, 'error');
      }
    }
  }

  let tonConnectUI = null;
  let tonConnectReady = false;
  let savingWallet = false;

  function initTonConnect() {
    if (tonConnectReady && tonConnectUI) return tonConnectUI;
    try {
      const TonConnectUI = window.TON_CONNECT_UI?.TonConnectUI || window.TonConnectUI;
      if (!TonConnectUI) {
        console.warn('TonConnect UI library not loaded');
        return null;
      }
      const manifestUrl = window.location.origin + '/tonconnect-manifest.json';
      tonConnectUI = new TonConnectUI({
        manifestUrl,
        uiPreferences: { theme: 'DARK' }
      });
      tonConnectUI.onStatusChange((wallet) => {
        if (wallet && wallet.account && wallet.account.address && !savingWallet) {
          savingWallet = true;
          saveWalletAddress(wallet.account.address);
          setTimeout(() => { savingWallet = false; }, 2000);
        }
      });
      tonConnectReady = true;
      return tonConnectUI;
    } catch (err) {
      console.warn('TonConnect init failed', err);
      return null;
    }
  }

  async function connectWallet() {
    // Official TON Connect only — no paste address (like Mining GRAM / other apps)
    const ui = initTonConnect();
    if (!ui) {
      toast('Wallet connect loading… try again in a second', 'error');
      // Retry after CDN script may still be loading
      setTimeout(() => {
        const retry = initTonConnect();
        if (retry) retry.openModal().catch(() => toast('Could not open wallet list', 'error'));
        else toast('Check internet and reopen app', 'error');
      }, 1200);
      return;
    }
    try {
      toast('Opening wallets…', 'success');
      await ui.openModal();
    } catch (err) {
      console.warn('TonConnect openModal', err);
      toast('Could not open TON Connect. Try again.', 'error');
    }
  }

  function requestWithdraw() {
    const amount = parseFloat($('#withdraw-amount')?.value || 0);
    const asset = $('#withdraw-asset')?.value || 'TON';
    if (!amount) return toast('Enter amount', 'error');
    api('/wallet/withdraw', { method: 'POST', body: { amount, asset } })
      .then(data => {
        toast(data.message || 'Withdrawal submitted — wait for Successfully Paid', 'success');
        const wr = $('#withdraw-result');
        if (wr) {
          wr.textContent = 'Request sent. Admin will mark Successfully Paid after transfer.';
          wr.style.color = '';
        }
        loadProfile();
      })
      .catch(err => {
        toast(err.message, 'error');
        const wr = $('#withdraw-result');
        if (wr) wr.textContent = err.message;
      });
  }

  async function doSwap(to) {
    const amount = parseFloat($('#swap-amount')?.value || 0);
    if (!amount) return toast('Enter HYPE amount', 'error');
    try {
      const r = await api('/swap', { method: 'POST', body: { amount, to } });
      toast('Swapped ' + r.swapped + ' → ' + r.received + ' ' + r.asset, 'success');
      loadProfile();
      loadMineStatus();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function submitDeposit() {
    const txHash = ($('#deposit-tx')?.value || '').trim();
    if (!txHash) return toast('Enter USDT transaction hash', 'error');
    try {
      const r = await api('/wallet/deposit', { method: 'POST', body: { txHash } });
      toast(r.message || 'USDT deposit submitted', 'success');
      loadProfile();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function submitTonVerify() {
    const txHash = ($('#ton-verify-tx')?.value || '').trim();
    if (!txHash) return toast('Enter TON transaction hash', 'error');
    try {
      const r = await api('/wallet/verify-ton', { method: 'POST', body: { txHash } });
      toast(r.message || 'TON verification submitted', 'success');
      loadProfile();
    } catch (err) { toast(err.message, 'error'); }
  }

  function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function bindEvents() {
    // Event delegation — more reliable on Telegram WebView
    const nav = document.querySelector('.bottom-nav');
    if (nav) {
      nav.addEventListener('click', (e) => {
        const btn = e.target.closest('.nav-item');
        if (!btn) return;
        e.preventDefault();
        const name = btn.getAttribute('data-page');
        if (name) showPage(name);
      });
    }
    $$('.nav-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const name = btn.getAttribute('data-page') || btn.dataset.page;
        if (name) showPage(name);
      });
    });
    const mineBtn = $('#mine-btn');
    if (mineBtn) mineBtn.addEventListener('click', doMine);
    const claimBtn = $('#claim-holding-btn');
    if (claimBtn) claimBtn.addEventListener('click', claimHolding);
    const copyLink = $('#copy-link');
    if (copyLink) copyLink.addEventListener('click', () => {
      const v = $('#invite-link')?.value || '';
      if (v) navigator.clipboard?.writeText(v).then(() => toast('Link copied', 'success'));
      else toast('Link not ready', 'error');
    });
    const shareLink = $('#share-link');
    if (shareLink) shareLink.addEventListener('click', () => {
      const link = $('#invite-link')?.value || '';
      const text = window.__hypeShareText || ('Join HYPE Miner\n' + link);
      if (tg?.openTelegramLink) {
        tg.openTelegramLink(
          'https://t.me/share/url?url=' + encodeURIComponent(link) +
          '&text=' + encodeURIComponent(text)
        );
      } else if (navigator.share) {
        navigator.share({ title: 'HYPE Miner', text, url: link }).catch(() => {});
      } else if (link) {
        navigator.clipboard?.writeText(text).then(() => toast('Share text copied', 'success'));
      }
    });
    const copyCh = $('#copy-channel-btn');
    if (copyCh) copyCh.addEventListener('click', () => {
      const v = $('#channel-button-link')?.value || $('#invite-link')?.value || '';
      if (v) navigator.clipboard?.writeText(v).then(() => toast('Channel button link copied', 'success'));
      else toast('Link not ready', 'error');
    });
    const cwb = $('#connect-wallet-btn');
    if (cwb) cwb.addEventListener('click', connectWallet);
    const disc = $('#disconnect-wallet-btn');
    if (disc) disc.addEventListener('click', disconnectWallet);
    const wdb = $('#withdraw-btn');
    if (wdb) wdb.addEventListener('click', requestWithdraw);
    const st = $('#swap-ton-btn'); if (st) st.addEventListener('click', () => doSwap('TON'));
    const sg = $('#swap-gram-btn'); if (sg) sg.addEventListener('click', () => doSwap('GRAM'));
    const sd = $('#submit-deposit-btn'); if (sd) sd.addEventListener('click', submitDeposit);
    const stv = $('#submit-ton-verify-btn'); if (stv) stv.addEventListener('click', submitTonVerify);
    const cd = $('#copy-deposit');
    if (cd) cd.addEventListener('click', () => {
      const v = $('#deposit-address')?.value;
      if (v) navigator.clipboard?.writeText(v).then(() => toast('USDT treasury copied', 'success'));
      else toast('USDT treasury not set by admin yet', 'error');
    });
    const ct = $('#copy-ton-treasury');
    if (ct) ct.addEventListener('click', () => {
      const v = $('#ton-treasury-address')?.value;
      if (v) navigator.clipboard?.writeText(v).then(() => toast('TON treasury copied', 'success'));
      else toast('TON treasury not set by admin yet', 'error');
    });
    const jc = $('#btn-connect-wallet-jump');
    if (jc) jc.addEventListener('click', () => {
      // Connected → Disconnect; otherwise open TON Connect
      const addr = user && user.walletAddress;
      if (addr || jc.dataset.walletState === 'connected') {
        disconnectWallet();
      } else {
        connectWallet();
      }
    });
    const jw = $('#btn-withdraw-jump');
    if (jw) jw.addEventListener('click', () => showPage('profile'));

    $$('#tf-row button').forEach(b => {
      b.addEventListener('click', () => {
        $$('#tf-row button').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        chartTf = b.dataset.tf;
        drawChart(window.__hypePrice);
      });
    });

    // In-app Admin HQ
    const openAdmin = $('#btn-open-admin');
    // openAdmin handled below (owner-only)
    // HQ entry only for owner Telegram 8990854464
    if (openAdmin) {
      if (isAppOwner(user) || adminToken) openAdmin.classList.remove('hidden');
      else openAdmin.classList.add('hidden');
    }
    // Owner: single long path — open HQ directly from Staff button / auto nav
    if (openAdmin) openAdmin.addEventListener('click', () => {
      if (!isAppOwner(user)) {
        toast('HQ only for owner', 'error');
        return;
      }
      showPage('admin');
    });
    const adminLoginBtn = $('#admin-login-btn');
    if (adminLoginBtn) adminLoginBtn.addEventListener('click', adminLogin);
    const adminLogoutBtn = $('#admin-logout-btn');
    if (adminLogoutBtn) adminLogoutBtn.addEventListener('click', adminLogout);
    $$('#admin-tabs .pill-btn[data-atab]').forEach(b => {
      b.addEventListener('click', () => showAdminTab(b.dataset.atab));
    });
    const saveSet = $('#admin-save-settings');
    if (saveSet) saveSet.addEventListener('click', saveAdminSettings);
    const addTaskBtn = $('#admin-add-task');
    if (addTaskBtn) addTaskBtn.addEventListener('click', adminAddTask);
    const nTest = $('#admin-notify-test');
    if (nTest) nTest.addEventListener('click', async () => {
      const telegramId = ($('#admin-notify-tg')?.value || '').trim();
      const msg = $('#admin-notify-msg');
      if (!telegramId) return toast('Telegram ID daalo', 'error');
      try {
        const r = await adminApi('/notify-test', { method: 'POST', body: { telegramId } });
        if (msg) msg.textContent = r.success ? 'Sent ✓ check bot chat' : (r.telegram?.description || r.tip || 'Failed');
        toast(r.success ? 'Test message sent' : (r.tip || 'Failed'), r.success ? 'success' : 'error');
      } catch (e) { if (msg) msg.textContent = e.message; toast(e.message, 'error'); }
    });
    const nRun = $('#admin-notify-run');
    if (nRun) nRun.addEventListener('click', async () => {
      const msg = $('#admin-notify-msg');
      try {
        const r = await adminApi('/notify-run', { method: 'POST', body: {} });
        const res = r.result || {};
        if (msg) msg.textContent = `sent=${res.sent || 0} failed=${res.failed || 0} candidates=${res.candidates || 0}`;
        toast('Pause job ran', 'success');
      } catch (e) { if (msg) msg.textContent = e.message; toast(e.message, 'error'); }
    });
    const userSearch = $('#admin-user-search');
    if (userSearch) {
      let t;
      userSearch.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(loadAdminUsers, 300);
      });
    }
    // deposit confirm/reject + withdrawal + task toggle (event delegation)
    document.addEventListener('click', async (ev) => {
      const t = ev.target;
      if (!(t instanceof HTMLElement)) return;
      const conf = t.getAttribute('data-confirm-dep');
      const rej = t.getAttribute('data-reject-dep');
      const wdOk = t.getAttribute('data-wd-ok');
      const wdNo = t.getAttribute('data-wd-no');
      const taskToggle = t.getAttribute('data-task-toggle');
      try {
        if (conf) {
          await adminApi('/deposits/' + conf, { method: 'PATCH', body: { status: 'confirmed' } });
          toast('Deposit confirmed', 'success');
          loadAdminDeposits();
          loadAdminStats();
        } else if (rej) {
          await adminApi('/deposits/' + rej, { method: 'PATCH', body: { status: 'rejected' } });
          toast('Deposit rejected', 'success');
          loadAdminDeposits();
        } else if (wdOk) {
          await adminApi('/withdrawals/' + wdOk, { method: 'PATCH', body: { status: 'completed' } });
          toast('Withdrawal marked paid', 'success');
          loadAdminWithdrawals();
          loadAdminStats();
        } else if (wdNo) {
          await adminApi('/withdrawals/' + wdNo, { method: 'PATCH', body: { status: 'rejected' } });
          toast('Withdrawal rejected', 'success');
          loadAdminWithdrawals();
        } else if (t.getAttribute('data-task-save')) {
          await adminSaveTask(t.getAttribute('data-task-save'));
        } else if (taskToggle) {
          const isActive = t.getAttribute('data-active') === '1';
          await adminApi('/tasks/' + taskToggle, { method: 'PUT', body: { isActive } });
          toast(isActive ? 'Task shown' : 'Task hidden', 'success');
          loadAdminTasks();
        } else if (t.getAttribute('data-task-delete')) {
          const id = t.getAttribute('data-task-delete');
          if (!confirm('Delete this task?')) return;
          await adminApi('/tasks/' + id, { method: 'DELETE' });
          toast('Task deleted', 'success');
          loadAdminTasks();
        } else if (t.getAttribute('data-user-save')) {
          await adminSaveUserBalances(t.getAttribute('data-user-save'));
        } else if (t.getAttribute('data-user-ban')) {
          const id = t.getAttribute('data-user-ban');
          const ban = t.getAttribute('data-banned') === '1';
          await adminApi('/users/' + id, { method: 'PATCH', body: { isBanned: ban } });
          toast(ban ? 'User banned' : 'User unbanned', 'success');
          loadAdminUsers();
        }
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  async function bootApp() {
    // Show UI ASAP — don't block on secondary loads
    updateHeader();
    if (user) updateWalletButtons(user.walletAddress || null);
    const loading = $('#loading-screen');
    const main = $('#main-app');
    if (loading) loading.classList.remove('active');
    if (main) main.classList.add('active');

    // HQ / full power: ONLY Telegram ID 8990854464 (owner)
    setAdminLoggedIn(false);
    if (isAppOwner(user)) {
      // Auto owner HQ login (no password)
      api('/admin/owner-login', { method: 'POST', body: {} })
        .then((data) => {
          if (data && data.token) {
            adminToken = data.token;
            localStorage.setItem('hype_admin_token', adminToken);
            localStorage.setItem('hype_admin_tg', String(user.telegramId));
            setAdminLoggedIn(true);
          }
        })
        .catch((err) => {
          console.warn('owner-login', err);
          setAdminLoggedIn(false);
        });
    } else {
      // Never show HQ to non-owners
      adminToken = null;
      localStorage.removeItem('hype_admin_token');
      localStorage.removeItem('hype_admin_tg');
      setAdminLoggedIn(false);
    }

    // Mine status + TonConnect in background (faster first paint)
    loadMineStatus().catch(() => {});
    setTimeout(() => { try { initTonConnect(); } catch (_) {} }, 400);
  }

  /* ========== In-app Admin HQ ========== */
  const ADMIN_SETTING_LABELS = {
    mining_rate: 'Mining rate (HYPE/tap)',
    mine_cooldown_seconds: 'Cooldown (sec)',
    energy_cost_per_mine: 'Energy per mine',
    energy_regen_per_hour: 'Energy regen / hour',
    daily_mine_limit: 'Daily mine limit',
    min_hype_swap: 'Min HYPE to swap',
    hype_to_ton_rate: 'HYPE → TON rate',
    hype_to_gram_rate: 'HYPE → GRAM rate',
    hype_per_level: 'HYPE mined per level (10)',
    max_miner_level: 'Max miner level',
    min_usdt_deposit: 'Min USDT unlock (0.5)',
    usdt_deposit_address: 'USDT treasury address',
    usdt_deposit_network: 'USDT network (BEP20/TRC20)',
    treasury_wallet: 'TON treasury (0.1 TON verify)',
    ton_verify_amount: 'TON verify amount (0.1)',
    ton_verify_enabled: 'TON verify open (true/false)',
    min_withdraw: 'Min HYPE withdraw',
    withdrawals_enabled: 'Withdrawals open (true/false)',
    swap_enabled: 'Swap open (true/false)',
    deposit_enabled: 'USDT deposits open (true/false)',
    referral_bonus: 'Referral bonus HYPE',
    referral_commission_pct: 'Referral %',
    target_cap: 'Pool target cap',
    token_symbol: 'Token symbol',
    app_name: 'App name',
    mining_pause_hours: 'Pause notify hours (8)',
    mining_pause_notify_enabled: 'Pause notify on (true/false)',
    community_channel_url: 'Join Community URL',
    webapp_url: 'Mini App URL'
  };

  async function adminApi(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (adminToken) headers['Authorization'] = 'Bearer ' + adminToken;
    const res = await fetch(API + '/admin' + path, {
      ...opts,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || 'Admin request failed');
    return data;
  }

  function setAdminLoggedIn(on) {
    const login = $('#admin-login-card');
    const panel = $('#admin-panel');
    const nav = $('#nav-admin');
    const openBtn = $('#btn-open-admin');
    // HQ tab + Staff button ONLY for logged-in admin
    if (login) login.classList.toggle('hidden', !!on);
    if (panel) panel.classList.toggle('hidden', !on);
    if (nav) {
      if (on) nav.classList.remove('hidden');
      else nav.classList.add('hidden');
    }
    if (openBtn) {
      if (on) openBtn.classList.remove('hidden');
      else openBtn.classList.add('hidden');
    }
    if (!on && document.querySelector('#page-admin.active')) {
      showPage('profile');
    }
  }

  function refreshAdminUI() {
    if (!adminToken) {
      setAdminLoggedIn(false);
      return;
    }
    setAdminLoggedIn(true);
    const active = document.querySelector('#admin-tabs .pill-btn.on');
    const tab = active?.dataset?.atab || 'dash';
    showAdminTab(tab);
  }

  function showAdminTab(name) {
    $$('#admin-tabs .pill-btn[data-atab]').forEach(b => {
      b.classList.toggle('on', b.dataset.atab === name);
    });
    $$('.admin-tab').forEach(el => el.classList.add('hidden'));
    const pane = $('#atab-' + name);
    if (pane) pane.classList.remove('hidden');
    if (name === 'dash') loadAdminStats();
    if (name === 'settings') loadAdminSettings();
    if (name === 'tasks') loadAdminTasks();
    if (name === 'deposits') loadAdminDeposits();
    if (name === 'withdrawals') loadAdminWithdrawals();
    if (name === 'users') loadAdminUsers();
  }

  async function adminLogin() {
    const username = ($('#admin-user')?.value || '').trim();
    const password = $('#admin-pass')?.value || '';
    const msg = $('#admin-login-msg');
    if (!username || !password) {
      if (msg) msg.textContent = 'Enter username & password';
      return;
    }
    try {
      const res = await fetch(API + '/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Login failed');
      adminToken = data.token;
      localStorage.setItem('hype_admin_token', adminToken);
      // Bind HQ to THIS telegram account only (other accounts on same phone won't see HQ)
      if (user && user.telegramId) {
        localStorage.setItem('hype_admin_tg', String(user.telegramId));
      }
      if (msg) msg.textContent = '';
      setAdminLoggedIn(true);
      showAdminTab('dash');
      toast('HQ logged in', 'success');
    } catch (err) {
      if (msg) msg.textContent = err.message;
      toast(err.message, 'error');
    }
  }

  function adminLogout() {
    adminToken = null;
    localStorage.removeItem('hype_admin_token');
    localStorage.removeItem('hype_admin_tg');
    setAdminLoggedIn(false);
    toast('HQ logged out', 'success');
  }

  async function loadAdminStats() {
    const el = $('#admin-stats');
    if (!el) return;
    try {
      const s = await adminApi('/stats');
      el.innerHTML =
        '<div class="admin-stat"><b>' + (s.users || 0) + '</b><span>Users</span></div>' +
        '<div class="admin-stat"><b>' + (s.totalMined || 0) + '</b><span>Total mined</span></div>' +
        '<div class="admin-stat"><b>' + (s.totalBalance || 0) + '</b><span>Balances</span></div>' +
        '<div class="admin-stat"><b>' + (s.pendingWithdrawals || 0) + '</b><span>Pending WD</span></div>';
    } catch (err) {
      el.textContent = err.message;
    }
  }

  async function loadAdminSettings() {
    const form = $('#admin-settings-form');
    if (!form) return;
    try {
      const { settings } = await adminApi('/settings');
      form.innerHTML = Object.keys(ADMIN_SETTING_LABELS).map(k => {
        const v = settings[k] != null ? String(settings[k]) : '';
        return '<div><label>' + ADMIN_SETTING_LABELS[k] + '</label>' +
          '<input data-key="' + k + '" value="' + esc(v) + '" /></div>';
      }).join('');
    } catch (err) {
      form.innerHTML = '<p class="muted">' + esc(err.message) + '</p>';
    }
  }

  async function saveAdminSettings() {
    const updates = {};
    $$('#admin-settings-form input').forEach(i => {
      updates[i.dataset.key] = i.value;
    });
    const msg = $('#admin-settings-msg');
    try {
      await adminApi('/settings', { method: 'PUT', body: updates });
      if (msg) msg.textContent = 'Saved ✓';
      toast('Settings saved', 'success');
    } catch (err) {
      if (msg) msg.textContent = err.message;
      toast(err.message, 'error');
    }
  }

  async function loadAdminDeposits() {
    const el = $('#admin-deposits-list');
    if (!el) return;
    try {
      const { deposits } = await adminApi('/deposits?status=pending');
      if (!deposits || !deposits.length) {
        el.innerHTML = '<p class="muted">No pending deposits</p>';
        return;
      }
      el.innerHTML = deposits.map(d => {
        const who = d.username || d.first_name || d.telegram_id || d.user_id;
        const asset = d.asset || 'USDT';
        const purpose = d.purpose || (asset === 'TON' ? 'verify' : 'unlock');
        return '<div class="admin-row" data-dep="' + d.id + '">' +
          '<div class="ar-top"><strong>#' + d.id + ' · ' + esc(String(who)) + '</strong>' +
          '<span>' + d.amount + ' ' + asset + '</span></div>' +
          '<div class="ar-meta">' + purpose + ' · ' + esc((d.tx_hash || '—').slice(0, 40)) +
          ' · ' + esc((d.created_at || '').slice(0, 16)) + '</div>' +
          '<div class="ar-actions">' +
          '<button type="button" class="btn ok" data-confirm-dep="' + d.id + '">Confirm</button>' +
          '<button type="button" class="btn bad" data-reject-dep="' + d.id + '">Reject</button>' +
          '</div></div>';
      }).join('');
    } catch (err) {
      el.innerHTML = '<p class="muted">' + esc(err.message) + '</p>';
    }
  }

  async function loadAdminWithdrawals() {
    const el = $('#admin-withdrawals-list');
    if (!el) return;
    try {
      const { withdrawals } = await adminApi('/withdrawals?status=pending');
      if (!withdrawals || !withdrawals.length) {
        el.innerHTML = '<p class="muted">No pending withdrawals</p>';
        return;
      }
      el.innerHTML = withdrawals.map(w => {
        const who = w.username || w.first_name || w.telegram_id || w.user_id;
        return '<div class="admin-row">' +
          '<div class="ar-top"><strong>#' + w.id + ' · ' + esc(String(who)) + '</strong>' +
          '<span>' + w.amount + ' ' + (w.asset || '') + '</span></div>' +
          '<div class="ar-meta">' + esc(w.wallet_address || '') + '</div>' +
          '<div class="ar-actions">' +
          '<button type="button" class="btn ok" data-wd-ok="' + w.id + '">Paid</button>' +
          '<button type="button" class="btn bad" data-wd-no="' + w.id + '">Reject</button>' +
          '</div></div>';
      }).join('');
    } catch (err) {
      el.innerHTML = '<p class="muted">' + esc(err.message) + '</p>';
    }
  }

  async function loadAdminUsers() {
    const el = $('#admin-users-list');
    if (!el) return;
    const q = ($('#admin-user-search')?.value || '').trim();
    try {
      const path = q ? '/users?q=' + encodeURIComponent(q) : '/users';
      const { users } = await adminApi(path);
      if (!users || !users.length) {
        el.innerHTML = '<p class="muted">No users</p>';
        return;
      }
      el.innerHTML = users.slice(0, 50).map(u => {
        const bal = Number(u.balance || 0);
        const hold = Number(u.holding_balance || 0);
        const mined = Number(u.total_mined || 0);
        return '<div class="admin-row admin-user-edit" data-user-id="' + u.id + '">' +
          '<div class="ar-top"><strong>' + esc(u.username || u.first_name || 'user') + '</strong>' +
          '<span>TG ' + esc(String(u.telegram_id || '')) + '</span></div>' +
          '<div class="ar-meta">Lvl ' + (u.miner_level || 1) +
          (u.is_verified ? ' · ✓' : '') +
          (u.is_banned ? ' · BANNED' : '') + '</div>' +
          '<label class="muted small">Balance HYPE</label>' +
          '<input type="number" class="au-balance" step="0.0001" value="' + bal + '" />' +
          '<label class="muted small">Holding HYPE</label>' +
          '<input type="number" class="au-holding" step="0.0001" value="' + hold + '" />' +
          '<label class="muted small">Total mined (leaderboard)</label>' +
          '<input type="number" class="au-mined" step="0.0001" value="' + mined + '" />' +
          '<div class="ar-actions" style="margin-top:8px">' +
          '<button type="button" class="btn primary" data-user-save="' + u.id + '">Save balances</button>' +
          '<button type="button" class="btn ' + (u.is_banned ? 'ok' : 'bad') + '" data-user-ban="' + u.id + '" data-banned="' + (u.is_banned ? '0' : '1') + '">' +
          (u.is_banned ? 'Unban' : 'Ban') + '</button>' +
          '</div></div>';
      }).join('');
    } catch (err) {
      el.innerHTML = '<p class="muted">' + esc(err.message) + '</p>';
    }
  }

  async function adminSaveUserBalances(id) {
    const row = document.querySelector('.admin-user-edit[data-user-id="' + id + '"]');
    if (!row) return;
    const balance = parseFloat(row.querySelector('.au-balance')?.value || '0');
    const holdingBalance = parseFloat(row.querySelector('.au-holding')?.value || '0');
    const totalMined = parseFloat(row.querySelector('.au-mined')?.value || '0');
    try {
      await adminApi('/users/' + id, {
        method: 'PATCH',
        body: {
          balance: isNaN(balance) ? 0 : balance,
          holdingBalance: isNaN(holdingBalance) ? 0 : holdingBalance,
          totalMined: isNaN(totalMined) ? 0 : totalMined
        }
      });
      toast('User balances saved ✓', 'success');
      loadAdminUsers();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function loadAdminTasks() {
    const el = $('#admin-tasks-list');
    if (!el) return;
    try {
      const { tasks } = await adminApi('/tasks');
      if (!tasks || !tasks.length) {
        el.innerHTML = '<p class="muted">Abhi koi task nahi — upar se Save &amp; add karo</p>';
        return;
      }
      el.innerHTML = tasks.map(t => {
        const active = t.is_active !== 0 && t.is_active !== false;
        const url = t.target_url || t.targetUrl || '';
        return '<div class="admin-row admin-task-edit" data-task-id="' + t.id + '">' +
          '<label class="muted small">Name</label>' +
          '<input type="text" class="at-name" value="' + esc(t.title || '') + '" />' +
          '<label class="muted small">Link</label>' +
          '<input type="text" class="at-url" value="' + esc(url) + '" />' +
          '<label class="muted small">Reward HYPE</label>' +
          '<input type="number" class="at-reward" step="0.1" min="0" value="' + (t.reward != null ? t.reward : 0) + '" />' +
          '<div class="ar-actions" style="margin-top:10px">' +
          '<button type="button" class="btn primary" data-task-save="' + t.id + '">Save</button>' +
          '<button type="button" class="btn ' + (active ? 'bad' : 'ok') + '" data-task-toggle="' + t.id + '" data-active="' + (active ? '0' : '1') + '">' +
          (active ? 'Hide' : 'Show') + '</button>' +
          '<button type="button" class="btn bad" data-task-delete="' + t.id + '">Delete</button>' +
          '</div></div>';
      }).join('');
    } catch (err) {
      el.innerHTML = '<p class="muted">' + esc(err.message) + '</p>';
    }
  }

  async function adminAddTask() {
    const title = ($('#atask-title')?.value || '').trim();
    const reward = parseFloat($('#atask-reward')?.value || '0');
    const targetUrl = ($('#atask-url')?.value || '').trim();
    if (!title) return toast('Name likho — yahi users ko dikhega', 'error');
    try {
      await adminApi('/tasks', {
        method: 'POST',
        body: {
          title,
          description: title,
          reward: isNaN(reward) ? 0 : reward,
          type: 'manual',
          targetUrl: targetUrl || null,
          channelId: null,
          sortOrder: Date.now() % 100000
        }
      });
      toast('Task saved ✓', 'success');
      if ($('#atask-title')) $('#atask-title').value = '';
      if ($('#atask-url')) $('#atask-url').value = '';
      loadAdminTasks();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function adminSaveTask(id) {
    const row = document.querySelector('.admin-task-edit[data-task-id="' + id + '"]');
    if (!row) return;
    const title = (row.querySelector('.at-name')?.value || '').trim();
    const targetUrl = (row.querySelector('.at-url')?.value || '').trim();
    const reward = parseFloat(row.querySelector('.at-reward')?.value || '0');
    if (!title) return toast('Name empty nahi ho sakta', 'error');
    try {
      await adminApi('/tasks/' + id, {
        method: 'PUT',
        body: {
          title,
          description: title,
          targetUrl: targetUrl || null,
          reward: isNaN(reward) ? 0 : reward
        }
      });
      toast('Saved ✓', 'success');
      loadAdminTasks();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  let eventsBound = false;
  let safetyTimer = null;

  async function tryAuthAndBoot() {
    if (safetyTimer) clearTimeout(safetyTimer);
    safetyTimer = setTimeout(() => {
      if ($('#loading-screen')?.classList.contains('active')) {
        setLoadingMessage(
          'Server waking up…',
          'Free hosting sleeps when idle. Wait 30–60s then tap Retry.',
          true
        );
      }
    }, 45000);

    try {
      const ok = await authenticate();
      clearTimeout(safetyTimer);
      if (!ok) return;
      await bootApp();
    } catch (err) {
      clearTimeout(safetyTimer);
      setLoadingMessage('Something went wrong', err.message || 'Unknown error', true);
    }
  }

  async function init() {
    if (!eventsBound) {
      bindEvents();
      eventsBound = true;
      const retryBtn = $('#loading-retry');
      if (retryBtn) {
        retryBtn.addEventListener('click', () => {
          setLoadingMessage('Initializing HYPE Miner…', '', false);
          tryAuthAndBoot();
        });
      }
    }
    await tryAuthAndBoot();
  }

  init();
})();
