const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { fetchNasdaqSymbols } = require('./finnhub');
const { runScan } = require('./scanner');
const { sendPushNotification } = require('./push');

const app = express();
app.use(express.json({ limit: '5mb' }));

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

  // Use locally-provided universe if available (sent from app on registration)
  if (device.universe?.stocks?.length > 0) {
    console.log(`[${deviceId}] Using app-provided universe: ${device.universe.stocks.length} stocks`);
    return device.universe.stocks;
  }

  // Fallback: fetch from Finnhub if app didn't send universe
  console.log(`[${deviceId}] No universe from app, fetching from Finnhub...`);
  try {
    const stocks = await fetchNasdaqSymbols(device.apiKey);
    device.universe = { stocks, updatedAt: Date.now() };
    store[deviceId] = device;
    saveStore(store);
    console.log(`[${deviceId}] Universe fetched: ${stocks.length} stocks`);
  } catch (e) {
    console.error(`[${deviceId}] Universe fetch failed:`, e.message);
  }

  return device.universe?.stocks ?? [];
}

// ── Scan state tracking ────────────────────────────────────────────
const stopFlags = {};    // deviceId → true when stop requested
const scanProgress = {}; // deviceId → { scanning, progress, total, evaluated, noData, filtered, signals }

// ── Scan logic ─────────────────────────────────────────────────────
async function scanForDevice(deviceId, fromIndex = 0, existingSignals = []) {
  const device = store[deviceId];
  if (!device?.pushToken || !device?.apiKey) return;

  if (scanProgress[deviceId]?.scanning) {
    console.log(`[${deviceId}] Scan already running, skipping.`);
    return;
  }

  console.log(`[${deviceId}] Starting scan...`);
  stopFlags[deviceId] = false;
  scanProgress[deviceId] = { scanning: true, progress: fromIndex, total: 0, evaluated: 0, noData: 0, filtered: 0, signals: [...existingSignals], phase: fromIndex > 0 ? 'scanning' : 'starting' };

  // Record scan start time so checkMissedScan uses start (not completion) for dedup
  device.lastScanStartedAt = Date.now();
  store[deviceId] = device;
  try { saveStore(store); } catch (_) {}

  scanProgress[deviceId].phase = 'loading_universe';
  const universe = await ensureUniverse(deviceId);

  if (universe.length) {
    await sendPushNotification(device.pushToken, {
      title: '🔍 Nasduck — Scan started',
      body: `Scanning ${universe.length} stocks. You'll be notified when done.`,
      data: {},
    });
  }

  if (!universe.length) {
    await sendPushNotification(device.pushToken, {
      title: '⚠️ Nasduck — Scan failed',
      body: 'Could not load stock universe. Check your API key.',
      data: {},
    });
    return;
  }

  let scanResult;
  try {
    scanResult = await runScan({
      universe,
      criteria: device.criteria ?? [],
      matchMode: device.matchMode ?? 'any',
      minChangePct: device.minChangePct ?? 1,
      minScore: device.minScore ?? 1,
      minMarketCap: device.minMarketCap ?? 0,
      criteriaWeights: device.criteriaWeights ?? null,
      apiKey: device.apiKey,
      fromIndex,
      existingSignals,
      shouldStop: () => !!stopFlags[deviceId],
      onProgress: ({ current, total, evaluated, noData, filtered, partialSignals }) => {
        scanProgress[deviceId] = {
          scanning: true,
          phase: 'scanning',
          progress: current,
          total,
          evaluated,
          noData,
          filtered,
          signals: partialSignals ?? [],
        };
        if (current % 50 === 0) {
          console.log(`[${deviceId}] Progress: ${current}/${total} (${partialSignals?.length ?? 0} signals)`);
        }
        // Checkpoint: persist partial signals every 100 stocks so a server restart doesn't lose progress
        if (current % 100 === 0 && partialSignals?.length > 0) {
          device.crashResumeIndex = current;
          device.crashResumeSignals = partialSignals;
          device.crashResumeTotal = total;
          store[deviceId] = device;
          try { saveStore(store); } catch (_) {}
        }
      },
    });
  } finally {
    if (scanProgress[deviceId]) scanProgress[deviceId].scanning = false;
  }

  const wasStopped = stopFlags[deviceId];
  stopFlags[deviceId] = false;

  const { signals, evaluated, noData, filtered, stopIndex } = scanResult;

  if (wasStopped && stopIndex != null) {
    // Save resume state so app can continue later
    device.resumeIndex = stopIndex;
    device.resumeSignals = signals;
    store[deviceId] = device;
    try { saveStore(store); } catch (_) {}
    console.log(`[${deviceId}] Scan stopped at ${stopIndex}/${universe.length}. ${signals.length} signals so far.`);
    return;
  }

  // Scan completed — clear resume state and crash checkpoints
  device.resumeIndex = null;
  device.resumeSignals = [];
  device.crashResumeIndex = null;
  device.crashResumeSignals = [];
  device.crashResumeTotal = null;

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

// Check if a scheduled scan was missed (server was asleep) and start it now.
// Called on /status and /register so the first request after wakeup catches up.
function checkMissedScan(deviceId) {
  const device = store[deviceId];
  if (!device?.apiKey || !device?.pushToken) { console.log(`[${deviceId}] checkMissedScan: no apiKey/pushToken`); return; }
  if (scanProgress[deviceId]?.scanning) { console.log(`[${deviceId}] checkMissedScan: already scanning`); return; }

  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));

  const scanHour = device.scanHour ?? 18;
  const scanMinute = device.scanMinute ?? 0;

  // Build today's scheduled time in ET
  const scheduledToday = new Date(etNow);
  scheduledToday.setHours(scanHour, scanMinute, 0, 0);

  console.log(`[${deviceId}] checkMissedScan: etNow=${etNow.toTimeString().slice(0,8)} scheduled=${String(scanHour).padStart(2,'0')}:${String(scanMinute).padStart(2,'0')} lastScanAt=${device.lastScanAt ? new Date(device.lastScanAt).toTimeString().slice(0,8) : 'null'} lastStartedAt=${device.lastScanStartedAt ? new Date(device.lastScanStartedAt).toTimeString().slice(0,8) : 'null'}`);

  // Not yet time
  if (etNow < scheduledToday) { console.log(`[${deviceId}] checkMissedScan: not yet time`); return; }

  // Only catch up within a 4-hour window — don't run yesterday's missed scan
  const msLate = etNow - scheduledToday;
  if (msLate > 4 * 60 * 60 * 1000) { console.log(`[${deviceId}] checkMissedScan: too late (${Math.round(msLate/3600000)}h)`); return; }

  // Already started today at or after scheduled time
  const lastStarted = device.lastScanStartedAt ?? device.lastScanAt;
  if (lastStarted) {
    const lastET = new Date(new Date(lastStarted).toLocaleString('en-US', { timeZone: 'America/New_York' }));
    if (lastET >= scheduledToday) { console.log(`[${deviceId}] checkMissedScan: already ran today at ${lastET.toTimeString().slice(0,8)}`); return; }
  }

  console.log(`[${deviceId}] Missed scheduled scan at ${String(scanHour).padStart(2,'0')}:${String(scanMinute).padStart(2,'0')} ET — starting now (${Math.round(msLate/60000)} min late)`);
  scanForDevice(deviceId).catch(console.error);
}

function scheduleDevice(deviceId) {
  const device = store[deviceId];
  if (!device) return;

  const hour = device.scanHour ?? 18;
  const minute = device.scanMinute ?? 0;

  if (scheduledJobs[deviceId]) {
    scheduledJobs[deviceId].stop();
  }

  const cronExpr = `${minute} ${hour} * * *`; // every day
  scheduledJobs[deviceId] = cron.schedule(cronExpr, () => scanForDevice(deviceId), {
    timezone: 'America/New_York', // US market time
  });

  console.log(`[${deviceId}] Scheduled scan at ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')} ET weekdays`);
}

// Reschedule all devices on startup
// Also promote any crash checkpoints to resumable state so the app can continue
Object.keys(store).forEach(deviceId => {
  const device = store[deviceId];
  if (device?.crashResumeIndex > 0 && device?.crashResumeSignals?.length > 0) {
    // Server crashed mid-scan — restore as a stoppable resume point
    if (!device.resumeIndex || device.crashResumeIndex > device.resumeIndex) {
      device.resumeIndex = device.crashResumeIndex;
      device.resumeSignals = device.crashResumeSignals;
      console.log(`[${deviceId}] Crash recovery: restoring resume point at ${device.crashResumeIndex}/${device.crashResumeTotal} (${device.crashResumeSignals.length} signals)`);
    }
    device.crashResumeIndex = null;
    device.crashResumeSignals = [];
    device.crashResumeTotal = null;
    store[deviceId] = device;
  }
  scheduleDevice(deviceId);
});
try { saveStore(store); } catch (_) {}

// ── API routes ─────────────────────────────────────────────────────

// Phone registers itself + sends config
app.post('/register', (req, res) => {
  try {
    const { deviceId, pushToken, apiKey, criteria, matchMode, minChangePct, minScore, minMarketCap, scanHour, scanMinute, universe, criteriaWeights } = req.body;
    if (!deviceId || !pushToken || !apiKey) return res.status(400).json({ error: 'deviceId, pushToken and apiKey required' });

    const existing = store[deviceId] ?? {};

    // Accept either [{symbol,name}] objects or plain ['AAPL','MSFT'] strings
    let parsedUniverse = existing.universe;
    if (Array.isArray(universe) && universe.length > 0) {
      const stocks = universe.map(s => typeof s === 'string' ? { symbol: s, name: s } : s);
      parsedUniverse = { stocks, updatedAt: Date.now() };
      console.log(`[${deviceId}] Received universe: ${stocks.length} stocks`);
    }

    store[deviceId] = {
      ...existing,
      pushToken,
      apiKey,
      criteria: criteria ?? existing.criteria ?? [],
      matchMode: matchMode ?? existing.matchMode ?? 'any',
      minChangePct: minChangePct ?? existing.minChangePct ?? 1,
      minScore: minScore ?? existing.minScore ?? 1,
      minMarketCap: minMarketCap ?? existing.minMarketCap ?? 0,
      scanHour: scanHour ?? existing.scanHour ?? 18,
      scanMinute: scanMinute ?? existing.scanMinute ?? 0,
      universe: parsedUniverse,
      criteriaWeights: criteriaWeights ?? existing.criteriaWeights ?? null,
    };

    try {
      saveStore(store);
    } catch (saveErr) {
      console.error(`[${deviceId}] saveStore failed:`, saveErr.message);
      // Non-fatal — continue with in-memory store
    }

    scheduleDevice(deviceId);
    console.log(`[${deviceId}] Registered / updated config`);
    res.json({ ok: true, message: `Scan scheduled at ${store[deviceId].scanHour}:${String(store[deviceId].scanMinute).padStart(2,'0')} ET` });
    // Check if today's scan was missed while server was asleep
    setTimeout(() => checkMissedScan(deviceId), 2000);
  } catch (e) {
    console.error('Register error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// Trigger scan manually (fromIndex=0 = fresh, fromIndex>0 = continue)
app.post('/scan/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  const device = store[deviceId];
  if (!device) return res.status(404).json({ error: 'Device not registered' });
  if (scanProgress[deviceId]?.scanning) return res.json({ ok: true, message: 'Scan already running' });

  const fresh = req.body?.fresh === true;
  const fromIndex = (!fresh && device.resumeIndex) ? device.resumeIndex : 0;
  const existingSignals = (!fresh && device.resumeSignals?.length) ? device.resumeSignals : [];

  res.json({ ok: true, message: fromIndex > 0 ? `Continuing from ${fromIndex}` : 'Scan started', resumeIndex: fromIndex, total: device.universe?.stocks?.length ?? 0 });
  scanForDevice(deviceId, fromIndex, existingSignals).catch(console.error);
});

// Stop a running scan
app.post('/stop/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  if (!store[deviceId]) return res.status(404).json({ error: 'Device not registered' });
  if (!scanProgress[deviceId]?.scanning) return res.json({ ok: true, message: 'No scan running' });
  stopFlags[deviceId] = true;
  console.log(`[${deviceId}] Stop requested.`);
  res.json({ ok: true, message: 'Stop signal sent' });
});

// Full device status: scan progress + last results + last scan date
app.get('/status/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const device = store[deviceId];
  if (!device) return res.status(404).json({ error: 'Device not registered' });
  const p = scanProgress[deviceId] ?? { scanning: false, phase: 'idle', progress: 0, total: 0, evaluated: 0, noData: 0, filtered: 0, signals: [] };
  // lastSignals: prefer completed scan results; fall back to resume signals so app shows something after a crash
  const lastSignals = p.scanning ? [] : (device.lastSignals?.length > 0 ? device.lastSignals : (device.resumeSignals ?? []));
  res.json({
    ...p,
    lastScanAt: device.lastScanAt ?? null,
    lastSignals,
    resumeIndex: device.resumeIndex ?? null,
    universeTotal: device.universe?.stocks?.length ?? 0,
  });
  // Wake-up check: start missed scan if server was asleep at scheduled time
  if (!p.scanning) setTimeout(() => checkMissedScan(deviceId), 1000);
});

// Health check
app.get('/health', (req, res) => {
  const deviceCount = Object.keys(store).length;
  res.json({ ok: true, devices: deviceCount, uptime: Math.floor(process.uptime()) + 's' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nasduck server running on port ${PORT}`));
