const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { fetchNasdaqSymbols } = require('./finnhub');
const { runScan } = require('./scanner');
const { sendPushNotification } = require('./push');

const app = express();
app.use(express.json());

const STORE_PATH = path.join(__dirname, 'store.json');

// ── Persistent store ───────────────────────────────────────────────
function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (_) {}
  return {};
}

function saveStore(data) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

let store = loadStore();
// store shape: { [deviceId]: { pushToken, apiKey, criteria, matchMode, minChangePct, minScore, scanHour, scanMinute, universe, lastScanAt } }

// ── Universe cache ─────────────────────────────────────────────────
async function ensureUniverse(deviceId) {
  const device = store[deviceId];
  if (!device?.apiKey) return [];

  const age = device.universe?.updatedAt ? (Date.now() - device.universe.updatedAt) : Infinity;
  const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;

  if (!device.universe?.stocks || age > ONE_WEEK) {
    console.log(`[${deviceId}] Refreshing universe...`);
    try {
      const stocks = await fetchNasdaqSymbols(device.apiKey);
      device.universe = { stocks, updatedAt: Date.now() };
      store[deviceId] = device;
      saveStore(store);
      console.log(`[${deviceId}] Universe: ${stocks.length} stocks`);
    } catch (e) {
      console.error(`[${deviceId}] Universe fetch failed:`, e.message);
    }
  }

  return device.universe?.stocks ?? [];
}

// ── Scan logic ─────────────────────────────────────────────────────
async function scanForDevice(deviceId) {
  const device = store[deviceId];
  if (!device?.pushToken || !device?.apiKey) return;

  console.log(`[${deviceId}] Starting scan...`);

  await sendPushNotification(device.pushToken, {
    title: '📊 Nasduck — Scan started',
    body: 'Scanning NASDAQ for signals. You will be notified when done.',
    data: { screen: 'signals' },
  });

  const universe = await ensureUniverse(deviceId);
  if (!universe.length) {
    await sendPushNotification(device.pushToken, {
      title: '⚠️ Nasduck — Scan failed',
      body: 'Could not load stock universe. Check your API key.',
      data: {},
    });
    return;
  }

  let lastProgress = 0;
  const { signals, evaluated, noData, filtered } = await runScan({
    universe,
    criteria: device.criteria ?? [],
    matchMode: device.matchMode ?? 'any',
    minChangePct: device.minChangePct ?? 1,
    minScore: device.minScore ?? 1,
    apiKey: device.apiKey,
    onProgress: ({ current, total, found }) => {
      const pct = Math.floor((current / total) * 100);
      if (pct - lastProgress >= 25) { // notify every 25%
        lastProgress = pct;
        console.log(`[${deviceId}] Progress: ${pct}% (${found} signals so far)`);
      }
    },
  });

  device.lastScanAt = Date.now();
  device.lastSignals = signals;
  store[deviceId] = device;
  saveStore(store);

  const buyCount = signals.filter(s => s.signal === 'buy').length;
  const top3 = signals.slice(0, 3).map(s => `${s.symbol} (${s.score}pts)`).join(', ');

  if (buyCount > 0) {
    await sendPushNotification(device.pushToken, {
      title: `📈 Nasduck — ${buyCount} buy signal${buyCount > 1 ? 's' : ''} found`,
      body: top3 + (buyCount > 3 ? ` +${buyCount - 3} more` : ''),
      data: { screen: 'signals', signals },
    });
  } else {
    await sendPushNotification(device.pushToken, {
      title: '📊 Nasduck — Scan complete',
      body: `No signals today. Checked ${evaluated} stocks.`,
      data: { screen: 'signals' },
    });
  }

  console.log(`[${deviceId}] Scan done. ${buyCount} buy signals, ${evaluated} evaluated.`);
}

// ── Scheduled scans ────────────────────────────────────────────────
const scheduledJobs = {};

function scheduleDevice(deviceId) {
  const device = store[deviceId];
  if (!device) return;

  const hour = device.scanHour ?? 18;
  const minute = device.scanMinute ?? 0;

  if (scheduledJobs[deviceId]) {
    scheduledJobs[deviceId].destroy();
  }

  const cronExpr = `${minute} ${hour} * * 1-5`; // weekdays only
  scheduledJobs[deviceId] = cron.schedule(cronExpr, () => scanForDevice(deviceId), {
    timezone: 'America/New_York', // US market time
  });

  console.log(`[${deviceId}] Scheduled scan at ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')} ET weekdays`);
}

// Reschedule all devices on startup
Object.keys(store).forEach(scheduleDevice);

// ── API routes ─────────────────────────────────────────────────────

// Phone registers itself + sends config
app.post('/register', (req, res) => {
  const { deviceId, pushToken, apiKey, criteria, matchMode, minChangePct, minScore, scanHour, scanMinute } = req.body;
  if (!deviceId || !pushToken || !apiKey) return res.status(400).json({ error: 'deviceId, pushToken and apiKey required' });

  const existing = store[deviceId] ?? {};
  store[deviceId] = {
    ...existing,
    pushToken,
    apiKey,
    criteria: criteria ?? existing.criteria ?? [],
    matchMode: matchMode ?? existing.matchMode ?? 'any',
    minChangePct: minChangePct ?? existing.minChangePct ?? 1,
    minScore: minScore ?? existing.minScore ?? 1,
    scanHour: scanHour ?? existing.scanHour ?? 18,
    scanMinute: scanMinute ?? existing.scanMinute ?? 0,
  };
  saveStore(store);
  scheduleDevice(deviceId);

  console.log(`[${deviceId}] Registered / updated config`);
  res.json({ ok: true, message: `Scan scheduled at ${store[deviceId].scanHour}:${String(store[deviceId].scanMinute).padStart(2,'0')} ET` });
});

// Trigger scan manually
app.post('/scan/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  if (!store[deviceId]) return res.status(404).json({ error: 'Device not registered' });
  res.json({ ok: true, message: 'Scan started — you will get a push notification when done' });
  scanForDevice(deviceId).catch(console.error);
});

// Get last scan results
app.get('/signals/:deviceId', (req, res) => {
  const device = store[req.params.deviceId];
  if (!device) return res.status(404).json({ error: 'Not found' });
  res.json({ signals: device.lastSignals ?? [], lastScanAt: device.lastScanAt ?? null });
});

// Health check
app.get('/health', (req, res) => {
  const deviceCount = Object.keys(store).length;
  res.json({ ok: true, devices: deviceCount, uptime: Math.floor(process.uptime()) + 's' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nasduck server running on port ${PORT}`));
