/**
 * On-chain TX verification — TON (tonscan) + BEP20 USDT (bscscan)
 * Fake hash → { valid: false, error: "Transaction not valid" }
 */
const USDT_BEP20 = '0x55d398326f99059ff775485246999027b3197955';
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function normalizeHash(h) {
  if (!h || typeof h !== 'string') return '';
  let s = h.trim();
  const m =
    s.match(/tonscan\.org\/(?:tx|transaction)\/([a-zA-Z0-9_-]+)/i) ||
    s.match(/tonviewer\.com\/(?:transaction|tx)\/([a-zA-Z0-9_-]+)/i) ||
    s.match(/bscscan\.com\/tx\/(0x[a-fA-F0-9]{64})/i) ||
    s.match(/(0x[a-fA-F0-9]{64})/) ||
    s.match(/\b([a-fA-F0-9]{64})\b/);
  if (m) s = m[1];
  return s.trim();
}

function looksLikeTonHash(h) {
  if (/^[a-fA-F0-9]{64}$/.test(h)) return true;
  if (/^[A-Za-z0-9_-]{40,80}$/.test(h) && !h.startsWith('0x')) return true;
  return false;
}

function looksLikeEvmHash(h) {
  return /^0x[a-fA-F0-9]{64}$/.test(h) || /^[a-fA-F0-9]{64}$/.test(h);
}

async function fetchJson(url, opts = {}, timeoutMs = 14000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (_) {}
    return { ok: res.ok, status: res.status, data, text };
  } finally {
    clearTimeout(t);
  }
}

async function verifyTonTx(txHash, expectedTo, expectedAmountTon) {
  const hash = normalizeHash(txHash);
  if (!hash || hash.length < 16) {
    return { valid: false, error: 'Transaction not valid', detail: 'Invalid hash format' };
  }

  let data = null;
  const urls = [
    'https://tonapi.io/v2/blockchain/transactions/' + encodeURIComponent(hash)
  ];
  for (const url of urls) {
    try {
      const r = await fetchJson(url, { headers: { Accept: 'application/json' } });
      if (r.ok && r.data && (r.data.hash || r.data.in_msg || r.data.account)) {
        data = r.data;
        break;
      }
    } catch (_) {}
  }

  if (!data) {
    try {
      const r = await fetchJson(
        'https://toncenter.com/api/v3/transactionsByMessage?msg_hash=' +
          encodeURIComponent(hash) +
          '&direction=in',
        { headers: { Accept: 'application/json' } }
      );
      if (r.ok && r.data) {
        if (Array.isArray(r.data.transactions) && r.data.transactions[0]) {
          data = r.data.transactions[0];
        } else if (r.data.transaction) {
          data = r.data.transaction;
        }
      }
    } catch (_) {}
  }

  if (!data) {
    return {
      valid: false,
      error: 'Transaction not valid',
      detail: 'Hash not found on TON blockchain (check tonscan.org). Fake or wrong network.',
      explorer: 'https://tonscan.org/tx/' + hash
    };
  }

  if (data.success === false || data.aborted === true) {
    return {
      valid: false,
      error: 'Transaction not valid',
      detail: 'Transaction failed/aborted on-chain',
      explorer: 'https://tonscan.org/tx/' + hash
    };
  }

  let toAddr = null;
  let valueNano = 0;
  const msgs = [];
  if (data.in_msg) msgs.push(data.in_msg);
  if (Array.isArray(data.out_msgs)) msgs.push.apply(msgs, data.out_msgs);

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m) continue;
    const dest = m.destination || m.dest;
    const val = m.value || m.amount || 0;
    const n = typeof val === 'string' ? parseInt(val, 10) : Number(val);
    if (dest && n >= valueNano) {
      toAddr = typeof dest === 'string' ? dest : dest.address || dest;
      valueNano = n || valueNano;
    }
  }
  if (!toAddr && data.account) {
    toAddr = typeof data.account === 'string' ? data.account : data.account.address;
  }

  const expected = (expectedTo || '').trim();
  if (expected && toAddr) {
    const a = expected.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
    const b = String(toAddr).replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
    const match =
      a === b ||
      a.slice(-12) === b.slice(-12) ||
      a.includes(b.slice(-10)) ||
      b.includes(a.slice(-10));
    if (!match) {
      return {
        valid: false,
        error: 'Transaction not valid',
        detail: 'Payment went to a different wallet (not our payment channel)',
        explorer: 'https://tonscan.org/tx/' + hash,
        foundTo: toAddr
      };
    }
  }

  if (expectedAmountTon != null && expectedAmountTon > 0 && valueNano > 0) {
    const got = valueNano / 1e9;
    if (got + 1e-6 < expectedAmountTon * 0.95) {
      return {
        valid: false,
        error: 'Transaction not valid',
        detail: 'Amount too low: got ~' + got.toFixed(4) + ' TON, need ' + expectedAmountTon + ' TON',
        explorer: 'https://tonscan.org/tx/' + hash,
        amountTon: got
      };
    }
  }

  return {
    valid: true,
    network: 'TON',
    hash: hash,
    to: toAddr,
    amountTon: valueNano ? valueNano / 1e9 : null,
    explorer: 'https://tonscan.org/tx/' + hash
  };
}

async function verifyBep20Usdt(txHash, expectedTo, expectedAmount) {
  let hash = normalizeHash(txHash);
  if (!hash.startsWith('0x')) hash = '0x' + hash;
  if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) {
    return { valid: false, error: 'Transaction not valid', detail: 'Invalid EVM tx hash' };
  }

  const rpc = process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/';

  async function rpcCall(method, params) {
    const r = await fetchJson(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params })
    });
    if (!r.data || r.data.error) return null;
    return r.data.result;
  }

  const tx = await rpcCall('eth_getTransactionByHash', [hash]);
  if (!tx) {
    return {
      valid: false,
      error: 'Transaction not valid',
      detail: 'Hash not found on BNB Smart Chain (BscScan)',
      explorer: 'https://bscscan.com/tx/' + hash
    };
  }

  const receipt = await rpcCall('eth_getTransactionReceipt', [hash]);
  if (!receipt || receipt.status === '0x0') {
    return {
      valid: false,
      error: 'Transaction not valid',
      detail: 'Transaction failed on-chain',
      explorer: 'https://bscscan.com/tx/' + hash
    };
  }

  let transferTo = null;
  let transferAmount = null;
  const logs = receipt.logs || [];
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    if ((log.address || '').toLowerCase() !== USDT_BEP20) continue;
    if (!log.topics || log.topics[0] !== TRANSFER_TOPIC) continue;
    if (log.topics[2]) transferTo = '0x' + log.topics[2].slice(-40).toLowerCase();
    if (log.data && log.data !== '0x') {
      try {
        transferAmount = Number(BigInt(log.data)) / 1e18;
      } catch (_) {}
    }
  }

  if (!transferTo) {
    return {
      valid: false,
      error: 'Transaction not valid',
      detail: 'No USDT (BEP20) transfer found in this transaction',
      explorer: 'https://bscscan.com/tx/' + hash
    };
  }

  if (expectedTo) {
    const exp = expectedTo.trim().toLowerCase();
    if (exp.startsWith('0x') && transferTo !== exp) {
      return {
        valid: false,
        error: 'Transaction not valid',
        detail: 'USDT sent to a different address (not our payment channel)',
        explorer: 'https://bscscan.com/tx/' + hash,
        foundTo: transferTo
      };
    }
  }

  if (expectedAmount != null && expectedAmount > 0 && transferAmount != null) {
    if (transferAmount + 1e-6 < expectedAmount * 0.95) {
      return {
        valid: false,
        error: 'Transaction not valid',
        detail: 'Amount too low: got ' + transferAmount + ' USDT, need ' + expectedAmount,
        explorer: 'https://bscscan.com/tx/' + hash,
        amount: transferAmount
      };
    }
  }

  return {
    valid: true,
    network: 'BEP20',
    hash: hash,
    to: transferTo,
    amount: transferAmount,
    explorer: 'https://bscscan.com/tx/' + hash
  };
}

async function verifyPaymentTx(opts) {
  const hash = normalizeHash(opts.hash || '');
  if (!hash) {
    return { valid: false, error: 'Transaction not valid', detail: 'Empty hash' };
  }
  if (/^(0x)?0+$/.test(hash) || hash.length < 20) {
    return { valid: false, error: 'Transaction not valid', detail: 'Fake or incomplete hash' };
  }

  const net = String(opts.network || '').toUpperCase();
  const asset = String(opts.asset || '').toUpperCase();

  if (net === 'TON' || asset === 'TON') {
    return verifyTonTx(hash, opts.expectedTo, opts.expectedAmount);
  }
  if (net === 'BEP20' || net === 'BSC' || asset === 'USDT') {
    return verifyBep20Usdt(hash, opts.expectedTo, opts.expectedAmount);
  }

  if (hash.startsWith('0x') || looksLikeEvmHash(hash)) {
    return verifyBep20Usdt(hash, opts.expectedTo, opts.expectedAmount);
  }
  return verifyTonTx(hash, opts.expectedTo, opts.expectedAmount);
}

function explorerLink(network, hash) {
  const h = normalizeHash(hash);
  if (!h) return null;
  const n = String(network || '').toUpperCase();
  if (n === 'TON') return 'https://tonscan.org/tx/' + h;
  if (n === 'BEP20' || n === 'BSC') {
    return 'https://bscscan.com/tx/' + (h.startsWith('0x') ? h : '0x' + h);
  }
  if (h.startsWith('0x') || looksLikeEvmHash(h)) {
    return 'https://bscscan.com/tx/' + (h.startsWith('0x') ? h : '0x' + h);
  }
  return 'https://tonscan.org/tx/' + h;
}

module.exports = {
  verifyPaymentTx,
  verifyTonTx,
  verifyBep20Usdt,
  normalizeHash,
  explorerLink
};
