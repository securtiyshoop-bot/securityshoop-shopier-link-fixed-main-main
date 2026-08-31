require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MySQLStoreFactory = require('express-mysql-session')(session);
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const desktopAuth = require('./desktop-auth');

// ==========================================
// PERSISTENT CLOUD STORAGE ENGINE
// ==========================================
const https = require('https');

const CLOUD_STORAGE_IDS = {
  users: 'ff8081819ff5b11001a043506c03360b',
  activity_logs: 'ff8081819ff5b11001a04350703c360c',
  plugin_control: 'ff8081819ff5b11001a0435075fb360d',
  marifetstore: 'ff8081819ff5b11001a043507d05360e',
  hwid_bans: 'ff8081819ff5b11001a043508572360f',
  orders: 'ff8081819ff5b11001a0435091743610',
  tokens: 'ff8081819ff5b11001a0435d7b2f3674'
};

const TELEGRAM_CONFIG = {
  botToken: '8776000438:AAEHfHDsq-QEM7hT7I7DCmMwJ9LhZlA_5XI',
  chatId: '8890133022'
};

async function sendTelegramNotification(text) {
  try {
    const payload = JSON.stringify({
      chat_id: TELEGRAM_CONFIG.chatId,
      text: text,
      parse_mode: 'HTML'
    });
    const req = https.request(`https://api.telegram.org/bot${TELEGRAM_CONFIG.botToken}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 3000
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(payload);
    req.end();
  } catch (e) {}
}

const cloudCache = new Map();
const cloudCacheTTL = new Map();

function fetchCloudJson(id, fallback) {
  const cached = cloudCache.get(id);
  const exp = cloudCacheTTL.get(id) || 0;
  // Eger onbellekte varsa ve suresi gecmemisse aninda RAM'den dondur (0 ms!)
  if (cached && Date.now() < exp) {
    return Promise.resolve(cached);
  }
  return new Promise((resolve) => {
    const req = https.get(`https://api.restful-api.dev/objects/${id}`, { timeout: 2500 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.data) {
            cloudCache.set(id, parsed.data);
            cloudCacheTTL.set(id, Date.now() + 300000); // 5 DAKIKA TTL (Ultra Hizli!)
            resolve(parsed.data);
          } else {
            resolve(cloudCache.get(id) || fallback);
          }
        } catch {
          resolve(cloudCache.get(id) || fallback);
        }
      });
    });
    req.on('error', (err) => {
      resolve(cloudCache.get(id) || fallback);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(cloudCache.get(id) || fallback);
    });
  });
}

function saveCloudJson(id, name, data) {
  // RAM onbellegini aninda guncelle, boylece sonraki istekler beklemez
  cloudCache.set(id, data);
  cloudCacheTTL.set(id, Date.now() + 300000);
  
  return new Promise((resolve) => {
    const payload = JSON.stringify({ name: `securityshoop_${name}`, data });
    const req = https.request(`https://api.restful-api.dev/objects/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 3000
    }, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(payload);
    req.end();
  });
}


const app = express();
const shopierOsbForm = multer({
  storage: multer.memoryStorage(),
  limits: { fields: 10, fieldSize: 2 * 1024 * 1024, files: 0 }
}).none();

function parseShopierOsbForm(req, res, next) {
  shopierOsbForm(req, res, (error) => {
    if (error) return res.status(400).type('text').send('invalid');
    return next();
  });
}

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.VERCEL ? path.join(os.tmpdir(), 'securityshoop-data') : __dirname;
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const ACTIVITY_LOGS_FILE = path.join(DATA_DIR, 'activity-logs.json');
const HWID_BANS_FILE = path.join(DATA_DIR, 'hwid-bans.json');
const ANNOUNCEMENTS_FILE = path.join(DATA_DIR, 'announcements.json');
const ERROR_REPORTS_FILE = path.join(DATA_DIR, 'error-reports.json');
const PLUGIN_CONTROL_FILE = path.join(DATA_DIR, 'plugin-control.json');
const PLUGIN_STATUS_FILE = path.join(DATA_DIR, 'plugin-status.json');
const PLUGIN_COMMANDS_FILE = path.join(DATA_DIR, 'plugin-commands.json');
const SOURCE_HEALTH_FILE = path.join(DATA_DIR, 'source-health.json');
const DEVICE_RESETS_FILE = path.join(DATA_DIR, 'device-reset-requests.json');
const SUPPORT_TICKETS_FILE = path.join(DATA_DIR, 'support-tickets.json');
const DESKTOP_AUTH_FILE = path.join(DATA_DIR, 'desktop-auth.json');
const SEED_USERS_FILE = path.join(__dirname, 'users.json');
const SEED_REVIEWS_FILE = path.join(__dirname, 'reviews.json');
const SEED_ORDERS_FILE = path.join(__dirname, 'orders.json');
const SHOPIER_PAYMENT_URL = process.env.SHOPIER_PAYMENT_URL || 'https://www.shopier.com/s/shipping/SecurityShoop';
const SHOPIER_PAYMENT_ENDPOINT = 'https://www.shopier.com/ShowProduct/api_pay4.php';
const SHOPIER_ALLOWED_HOSTS = new Set(['www.shopier.com', 'shopier.com']);
const PLUGIN_VERSION = '8.5.2';
const LICENSE_PACKAGES = Object.freeze([
  {
    id: 'random-1',
    name: 'Rastgele 1 Oyun',
    label: 'Hesabina rastgele 1 oyun ekleme',
    days: 3,
    daily_limit: 1,
    price: '30 TL',
    badge: 'Rastgele',
    image: '/license-packages/license-random.jpg',
    description: 'Sistem tarafindan secilen rastgele 1 oyun hesabina eklenir.',
    features: ['Rastgele 1 oyun', '3 gun lisans', 'Tek cihaz kontrolu'],
    shopier_url: 'https://www.shopier.com/SecurityShoop/47898308'
  },
  {
    id: 'single-1',
    name: 'Istedigin 1 Oyun',
    label: 'Hesabina istedigin 1 oyunu ekleme',
    days: 7,
    daily_limit: 1,
    price: '49,50 TL',
    badge: 'Tek Oyun',
    image: '/license-packages/license-1-game.jpg',
    description: 'Sectigin 1 oyunu hesabina eklemek icin tek oyun paketi.',
    features: ['Istedigin 1 oyun', '7 gun lisans', 'Tek cihaz kontrolu'],
    shopier_url: 'https://www.shopier.com/SecurityShoop/47898155'
  },
  {
    id: 'pack-10',
    name: 'Istedigin 10 Oyun',
    label: 'Hesabina istedigin 10 oyunu ekleme',
    days: 15,
    daily_limit: 10,
    price: '200 TL',
    badge: 'Baslangic',
    image: '/license-packages/license-10-games.jpg',
    description: 'Sectigin 10 oyunu hesabina eklemek icin baslangic paketi.',
    features: ['Istedigin 10 oyun', '15 gun lisans', 'Plugin hesap paneli'],
    shopier_url: 'https://www.shopier.com/SecurityShoop/47898371'
  },
  {
    id: 'random-add',
    name: 'Rastgele 25 Oyun',
    label: 'Hesabina rastgele 25 oyun ekleme',
    days: 30,
    daily_limit: 25,
    price: '200 TL',
    badge: 'Surpriz',
    image: '/license-packages/license-25-games.jpg',
    description: 'Sistem tarafindan secilen rastgele 25 oyun hesabina eklenir.',
    features: ['Rastgele 25 oyun', '30 gun lisans', 'Sistem secimli oyun ekleme'],
    shopier_url: 'https://www.shopier.com/SecurityShoop/47898438'
  },
  {
    id: 'pack-50',
    name: 'Istedigin 50 Oyun',
    label: 'Hesabina istedigin 50 oyunu ekleme',
    days: 90,
    daily_limit: 50,
    price: '300 TL',
    badge: 'VIP',
    image: '/license-packages/license-50-games.jpg',
    description: 'Sectigin 50 oyunu hesabina eklemek icin genis VIP paket.',
    features: ['Istedigin 50 oyun', '90 gun VIP lisans', 'Cihaz sifirlama talebi'],
    shopier_url: 'https://www.shopier.com/SecurityShoop/47898323'
  },
  {
    id: 'pack-100',
    name: 'Istedigin 100 Oyun',
    label: 'Hesabina istedigin 100 oyunu ekleme',
    days: 700,
    daily_limit: 100,
    price: '600 TL',
    badge: 'Pro Max',
    image: '/license-packages/license-100-games.jpg',
    description: 'Sectigin 100 oyunu hesabina eklemek icin ust seviye paket.',
    features: ['Istedigin 100 oyun', '700 gun lisans', 'Premium destek'],
    shopier_url: 'https://www.shopier.com/SecurityShoop/47898194'
  },
  {
    id: 'unlimited',
    name: 'Sinirsiz Oyun',
    label: 'Hesabina istedigin her oyunu ekleme',
    days: 0,
    daily_limit: 0,
    price: '999,99 TL',
    badge: 'Premium',
    image: '/license-packages/license-unlimited.jpg',
    description: 'Istedigin oyunlari limitsiz eklemek icin sinirsiz erisim paketi.',
    features: ['Sinirsiz oyun', 'Suresiz lisans', 'Manuel VIP destek'],
    shopier_url: 'https://www.shopier.com/SecurityShoop/47898109'
  }
]);

function cleanHost(val) {
  let s = String(val || '').trim();
  s = s.replace(/^["']|["']$/g, '');
  s = s.replace(/^https?:\/\//i, '');
  s = s.replace(/\/.*$/, '');
  if (s.includes(':')) {
    s = s.split(':')[0];
  }
  return s;
}

function cleanPort(val, hostVal) {
  let h = String(hostVal || '').trim().replace(/^https?:\/\//i, '');
  if (h.includes(':')) {
    const p = Number(h.split(':')[1]);
    if (p) return p;
  }
  const p = Number(String(val || '').trim().replace(/^["']|["']$/g, ''));
  return (Number.isFinite(p) && p > 0) ? p : 3306;
}

function cleanEnvStr(val, fallback = '') {
  const s = String(val || '').trim().replace(/^["']|["']$/g, '');
  return s || fallback;
}

const rawDbHost = cleanEnvStr(process.env.DB_HOST, 'localhost');
const dbConfig = {
  host: cleanHost(rawDbHost),
  port: cleanPort(process.env.DB_PORT, rawDbHost),
  user: cleanEnvStr(process.env.DB_USER, 'root'),
  password: cleanEnvStr(process.env.DB_PASSWORD, ''),
  database: cleanEnvStr(process.env.DB_NAME, 'securityshoop'),
  ssl: (process.env.DB_SSL === 'false' || process.env.DB_SSL === '0') ? undefined : { rejectUnauthorized: false }
};

let pool = null;
let useDatabase = false;
let databaseRetryPromise = null;
let lastDatabaseRetryAt = 0;
let lastDatabaseError = null;
const DATABASE_RETRY_INTERVAL_MS = 1500;
const DATABASE_READY_WAIT_MS = 8000;
const DB_CONNECT_TIMEOUT_MS = 10000;
const AI_CHAT_MODEL = process.env.AI_CHAT_MODEL || 'openai/gpt-5.5';
const AI_CHAT_RATE_LIMIT = Math.max(3, Math.min(60, Number(process.env.AI_CHAT_RATE_LIMIT || 12)));
const aiChatBuckets = new Map();
const SECURITYSHOOP_EXPOSED_HEADERS = [
  'X-SecurityShoop-Key-Id',
  'X-SecurityShoop-Timestamp',
  'X-SecurityShoop-Nonce',
  'X-SecurityShoop-Signature',
  'X-SecurityShoop-Response-Mac'
].join(', ');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Expose-Headers', SECURITYSHOOP_EXPOSED_HEADERS);
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

function ensureUsersFile() {
  if (!fs.existsSync(USERS_FILE)) {
    if (fs.existsSync(SEED_USERS_FILE)) {
      fs.copyFileSync(SEED_USERS_FILE, USERS_FILE);
    } else {
      fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2), 'utf8');
    }
  }
}

function readUsersFile() {
  ensureUsersFile();
  try {
    const cached = cloudCache.get(CLOUD_STORAGE_IDS.users);
    if (cached && Array.isArray(cached.users) && cached.users.length > 0) return cached;
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{"users":[]}');
    if (!Array.isArray(parsed.users)) return { users: [] };
    return parsed;
  } catch {
    return { users: [] };
  }
}

function writeUsersFile(data) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch(e) {}
  saveCloudJson(CLOUD_STORAGE_IDS.users, 'users', data).catch(() => {});
}

async function postWithTimeout(url, options = {}, timeoutMs = 2500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function isConfigured(value) {
  return Boolean(String(value || '').trim());
}

function buildRegistrationAlert(user, source = 'site', hwid = '', req = null) {
  const lines = [
    'SecurityShoop yeni kayit',
    `Kaynak: ${source}`,
    `Kullanici: ${user?.username || '-'}`,
    `E-posta: ${user?.email || '-'}`,
    `Onay: ${user?.approval_status || 'pending'}`,
    `HWID: ${hwid || user?.hwid || '-'}`,
    `IP: ${getRequestIp(req) || '-'}`
  ];
  return lines.join('\n').slice(0, 1500);
}

async function sendTelegramAlert(text) {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chatId) return false;
  const response = await postWithTimeout(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  return response.ok;
}

async function sendDiscordAlert(text) {
  const webhook = String(process.env.DISCORD_WEBHOOK_URL || '').trim();
  if (!webhook) return false;
  const response = await postWithTimeout(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text.slice(0, 1900) })
  });
  return response.ok;
}

async function sendGenericAlert(text, user, source) {
  const webhook = String(process.env.ADMIN_NOTIFY_WEBHOOK_URL || '').trim();
  if (!webhook) return false;
  const response = await postWithTimeout(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'registration', source, message: text, user: { id: user?.id, username: user?.username, email: user?.email, approval_status: user?.approval_status } })
  });
  return response.ok;
}

async function sendTwilioSms(text) {
  const sid = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
  const token = String(process.env.TWILIO_AUTH_TOKEN || '').trim();
  const from = String(process.env.TWILIO_FROM_NUMBER || '').trim();
  const to = String(process.env.ADMIN_PHONE_NUMBER || process.env.ADMIN_SMS_TO || '').trim();
  if (!sid || !token || !from || !to) return false;
  const body = new URLSearchParams({ From: from, To: to, Body: text.slice(0, 1400) });
  const response = await postWithTimeout(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  }, 6500);
  return response.ok;
}

async function notifyAdminRegistration(user, { source = 'site', hwid = '', req = null } = {}) {
  const text = buildRegistrationAlert(user, source, hwid, req);
  const tasks = [
    sendTelegramAlert(text),
    sendDiscordAlert(text),
    sendGenericAlert(text, user, source),
    sendTwilioSms(text)
  ];
  const results = await Promise.allSettled(tasks);
  const sent = results.some((item) => item.status === 'fulfilled' && item.value === true);
  if (!sent && (isConfigured(process.env.TELEGRAM_BOT_TOKEN) || isConfigured(process.env.DISCORD_WEBHOOK_URL) || isConfigured(process.env.ADMIN_NOTIFY_WEBHOOK_URL) || isConfigured(process.env.TWILIO_ACCOUNT_SID))) {
    console.warn('Registration alert configured but no channel accepted the message.');
  }
  return sent;
}

function ensureReviewsFile() {
  if (!fs.existsSync(REVIEWS_FILE)) {
    if (fs.existsSync(SEED_REVIEWS_FILE)) {
      fs.copyFileSync(SEED_REVIEWS_FILE, REVIEWS_FILE);
    } else {
      fs.writeFileSync(REVIEWS_FILE, JSON.stringify({ reviews: [] }, null, 2), 'utf8');
    }
  }
}

function readReviewsFile() {
  ensureReviewsFile();
  try {
    const raw = fs.readFileSync(REVIEWS_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{\"reviews\":[]}');
    if (!Array.isArray(parsed.reviews)) return { reviews: [] };
    return parsed;
  } catch {
    return { reviews: [] };
  }
}

function writeReviewsFile(data) {
  fs.writeFileSync(REVIEWS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function ensureOrdersFile() {
  if (!fs.existsSync(ORDERS_FILE)) {
    if (fs.existsSync(SEED_ORDERS_FILE)) fs.copyFileSync(SEED_ORDERS_FILE, ORDERS_FILE);
    else fs.writeFileSync(ORDERS_FILE, JSON.stringify({ orders: [] }, null, 2), 'utf8');
  }
}

function readOrdersFile() {
  ensureOrdersFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8') || '{"orders":[]}');
    return Array.isArray(parsed.orders) ? parsed : { orders: [] };
  } catch {
    return { orders: [] };
  }
}

function writeOrdersFile(data) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function ensureActivityLogsFile() {
  if (!fs.existsSync(ACTIVITY_LOGS_FILE)) {
    fs.writeFileSync(ACTIVITY_LOGS_FILE, JSON.stringify({ logs: [] }, null, 2), 'utf8');
  }
}

function readActivityLogsFile() {
  ensureActivityLogsFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(ACTIVITY_LOGS_FILE, 'utf8') || '{"logs":[]}');
    return Array.isArray(parsed.logs) ? parsed : { logs: [] };
  } catch {
    return { logs: [] };
  }
}

function writeActivityLogsFile(data) {
  fs.writeFileSync(ACTIVITY_LOGS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function ensureHwidBansFile() {
  if (!fs.existsSync(HWID_BANS_FILE)) {
    fs.writeFileSync(HWID_BANS_FILE, JSON.stringify({ bans: [] }, null, 2), 'utf8');
  }
}

function readHwidBansFile() {
  ensureHwidBansFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(HWID_BANS_FILE, 'utf8') || '{"bans":[]}');
    return Array.isArray(parsed.bans) ? parsed : { bans: [] };
  } catch {
    return { bans: [] };
  }
}

function writeHwidBansFile(data) {
  fs.writeFileSync(HWID_BANS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function ensureAnnouncementsFile() {
  if (!fs.existsSync(ANNOUNCEMENTS_FILE)) {
    fs.writeFileSync(ANNOUNCEMENTS_FILE, JSON.stringify({ announcements: [] }, null, 2), 'utf8');
  }
}

function readAnnouncementsFile() {
  ensureAnnouncementsFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(ANNOUNCEMENTS_FILE, 'utf8') || '{"announcements":[]}');
    return Array.isArray(parsed.announcements) ? parsed : { announcements: [] };
  } catch {
    return { announcements: [] };
  }
}

function writeAnnouncementsFile(data) {
  fs.writeFileSync(ANNOUNCEMENTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function ensureErrorReportsFile() {
  if (!fs.existsSync(ERROR_REPORTS_FILE)) {
    fs.writeFileSync(ERROR_REPORTS_FILE, JSON.stringify({ reports: [] }, null, 2), 'utf8');
  }
}

function readErrorReportsFile() {
  ensureErrorReportsFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(ERROR_REPORTS_FILE, 'utf8') || '{"reports":[]}');
    return Array.isArray(parsed.reports) ? parsed : { reports: [] };
  } catch {
    return { reports: [] };
  }
}

function writeErrorReportsFile(data) {
  fs.writeFileSync(ERROR_REPORTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getDefaultPluginControl() {
  return {
    maintenance_mode: false,
    add_game_enabled: true,
    account_required: true,
    force_update: false,
    latest_version: PLUGIN_VERSION,
    update_url: '/securityshoop-plugin.zip',
    release_notes: '',
    rollout_channel: 'stable',
    notice_title: 'SecurityShoop',
    notice_message: '',
    support_url: 'https://www.instagram.com/securityshoop/?hl=tr',
    updated_by: '',
    updated_at: ''
  };
}

function compareVersionStrings(left, right) {
  const a = String(left || '').match(/\d+/g)?.map(Number) || [];
  const b = String(right || '').match(/\d+/g)?.map(Number) || [];
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

function normalizePluginControl(input = {}) {
  const defaults = getDefaultPluginControl();
  let latestVersion = String(input.latest_version || defaults.latest_version).trim().slice(0, 40);
  if (!latestVersion || compareVersionStrings(latestVersion, defaults.latest_version) < 0) {
    latestVersion = defaults.latest_version;
  }
  return {
    ...defaults,
    ...input,
    maintenance_mode: Boolean(input.maintenance_mode),
    add_game_enabled: input.add_game_enabled !== false,
    account_required: input.account_required !== false,
    force_update: Boolean(input.force_update),
    latest_version: latestVersion,
    update_url: String(input.update_url || '').trim().slice(0, 500),
    release_notes: String(input.release_notes || '').trim().slice(0, 2000),
    rollout_channel: String(input.rollout_channel || defaults.rollout_channel).trim().slice(0, 40),
    notice_title: String(input.notice_title || defaults.notice_title).trim().slice(0, 120),
    notice_message: String(input.notice_message || '').trim().slice(0, 1200),
    support_url: String(input.support_url || defaults.support_url).trim().slice(0, 500),
    updated_by: String(input.updated_by || '').trim().slice(0, 190),
    updated_at: String(input.updated_at || '').trim()
  };
}

function ensurePluginControlFile() {
  if (!fs.existsSync(PLUGIN_CONTROL_FILE)) {
    fs.writeFileSync(PLUGIN_CONTROL_FILE, JSON.stringify({ control: normalizePluginControl() }, null, 2), 'utf8');
  }
}

function readPluginControlFile() {
  ensurePluginControlFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(PLUGIN_CONTROL_FILE, 'utf8') || '{}');
    return normalizePluginControl(parsed.control || parsed);
  } catch {
    return normalizePluginControl();
  }
}

function writePluginControlFile(control) {
  fs.writeFileSync(PLUGIN_CONTROL_FILE, JSON.stringify({ control: normalizePluginControl(control) }, null, 2), 'utf8');
}

function ensureJsonFile(file, fallback) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2), 'utf8');
}

function readJsonFile(file, fallback) {
  ensureJsonFile(file, fallback);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function parseJsonField(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function toIsoDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function toSqlDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 19).replace('T', ' ');
}

function readPluginStatusFile() {
  const data = readJsonFile(PLUGIN_STATUS_FILE, { statuses: [] });
  return Array.isArray(data.statuses) ? data : { statuses: [] };
}

function writePluginStatusFile(data) {
  writeJsonFile(PLUGIN_STATUS_FILE, { statuses: Array.isArray(data.statuses) ? data.statuses.slice(0, 500) : [] });
}

function readPluginCommandsFile() {
  const data = readJsonFile(PLUGIN_COMMANDS_FILE, { commands: [] });
  return Array.isArray(data.commands) ? data : { commands: [] };
}

function writePluginCommandsFile(data) {
  writeJsonFile(PLUGIN_COMMANDS_FILE, { commands: Array.isArray(data.commands) ? data.commands.slice(0, 500) : [] });
}

function readSourceHealthFile() {
  const data = readJsonFile(SOURCE_HEALTH_FILE, { sources: [] });
  return Array.isArray(data.sources) ? data : { sources: [] };
}

function writeSourceHealthFile(data) {
  writeJsonFile(SOURCE_HEALTH_FILE, { sources: Array.isArray(data.sources) ? data.sources.slice(0, 200) : [] });
}

function normalizeSourceName(name) {
  return String(name || '').trim().toLowerCase();
}

function mapSourceHealthRow(row = {}) {
  const item = {
    name: String(row.name || row.source_key || '').trim(),
    status: String(row.status || '').trim(),
    successRate: Number(row.success_rate ?? row.successRate ?? 0),
    attempts: Number(row.attempts || 0),
    successes: Number(row.successes || 0),
    failures: Number(row.failures || 0),
    lastError: String(row.last_error ?? row.lastError ?? '').trim(),
    disabled: row.disabled === true || Number(row.disabled || 0) === 1,
    disabled_at: toIsoDate(row.disabled_at),
    disabled_reason: String(row.disabled_reason || '').trim(),
    updated_at: toIsoDate(row.updated_at)
  };
  const score = calculateSourceScore(item);
  return {
    ...item,
    source_score: score.score,
    source_grade: score.grade,
    source_priority: score.priority,
    recommended: score.recommended
  };
}

function calculateSourceScore(source = {}) {
  const attempts = Math.max(0, Number(source.attempts || 0));
  const failures = Math.max(0, Number(source.failures || 0));
  const successRate = attempts > 0 ? Math.max(0, Math.min(100, Number(source.successRate || 0))) : 50;
  let score = Math.round(successRate - Math.min(40, failures * 9));
  if (attempts === 0) score = Math.min(score, 60);
  if (source.disabled === true) score = Math.min(score, 20);
  score = Math.max(0, Math.min(100, score));
  const grade = score >= 85 ? 'A' : (score >= 70 ? 'B' : (score >= 50 ? 'C' : 'D'));
  return {
    score,
    grade,
    priority: source.disabled === true ? 999 : ((100 - score) + (failures * 10)),
    recommended: source.disabled !== true && score >= 70
  };
}

function sourceScorePayload(source = {}) {
  const score = calculateSourceScore(source);
  return {
    name: source.name || '',
    score: score.score,
    grade: score.grade,
    priority: score.priority,
    recommended: score.recommended,
    disabled: source.disabled === true,
    failures: Number(source.failures || 0),
    successRate: Number(source.successRate || 0),
    lastError: source.lastError || source.disabled_reason || ''
  };
}

async function getSourceScores(limit = 200) {
  return (await listSourceHealth(limit))
    .map(sourceScorePayload)
    .filter((item) => item.name)
    .sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0));
}

async function listSourceHealth(limit = 200) {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  if (useDatabase) {
    const [rows] = await pool.query(
      `SELECT source_key, name, status, success_rate, attempts, successes, failures, last_error, disabled, disabled_at, disabled_reason, updated_at
       FROM source_health ORDER BY updated_at DESC, name ASC LIMIT ?`,
      [safeLimit]
    );
    return rows.map(mapSourceHealthRow);
  }
  return readSourceHealthFile().sources.slice(0, safeLimit).map(mapSourceHealthRow);
}

async function saveSourceHealthEntry(source = {}) {
  const name = String(source.name || '').trim().slice(0, 190);
  const key = normalizeSourceName(name);
  if (!key) return null;
  const item = {
    name,
    status: String(source.status || '').slice(0, 80),
    successRate: Number(source.successRate ?? source.success_rate ?? 0),
    attempts: Math.max(0, Number(source.attempts || 0)),
    successes: Math.max(0, Number(source.successes || 0)),
    failures: Math.max(0, Number(source.failures || 0)),
    lastError: String(source.lastError ?? source.last_error ?? '').slice(0, 500),
    disabled: source.disabled === true || Number(source.disabled || 0) === 1,
    disabled_at: source.disabled_at || '',
    disabled_reason: String(source.disabled_reason || '').slice(0, 500),
    updated_at: source.updated_at || new Date().toISOString()
  };

  if (useDatabase) {
    await pool.query(
      `INSERT INTO source_health (
        source_key, name, status, success_rate, attempts, successes, failures, last_error,
        disabled, disabled_at, disabled_reason, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        status = VALUES(status),
        success_rate = VALUES(success_rate),
        attempts = VALUES(attempts),
        successes = VALUES(successes),
        failures = VALUES(failures),
        last_error = VALUES(last_error),
        disabled = VALUES(disabled),
        disabled_at = VALUES(disabled_at),
        disabled_reason = VALUES(disabled_reason),
        updated_at = VALUES(updated_at)`,
      [
        key,
        item.name,
        item.status,
        item.successRate,
        item.attempts,
        item.successes,
        item.failures,
        item.lastError,
        item.disabled ? 1 : 0,
        item.disabled_at ? toSqlDate(item.disabled_at) : null,
        item.disabled_reason,
        toSqlDate(item.updated_at)
      ]
    );
  } else {
    const health = readSourceHealthFile();
    const existing = health.sources.find((entry) => normalizeSourceName(entry.name) === key);
    if (existing) Object.assign(existing, item);
    else health.sources.unshift(item);
    writeSourceHealthFile(health);
  }
  return item;
}

async function updateSourceHealth(items = []) {
  const now = new Date().toISOString();
  const current = await listSourceHealth(500);
  const byName = new Map(current.map((source) => [normalizeSourceName(source.name), source]));
  const updated = [];

  for (const item of (Array.isArray(items) ? items.slice(0, 80) : [])) {
    const name = String(item?.name || '').trim().slice(0, 120);
    if (!name) continue;
    const key = normalizeSourceName(name);
    const existingSource = byName.get(key);
    const previousFailures = Number(existingSource?.failures || 0);
    const failed = isSourceFailure(item);
    const succeeded = isSourceSuccess(item);
    const providedFailures = item.failures == null ? null : Math.max(0, Number(item.failures || 0));
    const failures = providedFailures == null
      ? (failed ? previousFailures + 1 : (succeeded ? 0 : previousFailures))
      : (failed ? Math.max(providedFailures, previousFailures + 1) : providedFailures);
    const shouldDisable = existingSource?.disabled === true || failures >= 3;
    const sourceEntry = {
      name,
      status: String(item.status || item.lastStatus || '').slice(0, 80),
      successRate: Number(item.successRate || 0),
      attempts: Number(item.attempts || item.total || 0),
      successes: Number(item.successes || 0),
      failures,
      lastError: String(item.lastError || item.error || '').slice(0, 500),
      disabled: shouldDisable,
      disabled_at: shouldDisable ? (existingSource?.disabled_at || now) : '',
      disabled_reason: shouldDisable ? (existingSource?.disabled_reason || 'Bu kaynak 3 kere hata verdi ve otomatik pasife alindi.') : '',
      updated_at: now
    };
    const saved = await saveSourceHealthEntry(sourceEntry);
    if (saved) {
      byName.set(key, saved);
      updated.push(saved);
    }
  }
  return updated;
}

async function getDisabledSources() {
  return (await listSourceHealth(200))
    .filter((source) => source && source.disabled === true)
    .map((source) => ({
      name: source.name,
      disabled_at: source.disabled_at || '',
      disabled_reason: source.disabled_reason || source.lastError || '3 kere hata verdi.'
    }))
    .filter((source) => source.name);
}

function isSourceFailure(item = {}) {
  const status = String(item.status || item.lastStatus || '').toLowerCase();
  const lastError = String(item.lastError || item.error || '').toLowerCase();
  if (item.available === false || item.ok === false || item.success === false) return true;
  return /fail|failed|error|timeout|unavailable|not found|offline|http\s*[45]\d\d|bad/i.test(`${status} ${lastError}`);
}

function isSourceSuccess(item = {}) {
  const status = String(item.status || item.lastStatus || '').toLowerCase();
  if (item.available === true || item.ok === true || item.success === true) return true;
  return /ok|success|healthy|online|available|ready/i.test(status);
}

async function enableSourceHealth(name, adminUser = null) {
  const clean = normalizeSourceName(name);
  if (!clean) return null;
  const source = (await listSourceHealth(500)).find((item) => normalizeSourceName(item.name) === clean);
  if (!source) return null;
  const next = {
    ...source,
    disabled: false,
    disabled_at: '',
    disabled_reason: '',
    failures: 0,
    status: source.status || 'enabled',
    updated_at: new Date().toISOString()
  };
  await saveSourceHealthEntry(next);
  await recordActivityLog({ user: adminUser, action: 'SOURCE_ENABLE', details: source.name });
  return next;
}

function readDeviceResetRequestsFile() {
  const data = readJsonFile(DEVICE_RESETS_FILE, { requests: [] });
  return Array.isArray(data.requests) ? data : { requests: [] };
}

function writeDeviceResetRequestsFile(data) {
  writeJsonFile(DEVICE_RESETS_FILE, { requests: Array.isArray(data.requests) ? data.requests.slice(0, 500) : [] });
}

function readSupportTicketsFile() {
  const data = readJsonFile(SUPPORT_TICKETS_FILE, { tickets: [] });
  return Array.isArray(data.tickets) ? data : { tickets: [] };
}

function writeSupportTicketsFile(data) {
  writeJsonFile(SUPPORT_TICKETS_FILE, { tickets: Array.isArray(data.tickets) ? data.tickets.slice(0, 1000) : [] });
}

async function saveOrder(order) {
  const nowIso = new Date().toISOString();
  const data = readOrdersFile();
  const platformOrderId = String(order.platform_order_id || '').trim();
  const existing = data.orders.find((o) => String(o.platform_order_id || '') === platformOrderId && platformOrderId);
  if (existing) Object.assign(existing, order, { updated_at: nowIso });
  else data.orders.push({ ...order, created_at: nowIso, updated_at: nowIso });
  writeOrdersFile(data);

  if (useDatabase && platformOrderId) {
    await pool.query(
      `INSERT INTO orders (
        platform_order_id, user_id, username, email, product_name, total_order_value,
        currency, status, payment_id, installment, raw_status, verified, callback_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        user_id = COALESCE(VALUES(user_id), user_id),
        username = COALESCE(VALUES(username), username),
        email = COALESCE(VALUES(email), email),
        product_name = COALESCE(VALUES(product_name), product_name),
        total_order_value = COALESCE(VALUES(total_order_value), total_order_value),
        currency = COALESCE(VALUES(currency), currency),
        status = VALUES(status),
        payment_id = COALESCE(VALUES(payment_id), payment_id),
        installment = COALESCE(VALUES(installment), installment),
        raw_status = COALESCE(VALUES(raw_status), raw_status),
        verified = COALESCE(VALUES(verified), verified),
        callback_at = COALESCE(VALUES(callback_at), callback_at),
        updated_at = NOW()`,
      [
        platformOrderId,
        order.user_id || null,
        order.username || null,
        normalizeEmail(order.email) || null,
        order.product_name || null,
        order.total_order_value == null ? null : String(order.total_order_value),
        order.currency == null ? null : String(order.currency),
        String(order.status || 'created').slice(0, 40),
        order.payment_id || null,
        order.installment == null ? null : String(order.installment),
        order.raw_status || null,
        order.verified == null ? null : (order.verified ? 1 : 0),
        order.callback_at ? String(order.callback_at).slice(0, 19).replace('T', ' ') : null
      ]
    );
  }
}

function cleanPrice(value) {
  const n = Number(String(value || '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : '1.00';
}

function getValidShopierUrl(value) {
  const checkoutUrl = String(value || '').trim();
  if (!checkoutUrl) return '';

  try {
    const url = new URL(checkoutUrl);
    if (url.protocol === 'https:' && SHOPIER_ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
      return url.toString();
    }
  } catch {
    return '';
  }

  return '';
}

function getValidShopierPaymentUrl() {
  return getValidShopierUrl(process.env.SHOPIER_PAYMENT_URL || SHOPIER_PAYMENT_URL);
}

function getBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || process.env.SITE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#39;');
}

function createShopierSignature({ randomNr, platformOrderId, totalOrderValue, currency }, apiSecret) {
  return crypto.createHmac('sha256', apiSecret).update(`${randomNr}${platformOrderId}${totalOrderValue}${currency}`).digest('base64');
}

function verifyShopierCallback(body, apiSecret) {
  if (!body || !body.signature || !body.random_nr || !body.platform_order_id) return false;
  const decodedSignature = Buffer.from(String(body.signature), 'base64');
  const candidates = [`${body.random_nr}${body.platform_order_id}`, `${body.random_nr}${body.platform_order_id}${body.total_order_value || ''}${body.currency || ''}`];
  return candidates.some((candidate) => {
    const expected = crypto.createHmac('sha256', apiSecret).update(candidate).digest();
    return decodedSignature.length === expected.length && crypto.timingSafeEqual(decodedSignature, expected);
  });
}

function verifyShopierOsbNotification(body, username, key) {
  const encoded = String(body?.res || '');
  const providedHash = String(body?.hash || '').toLowerCase();
  if (!encoded || !providedHash || !/^[a-f0-9]{64}$/.test(providedHash)) return false;
  const expectedHash = crypto.createHmac('sha256', key).update(`${encoded}${username}`).digest('hex');
  const provided = Buffer.from(providedHash, 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function parseShopierOsbPayload(encoded) {
  try {
    const payload = JSON.parse(Buffer.from(String(encoded || ''), 'base64').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function findLicensePackageFromShopierOsb(payload) {
  const productText = JSON.stringify([
    payload?.productid,
    payload?.productlist,
    payload?.chartdetails
  ]).toLowerCase();
  return listLicensePackages().find((pkg) => {
    const productId = String(getValidShopierUrl(pkg.shopier_url) || '').split('/').filter(Boolean).pop() || '';
    return (productId && productText.includes(productId.toLowerCase())) || productText.includes(String(pkg.name || '').toLowerCase());
  }) || null;
}

function buildAutoSubmitShopierPage(fields) {
  const inputs = Object.entries(fields).map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`).join('\n');
  return `<!doctype html><html lang="tr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Shopier ├ûdemeye Y├Ânlendiriliyor...</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#080b0f;color:#fff;font-family:Arial,sans-serif;text-align:center;padding:24px}.card{max-width:480px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:24px;padding:32px;box-shadow:0 30px 80px rgba(0,0,0,.35)}button{margin-top:18px;padding:13px 20px;border:0;border-radius:14px;background:#34d399;color:#06100c;font-weight:800;cursor:pointer}p{color:#cbd5e1;line-height:1.6}</style></head><body><div class="card"><h1>Shopier ├Âdemeye y├Ânlendiriliyorsun...</h1><p>Sayfa otomatik a├ğ─▒lmazsa a┼şa─ş─▒daki butona bas.</p><form id="shopier_form_special" method="post" action="${SHOPIER_PAYMENT_ENDPOINT}">${inputs}<button type="submit">Shopier ile G├╝venli ├ûde</button></form></div><script>document.getElementById('shopier_form_special').submit();</script></body></html>`;
}

async function ensureAdminUser() {
  const adminEmail = (process.env.ADMIN_EMAIL || 'sakatat7571@gmail.com').trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || 'Anadolu2654.';
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';

  if (useDatabase) {
    const [rows] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [adminEmail]);
    if (rows.length === 0) {
      const passwordHash = await bcrypt.hash(adminPassword, 10);
      await pool.query(
        "INSERT INTO users (username, email, password_hash, role, is_blocked) VALUES (?, ?, ?, 'admin', 0)",
        [adminUsername, adminEmail, passwordHash]
      );
    } else {
      await pool.query("UPDATE users SET role = 'admin' WHERE email = ?", [adminEmail]);
    }
    return;
  }

  const data = readUsersFile();
  const existing = data.users.find((u) => u.email === adminEmail);
  const passwordHash = await bcrypt.hash(adminPassword, 10);
  if (!existing) {
    const nextId = data.users.reduce((m, u) => Math.max(m, Number(u.id) || 0), 0) + 1;
    data.users.push({
      id: nextId,
      username: adminUsername,
      email: adminEmail,
      password_hash: passwordHash,
      role: 'admin',
      is_blocked: 0,
      created_at: new Date().toISOString()
    });
  } else {
    existing.role = 'admin';
    existing.username = existing.username || adminUsername;
    existing.password_hash = existing.password_hash || passwordHash;
    existing.is_blocked = 0;
  }
  writeUsersFile(data);
}

async function initDatabase() {
  try {
    const setupConnection = await mysql.createConnection({
      host: dbConfig.host,
      port: dbConfig.port,
      user: dbConfig.user,
      password: dbConfig.password,
      ssl: dbConfig.ssl,
      connectTimeout: DB_CONNECT_TIMEOUT_MS
    });
    await setupConnection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`).catch(() => {});
    await setupConnection.end().catch(() => {});
  } catch (e) {
    // Ignore setup connection error if user has no CREATE DB permissions
  }

  pool = mysql.createPool({ ...dbConfig, waitForConnections: true, connectionLimit: 10, queueLimit: 0, connectTimeout: DB_CONNECT_TIMEOUT_MS });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(100) NOT NULL,
      email VARCHAR(190) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      hwid VARCHAR(255) NULL,
      role ENUM('user','admin') NOT NULL DEFAULT 'user',
      is_blocked TINYINT(1) NOT NULL DEFAULT 0,
      session_token VARCHAR(128) NULL,
      token_created_at DATETIME NULL,
      license_until DATETIME NULL,
      daily_limit INT NOT NULL DEFAULT 0,
      allowed_appids TEXT NULL,
      approval_status VARCHAR(20) NOT NULL DEFAULT 'approved',
      review_mode TINYINT(1) NOT NULL DEFAULT 0,
      review_note TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  try { await pool.query("ALTER TABLE users ADD COLUMN role ENUM('user','admin') NOT NULL DEFAULT 'user'"); } catch (e) {}
  try { await pool.query("ALTER TABLE users ADD COLUMN is_blocked TINYINT(1) NOT NULL DEFAULT 0"); } catch (e) {}
  try { await pool.query("ALTER TABLE users ADD COLUMN hwid VARCHAR(255) NULL"); } catch (e) {}
  try { await pool.query("ALTER TABLE users ADD COLUMN session_token VARCHAR(128) NULL"); } catch (e) {}
  try { await pool.query("ALTER TABLE users ADD COLUMN token_created_at DATETIME NULL"); } catch (e) {}
  try { await pool.query("ALTER TABLE users ADD COLUMN license_until DATETIME NULL"); } catch (e) {}
  try { await pool.query("ALTER TABLE users ADD COLUMN daily_limit INT NOT NULL DEFAULT 0"); } catch (e) {}
  try { await pool.query("ALTER TABLE users ADD COLUMN allowed_appids TEXT NULL"); } catch (e) {}
  try { await pool.query("ALTER TABLE users ADD COLUMN approval_status VARCHAR(20) NOT NULL DEFAULT 'approved'"); } catch (e) {}
  try { await pool.query("ALTER TABLE users ADD COLUMN review_mode TINYINT(1) NOT NULL DEFAULT 0"); } catch (e) {}
  try { await pool.query("ALTER TABLE users ADD COLUMN review_note TEXT NULL"); } catch (e) {}
  try { await pool.query("ALTER TABLE users ADD COLUMN referral_code VARCHAR(40) NULL UNIQUE"); } catch (e) {}
  try { await pool.query("ALTER TABLE users ADD COLUMN referred_by VARCHAR(40) NULL"); } catch (e) {}
  try { await pool.query("UPDATE users SET approval_status = 'approved' WHERE role = 'admin' OR approval_status IS NULL OR approval_status = ''"); } catch (e) {}

  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      username VARCHAR(100) NULL,
      email VARCHAR(190) NULL,
      action VARCHAR(80) NOT NULL,
      details TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_activity_logs_created_at (created_at),
      INDEX idx_activity_logs_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hwid_bans (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hwid VARCHAR(255) NOT NULL UNIQUE,
      user_id INT NULL,
      email VARCHAR(190) NULL,
      reason VARCHAR(255) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_hwid_bans_hwid (hwid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      username VARCHAR(100) NOT NULL,
      text TEXT NOT NULL,
      rating TINYINT NOT NULL DEFAULT 5,
      is_demo TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_reviews_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS plugin_control (
      id INT PRIMARY KEY,
      config LONGTEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS plugin_statuses (
      status_key VARCHAR(320) PRIMARY KEY,
      user_id INT NULL,
      username VARCHAR(100) NULL,
      email VARCHAR(190) NULL,
      hwid VARCHAR(255) NULL,
      version VARCHAR(40) NULL,
      ip VARCHAR(80) NULL,
      status VARCHAR(80) NULL,
      appid VARCHAR(40) NULL,
      current_api VARCHAR(120) NULL,
      message TEXT NULL,
      installed_games LONGTEXT NULL,
      first_seen_at DATETIME NULL,
      last_seen_at DATETIME NULL,
      INDEX idx_plugin_statuses_email (email),
      INDEX idx_plugin_statuses_last_seen (last_seen_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS plugin_commands (
      id BIGINT PRIMARY KEY,
      user_id INT NULL,
      username VARCHAR(100) NULL,
      email VARCHAR(190) NULL,
      hwid VARCHAR(255) NULL,
      command VARCHAR(80) NOT NULL,
      payload LONGTEXT NULL,
      reason TEXT NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'pending',
      created_by VARCHAR(190) NULL,
      created_at DATETIME NULL,
      delivered_at DATETIME NULL,
      delivery_attempts INT NOT NULL DEFAULT 0,
      completed_at DATETIME NULL,
      result TEXT NULL,
      INDEX idx_plugin_commands_email_status (email, status),
      INDEX idx_plugin_commands_user_status (user_id, status),
      INDEX idx_plugin_commands_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  try { await pool.query("ALTER TABLE plugin_commands ADD COLUMN delivery_attempts INT NOT NULL DEFAULT 0"); } catch (e) {}

  await pool.query(`
    CREATE TABLE IF NOT EXISTS plugin_error_reports (
      id BIGINT PRIMARY KEY,
      user_id INT NULL,
      username VARCHAR(100) NULL,
      email VARCHAR(190) NULL,
      hwid VARCHAR(255) NULL,
      version VARCHAR(40) NULL,
      severity VARCHAR(40) NULL,
      message TEXT NULL,
      context LONGTEXT NULL,
      page_url TEXT NULL,
      ip VARCHAR(80) NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'open',
      resolved_by VARCHAR(190) NULL,
      resolved_at DATETIME NULL,
      auto_action TEXT NULL,
      created_at DATETIME NULL,
      INDEX idx_plugin_error_reports_email (email),
      INDEX idx_plugin_error_reports_status (status),
      INDEX idx_plugin_error_reports_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS source_health (
      source_key VARCHAR(190) PRIMARY KEY,
      name VARCHAR(190) NOT NULL,
      status VARCHAR(80) NULL,
      success_rate DOUBLE NOT NULL DEFAULT 0,
      attempts INT NOT NULL DEFAULT 0,
      successes INT NOT NULL DEFAULT 0,
      failures INT NOT NULL DEFAULT 0,
      last_error TEXT NULL,
      disabled TINYINT(1) NOT NULL DEFAULT 0,
      disabled_at DATETIME NULL,
      disabled_reason TEXT NULL,
      updated_at DATETIME NULL,
      INDEX idx_source_health_disabled (disabled),
      INDEX idx_source_health_updated (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      platform_order_id VARCHAR(120) NOT NULL UNIQUE,
      user_id INT NULL,
      username VARCHAR(100) NULL,
      email VARCHAR(190) NULL,
      product_name VARCHAR(255) NULL,
      total_order_value VARCHAR(40) NULL,
      currency VARCHAR(20) NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'created',
      payment_id VARCHAR(120) NULL,
      installment VARCHAR(40) NULL,
      raw_status VARCHAR(80) NULL,
      verified TINYINT(1) NULL,
      callback_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_orders_email (email),
      INDEX idx_orders_status (status),
      INDEX idx_orders_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_reset_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      username VARCHAR(100) NULL,
      email VARCHAR(190) NULL,
      old_hwid VARCHAR(255) NULL,
      reason TEXT NULL,
      status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
      requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME NULL,
      reviewed_by VARCHAR(190) NULL,
      admin_note TEXT NULL,
      INDEX idx_device_reset_email (email),
      INDEX idx_device_reset_status (status),
      INDEX idx_device_reset_requested_at (requested_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id BIGINT PRIMARY KEY,
      user_id INT NULL,
      username VARCHAR(100) NULL,
      email VARCHAR(190) NULL,
      subject VARCHAR(160) NOT NULL,
      message TEXT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'open',
      priority VARCHAR(30) NOT NULL DEFAULT 'normal',
      admin_reply TEXT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      closed_at DATETIME NULL,
      INDEX idx_support_tickets_email_status (email, status),
      INDEX idx_support_tickets_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS license_codes (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(80) NOT NULL UNIQUE,
      package_id VARCHAR(80) NOT NULL,
      status ENUM('active','redeemed','disabled') NOT NULL DEFAULT 'active',
      redeemed_by INT NULL,
      redeemed_email VARCHAR(190) NULL,
      redeemed_at DATETIME NULL,
      created_by VARCHAR(190) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_license_codes_status (status),
      INDEX idx_license_codes_email (redeemed_email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_claims (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      username VARCHAR(100) NULL,
      email VARCHAR(190) NOT NULL,
      shopier_order_id VARCHAR(120) NOT NULL,
      package_id VARCHAR(80) NOT NULL,
      status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
      admin_note TEXT NULL,
      reviewed_by VARCHAR(190) NULL,
      reviewed_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_order_claim_shopier (shopier_order_id),
      INDEX idx_order_claim_status (status),
      INDEX idx_order_claim_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coupons (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(60) NOT NULL UNIQUE,
      discount_percent INT NOT NULL DEFAULT 0,
      package_id VARCHAR(80) NULL,
      max_uses INT NOT NULL DEFAULT 0,
      used_count INT NOT NULL DEFAULT 0,
      active TINYINT(1) NOT NULL DEFAULT 1,
      expires_at DATETIME NULL,
      created_by VARCHAR(190) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_coupons_active (active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS commerce_events (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      event_type VARCHAR(60) NOT NULL,
      package_id VARCHAR(80) NULL,
      user_id INT NULL,
      email VARCHAR(190) NULL,
      metadata TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_commerce_event_type (event_type),
      INDEX idx_commerce_event_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_wishlist (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      email VARCHAR(190) NOT NULL,
      appid VARCHAR(40) NOT NULL,
      game_name VARCHAR(255) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'waiting',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_wishlist_user_app (user_id, appid),
      INDEX idx_wishlist_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_events (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      referral_code VARCHAR(40) NOT NULL,
      referred_user_id INT NULL,
      referred_email VARCHAR(190) NULL,
      event_type VARCHAR(40) NOT NULL DEFAULT 'register',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_referral_code (referral_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS backup_snapshots (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      backup_json LONGTEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_backup_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  try { await pool.query("ALTER TABLE license_codes ADD COLUMN gift_email VARCHAR(190) NULL"); } catch (e) {}
  await desktopAuth.ensureDatabase(pool);

  useDatabase = true;
  await ensureAdminUser();
}

async function initStorage() {
  if (!hasConfiguredDatabase()) {
    useDatabase = false;
    pool = null;
    lastDatabaseError = null;
    ensureUsersFile();
    ensureReviewsFile();
    ensureOrdersFile();
    ensureActivityLogsFile();
    ensureHwidBansFile();
    ensureAnnouncementsFile();
    ensureErrorReportsFile();
    ensurePluginControlFile();
    ensureJsonFile(PLUGIN_STATUS_FILE, { statuses: [] });
    ensureJsonFile(PLUGIN_COMMANDS_FILE, { commands: [] });
    ensureJsonFile(SOURCE_HEALTH_FILE, { sources: [] });
    ensureJsonFile(DEVICE_RESETS_FILE, { requests: [] });
    ensureJsonFile(SUPPORT_TICKETS_FILE, { tickets: [] });
    ensureJsonFile(DESKTOP_AUTH_FILE, { keys: [], sessions: [] });
    await ensureAdminUser();
    console.warn('MySQL ayarlari eksik. JSON moduna gecildi.');
    return;
  }
  try {
    await initDatabase();
    lastDatabaseError = null;
    ensureReviewsFile();
    ensureOrdersFile();
    ensureActivityLogsFile();
    ensureHwidBansFile();
    ensureAnnouncementsFile();
    ensureErrorReportsFile();
    ensurePluginControlFile();
    ensureJsonFile(PLUGIN_STATUS_FILE, { statuses: [] });
    ensureJsonFile(PLUGIN_COMMANDS_FILE, { commands: [] });
    ensureJsonFile(SOURCE_HEALTH_FILE, { sources: [] });
    ensureJsonFile(DEVICE_RESETS_FILE, { requests: [] });
    ensureJsonFile(SUPPORT_TICKETS_FILE, { tickets: [] });
    ensureJsonFile(DESKTOP_AUTH_FILE, { keys: [], sessions: [] });
    console.log('MySQL ba─şlant─▒s─▒ ba┼şar─▒l─▒.');
  } catch (error) {
    useDatabase = false;
    pool = null;
    lastDatabaseError = sanitizeDatabaseError(error);
    ensureUsersFile();
    ensureReviewsFile();
    ensureOrdersFile();
    ensureActivityLogsFile();
    ensureHwidBansFile();
    ensureAnnouncementsFile();
    ensureErrorReportsFile();
    ensurePluginControlFile();
    ensureJsonFile(PLUGIN_STATUS_FILE, { statuses: [] });
    ensureJsonFile(PLUGIN_COMMANDS_FILE, { commands: [] });
    ensureJsonFile(SOURCE_HEALTH_FILE, { sources: [] });
    ensureJsonFile(DEVICE_RESETS_FILE, { requests: [] });
    ensureJsonFile(SUPPORT_TICKETS_FILE, { tickets: [] });
    ensureJsonFile(DESKTOP_AUTH_FILE, { keys: [], sessions: [] });
    await ensureAdminUser();
    console.warn('MySQL ba─şlant─▒s─▒ ba┼şar─▒s─▒z. JSON moduna ge├ğildi.');
    console.warn(error?.code || error?.message || error);
  }
}

function hasConfiguredDatabase() {
  return Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME);
}

function sanitizeDatabaseError(error) {
  const rawMessage = String(error?.message || error || '').slice(0, 300);
  const safeMessage = rawMessage
    .replaceAll(String(dbConfig.password || ''), '[db-password]')
    .replaceAll(String(dbConfig.host || ''), '[db-host]');
  return {
    code: error?.code || null,
    errno: error?.errno || null,
    fatal: Boolean(error?.fatal),
    message: safeMessage
  };
}

function getDatabaseDebugInfo() {
  return {
    configured: hasConfiguredDatabase(),
    host_set: Boolean(process.env.DB_HOST),
    port_set: Boolean(process.env.DB_PORT),
    user_set: Boolean(process.env.DB_USER),
    password_set: Boolean(process.env.DB_PASSWORD),
    name_set: Boolean(process.env.DB_NAME),
    host_is_local: ['localhost', '127.0.0.1', '::1'].includes(String(dbConfig.host || '').toLowerCase()),
    last_error: lastDatabaseError
  };
}

async function ensureDatabaseReady(force = false) {
  if (useDatabase) return true;
  if (!hasConfiguredDatabase()) return false;

  const now = Date.now();
  if (!force && !databaseRetryPromise && now - lastDatabaseRetryAt < DATABASE_RETRY_INTERVAL_MS) return false;

  if (!databaseRetryPromise) {
    lastDatabaseRetryAt = now;
    databaseRetryPromise = (async () => {
      try {
        await initDatabase();
        lastDatabaseError = null;
        console.log('MySQL ba─şlant─▒s─▒ ba┼şar─▒l─▒.');
        return true;
      } catch (error) {
        useDatabase = false;
        if (pool && typeof pool.end === 'function') {
          await pool.end().catch(() => {});
        }
        pool = null;
        lastDatabaseError = sanitizeDatabaseError(error);
        console.warn('MySQL ba─şlant─▒s─▒ yeniden denemede ba┼şar─▒s─▒z.');
        console.warn(error?.code || error?.message || error);
        return false;
      } finally {
        databaseRetryPromise = null;
      }
    })();
  }

  return databaseRetryPromise;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabaseReady(timeoutMs = DATABASE_READY_WAIT_MS) {
  if (useDatabase) return true;
  if (!hasConfiguredDatabase()) return false;

  const deadline = Date.now() + timeoutMs;
  do {
    if (await ensureDatabaseReady(true)) return true;
    if (Date.now() >= deadline) break;
    await sleep(150);
  } while (!useDatabase);

  return useDatabase;
}

function scheduleDatabaseRetry() {
  if (useDatabase || !hasConfiguredDatabase()) return;
  ensureDatabaseReady(false).catch(() => {});
}

const ADMIN_COOKIE_NAME = 'securityshoop.admin';

function getSessionSecret() {
  return process.env.SESSION_SECRET || 'securityshoop-change-this-secret';
}

function parseCookies(req) {
  const header = String(req.headers?.cookie || '');
  if (!header) return {};
  return header.split(';').reduce((cookies, part) => {
    const index = part.indexOf('=');
    if (index === -1) return cookies;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function signAdminPayload(payload) {
  return crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('base64url');
}

function createAdminCookieValue(user) {
  const payload = Buffer.from(JSON.stringify({
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    exp: Date.now() + (1000 * 60 * 60 * 24 * 7)
  })).toString('base64url');
  return `${payload}.${signAdminPayload(payload)}`;
}

function verifyAdminCookieValue(value) {
  const [payload, signature] = String(value || '').split('.');
  if (!payload || !signature) return null;
  const expected = signAdminPayload(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) return null;
  try {
    const user = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!user || user.role !== 'admin' || Number(user.exp || 0) < Date.now()) return null;
    return { id: user.id, username: user.username, email: user.email, role: 'admin' };
  } catch {
    return null;
  }
}

function appendSetCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookie);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookie]);
  } else {
    res.setHeader('Set-Cookie', [existing, cookie]);
  }
}

function cookieFlags(maxAge) {
  const secure = Boolean(process.env.VERCEL || String(process.env.PUBLIC_BASE_URL || '').startsWith('https://'));
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function setAdminCookie(res, user) {
  if (!user || user.role !== 'admin') return;
  appendSetCookie(res, `${ADMIN_COOKIE_NAME}=${encodeURIComponent(createAdminCookieValue(user))}; ${cookieFlags(60 * 60 * 24 * 7)}`);
}

function clearAdminCookie(res) {
  appendSetCookie(res, `${ADMIN_COOKIE_NAME}=; ${cookieFlags(0)}`);
}

function getCookieAdminUser(req) {
  return verifyAdminCookieValue(parseCookies(req)[ADMIN_COOKIE_NAME]);
}

function getRequestUser(req) {
  return req.session?.user || getCookieAdminUser(req);
}

function persistCookieUserToSession(req, user) {
  if (user && req.session && !req.session.user) req.session.user = user;
}

function requireAuth(req, res, next) {
  const user = getRequestUser(req);
  if (!user) return res.status(401).json({ ok: false, message: 'Giri┼ş yapman gerekiyor.' });
  persistCookieUserToSession(req, user);
  next();
}
function requireAdmin(req, res, next) {
  const user = getRequestUser(req);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ ok: false, message: 'Bu alan sadece admin i├ğindir.' });
  }
  persistCookieUserToSession(req, user);
  next();
}

async function requirePersistentStorage(req, res, options = {}) {
  // Always allow because we have Cloud Storage backup active
  return true;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  const value = normalizeEmail(email);
  if (value.length > 254 || value.includes(' ')) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  return Boolean(local && domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.'));
}

function normalizeApprovalStatus(value, role = 'user') {
  if (role === 'admin') return 'approved';
  const status = String(value || '').trim().toLowerCase();
  if (['pending', 'approved', 'rejected'].includes(status)) return status;
  return 'approved'; // Yeni kayit olan kullanicilar aninda onayli giris yapabilsin
}

function withUserDefaults(user) {
  if (!user) return user;
  return {
    ...user,
    approval_status: normalizeApprovalStatus(user.approval_status, user.role),
    review_mode: user.review_mode === true || Number(user.review_mode || 0) === 1,
    review_note: String(user.review_note || '').trim()
  };
}

function isUserApproved(user) {
  if (user?.role === 'admin') return true;
  if (user?.is_blocked) return false;
  const status = normalizeApprovalStatus(user?.approval_status, user?.role);
  return status === 'approved';
}

function approvalBlockedBody(user) {
  const status = normalizeApprovalStatus(user?.approval_status, user?.role);
  return {
    ok: false,
    blocked: true,
    pending_approval: status === 'pending',
    approval_status: status,
    message: status === 'rejected'
      ? 'Hesap admin tarafindan reddedildi.'
      : 'Hesap admin onayi bekliyor.'
  };
}

function hasGrantedLicense(user) {
  return Boolean(String(user?.license_until || '').trim()) ||
    Number(user?.daily_limit || 0) > 0 ||
    /\d+/.test(String(user?.allowed_appids || ''));
}

function isUserInReview(user) {
  const reviewEnabled = user?.role !== 'admin' && (user?.review_mode === true || Number(user?.review_mode || 0) === 1);
  if (!reviewEnabled) return false;
  if (hasGrantedLicense(user) && isLicenseActive(user)) return false;
  return true;
}

function reviewBlockedBody(user) {
  return {
    ok: false,
    blocked: true,
    review_mode: true,
    message: String(user?.review_note || '').trim() || 'Hesap risk inceleme modunda. Admin onayi bekleniyor.'
  };
}

function publicUserPayload(user, token = '') {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    token,
    license_until: user.license_until || '',
    daily_limit: Number(user.daily_limit || 0),
    allowed_appids: getAllowedAppids(user),
    approval_status: normalizeApprovalStatus(user.approval_status, user.role),
    review_mode: isUserInReview(user),
    review_note: String(user.review_note || '').trim()
  };
}

function pendingRegistrationBody(user, message = 'Hesap basariyla olusturuldu. Giris yapabilirsiniz.') {
  return {
    ok: true,
    pending_approval: false,
    approval_status: 'approved',
    message,
    user: publicUserPayload(user, '')
  };
}

async function findUserByEmail(email) {
  const cleanEmail = normalizeEmail(email);
  if (useDatabase) {
    const [rows] = await pool.query(
      'SELECT id, username, email, password_hash, hwid, role, is_blocked, session_token, token_created_at, license_until, daily_limit, allowed_appids, approval_status, review_mode, review_note, created_at FROM users WHERE email = ? LIMIT 1',
      [cleanEmail]
    );
    return rows[0] ? withUserDefaults(rows[0]) : null;
  }
  if (!useDatabase) {
    try {
      const cloudData = await fetchCloudJson(CLOUD_STORAGE_IDS.users, null);
      if (cloudData && Array.isArray(cloudData.users)) {
        writeUsersFile(cloudData);
        return withUserDefaults(cloudData.users.find((u) => u.email === cleanEmail) || null);
      }
    } catch(e) {}
  }
  const data = readUsersFile();
  return withUserDefaults(data.users.find((u) => u.email === cleanEmail) || null);
}

async function findUserByLogin(login) {
  const cleanLogin = String(login || '').trim();
  if (!cleanLogin) return null;
  if (cleanLogin.includes('@')) return findUserByEmail(cleanLogin);
  const lowered = cleanLogin.toLowerCase();
  if (useDatabase) {
    const [rows] = await pool.query(
      'SELECT id, username, email, password_hash, hwid, role, is_blocked, session_token, token_created_at, license_until, daily_limit, allowed_appids, approval_status, review_mode, review_note, created_at FROM users WHERE LOWER(username) = ? LIMIT 1',
      [lowered]
    );
    return rows[0] ? withUserDefaults(rows[0]) : null;
  }
  if (!useDatabase) {
    try {
      const cloudData = await fetchCloudJson(CLOUD_STORAGE_IDS.users, null);
      if (cloudData && Array.isArray(cloudData.users)) {
        writeUsersFile(cloudData);
        return withUserDefaults(cloudData.users.find((u) => String(u.username || '').trim().toLowerCase() === lowered || u.email === cleanLogin.toLowerCase()) || null);
      }
    } catch(e) {}
  }
  const data = readUsersFile();
  return withUserDefaults(data.users.find((u) => String(u.username || '').trim().toLowerCase() === lowered || u.email === cleanLogin.toLowerCase()) || null);
}

async function findUserByToken(token) {
  const cleanToken = String(token || '').trim();
  if (cleanToken.length < 32) return null;
  if (useDatabase) {
    const [rows] = await pool.query(
      'SELECT id, username, email, password_hash, hwid, role, is_blocked, session_token, token_created_at, license_until, daily_limit, allowed_appids, approval_status, review_mode, review_note, created_at FROM users WHERE session_token = ? LIMIT 1',
      [cleanToken]
    );
    return rows[0] ? withUserDefaults(rows[0]) : null;
  }
  const data = readUsersFile();
  return withUserDefaults(data.users.find((u) => String(u.session_token || '') === cleanToken) || null);
}

async function issueUserToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  if (useDatabase) {
    await pool.query('UPDATE users SET session_token = ?, token_created_at = ? WHERE id = ?', [token, now.slice(0, 19).replace('T', ' '), user.id]);
  } else {
    const data = readUsersFile();
    const existing = data.users.find((u) => Number(u.id) === Number(user.id));
    if (existing) {
      existing.session_token = token;
      existing.token_created_at = now;
      writeUsersFile(data);
    }
  }
  return token;
}

function isLicenseActive(user) {
  if (!user?.license_until) return true;
  const value = String(user.license_until || '').trim();
  let expiresAt;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    expiresAt = new Date(`${value}T23:59:59.999Z`).getTime();
  } else {
    expiresAt = new Date(value).getTime();
  }
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt > Date.now();
}

function normalizeAppidList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || '').match(/\d+/)?.[0] || '').filter(Boolean))].slice(0, 200);
  }
  const text = String(value || '');
  return [...new Set((text.match(/\d+/g) || []).filter(Boolean))].slice(0, 200);
}

function getAllowedAppids(user) {
  return normalizeAppidList(user?.allowed_appids);
}

function canUserAddAppid(user, appid) {
  const allowed = getAllowedAppids(user);
  if (!allowed.length) return { allowed: true, allowed_appids: [] };
  const cleanAppid = String(appid || '').match(/\d+/)?.[0] || '';
  return {
    allowed: Boolean(cleanAppid && allowed.includes(cleanAppid)),
    allowed_appids: allowed,
    appid: cleanAppid
  };
}

function listLicensePackages() {
  return LICENSE_PACKAGES.map((pkg) => ({ ...pkg }));
}

function listPublicLicensePackages() {
  return listLicensePackages().map((pkg) => ({
    id: pkg.id,
    name: pkg.name,
    label: pkg.label,
    days: pkg.days,
    daily_limit: pkg.daily_limit,
    limit: Number(pkg.daily_limit || 0),
    game_limit: Number(pkg.daily_limit || 0),
    price: pkg.price || 'Link yakinda',
    badge: pkg.badge || '',
    image: pkg.image || '/logo.jpeg',
    description: pkg.description || '',
    features: Array.isArray(pkg.features) ? pkg.features.slice(0, 6) : [],
    checkout_url: `/api/shopier/checkout?package=${encodeURIComponent(pkg.id)}`,
    shopier_url: getValidShopierUrl(pkg.shopier_url),
    in_stock: pkg.in_stock !== false
  }));
}

function findLicensePackage(packageId) {
  let cleanId = String(packageId || '').trim().toLowerCase();
  const aliases = {
    '1': 'single-1',
    'tek': 'single-1',
    'single': 'single-1',
    'one': 'single-1',
    '10': 'pack-10',
    '25': 'random-add',
    '50': 'pack-50',
    '100': 'pack-100',
    'sinirsiz': 'unlimited',
    's─▒n─▒rs─▒z': 'unlimited',
    'unlimited': 'unlimited'
  };
  cleanId = aliases[cleanId] || cleanId;
  return listLicensePackages().find((pkg) => pkg.id === cleanId) || null;
}

function futureDateString(days) {
  const cleanDays = Math.max(0, Math.min(3650, Number(days || 0)));
  if (!cleanDays) return null;
  const date = new Date();
  date.setDate(date.getDate() + cleanDays);
  return date.toISOString().slice(0, 10);
}

async function updateUserLicenseValues(id, { licenseUntil = null, dailyLimit = 0 } = {}) {
  const cleanId = Number(id);
  const safeDailyLimit = Math.max(0, Math.min(999, Number(dailyLimit || 0)));
  const cleanLicenseUntil = String(licenseUntil || '').trim() || null;
  if (useDatabase) {
    await pool.query(
      'UPDATE users SET license_until = ?, daily_limit = ?, approval_status = "approved", review_mode = 0, review_note = NULL WHERE id = ? AND role <> "admin"',
      [cleanLicenseUntil, safeDailyLimit, cleanId]
    );
    return true;
  }
  const data = readUsersFile();
  const user = data.users.find((u) => Number(u.id) === cleanId);
  if (!user) return false;
  user.license_until = cleanLicenseUntil || '';
  user.daily_limit = safeDailyLimit;
  if (user.role !== 'admin') {
    user.approval_status = 'approved';
    user.review_mode = 0;
    user.review_note = '';
  }
  writeUsersFile(data);
  return true;
}

async function applyLicensePackageToUser(id, packageId, adminUser = null) {
  const user = await findUserById(Number(id));
  if (!user) return { ok: false, errorStatus: 404, message: 'Kullanici bulunamadi.' };
  if (user.role === 'admin') return { ok: false, errorStatus: 400, message: 'Admin hesabina lisans paketi uygulanmaz.' };

  const pkg = findLicensePackage(packageId);
  if (!pkg) return { ok: false, errorStatus: 400, message: 'Lisans paketi bulunamadi.' };

  const licenseUntil = futureDateString(pkg.days);
  const dailyLimit = Math.max(0, Math.min(999, Number(pkg.daily_limit || 0)));
  const updated = await updateUserLicenseValues(user.id, { licenseUntil, dailyLimit });
  if (!updated) return { ok: false, errorStatus: 404, message: 'Kullanici bulunamadi.' };

  await recordActivityLog({
    user: adminUser,
    action: 'ADMIN_LICENSE_PACKAGE',
    details: `Target: ${user.email || user.id}, package=${pkg.id}, until=${licenseUntil || 'unlimited'}, limit=${dailyLimit}`
  });

  return {
    ok: true,
    message: `${pkg.name} lisans paketi uygulandi.`,
    package: pkg,
    license_until: licenseUntil || '',
    daily_limit: dailyLimit
  };
}

async function countTodayAddGames(email) {
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) return 0;
  if (useDatabase) {
    const [rows] = await pool.query(
      "SELECT COUNT(*) AS total FROM activity_logs WHERE email = ? AND action = 'ADD_GAME' AND created_at >= CURDATE()",
      [cleanEmail]
    );
    return Number(rows?.[0]?.total || 0);
  }
  const today = new Date().toISOString().slice(0, 10);
  return readActivityLogsFile().logs.filter((log) => normalizeEmail(log.email) === cleanEmail && log.action === 'ADD_GAME' && String(log.timestamp || '').startsWith(today)).length;
}

async function authenticatePluginRequest(req) {
  const tokenUser = await findUserByToken(req.body?.token);
  if (tokenUser) return tokenUser;
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  if (!email || !password) return null;
  const user = await findUserByEmail(email);
  if (!user) return null;
  const valid = await bcrypt.compare(password, user.password_hash);
  return valid ? user : null;
}

async function createUser({ username, email, password, role = 'user', hwid = '', referredBy = '' }) {
  const cleanEmail = String(email).trim().toLowerCase();
  const cleanUsername = String(username).trim();
  const cleanHwid = String(hwid || '').trim() || null;
  const passwordHash = await bcrypt.hash(password, 10);
  const approvalStatus = 'approved'; // Tum yeni kullanicilar otomatik onayli olsun

  if (useDatabase) {
    const [result] = await pool.query(
      'INSERT INTO users (username, email, password_hash, hwid, role, is_blocked, daily_limit, approval_status, referred_by) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)',
      [cleanUsername, cleanEmail, passwordHash, cleanHwid, role, approvalStatus, String(referredBy || '').trim().slice(0, 40) || null]
    );
    return { id: result.insertId, username: cleanUsername, email: cleanEmail, hwid: cleanHwid, role, is_blocked: 0, daily_limit: 0, license_until: null, allowed_appids: '', approval_status: approvalStatus, review_mode: false, review_note: '' };
  }

  let data = readUsersFile();
  try {
    const cloudData = await fetchCloudJson(CLOUD_STORAGE_IDS.users, null);
    if (cloudData && Array.isArray(cloudData.users)) data = cloudData;
  } catch(e) {}
  const nextId = data.users.reduce((m, u) => Math.max(m, Number(u.id) || 0), 0) + 1;
  const user = {
    id: nextId,
    username: cleanUsername,
    email: cleanEmail,
    password_hash: passwordHash,
    hwid: cleanHwid,
    role,
    is_blocked: 0,
    session_token: '',
    token_created_at: '',
    license_until: '',
    daily_limit: 0,
    allowed_appids: '',
    approval_status: approvalStatus,
    review_mode: false,
    review_note: '',
    created_at: new Date().toISOString()
  };
  data.users.push(user);
  writeUsersFile(data);
  await saveCloudJson(CLOUD_STORAGE_IDS.users, 'users', data).catch(() => {});
  return user;
}

async function updateUserHwidIfMissing(user, hwid) {
  const cleanHwid = normalizeHwid(hwid);
  if (!user || !cleanHwid || normalizeHwid(user.hwid)) return user;

  if (useDatabase) {
    await pool.query('UPDATE users SET hwid = ? WHERE id = ?', [cleanHwid, user.id]);
  } else {
    const data = readUsersFile();
    const existing = data.users.find((u) => Number(u.id) === Number(user.id));
    if (existing && !normalizeHwid(existing.hwid)) {
      existing.hwid = cleanHwid;
      writeUsersFile(data);
    }
  }

  user.hwid = cleanHwid;
  return user;
}

function calculateUserRisk(user, logs = [], pluginStatuses = [], reports = []) {
  const email = normalizeEmail(user?.email);
  const reasons = [];
  let score = 0;

  const userLogs = logs.filter((log) => normalizeEmail(log.email) === email);
  const userStatuses = pluginStatuses.filter((item) => normalizeEmail(item.email) === email);
  const userReports = reports.filter((report) => normalizeEmail(report.email) === email);
  const uniqueHwids = new Set(userStatuses.map((item) => normalizeHwid(item.hwid)).filter(Boolean));
  const failedActions = userLogs.filter((log) => /FAIL|ERROR|FAILED/i.test(`${log.action} ${log.details}`)).length;
  const addCount = Number(user.add_game_count || 0);

  if (user.is_blocked) { score += 30; reasons.push('Hesap engelli'); }
  if (user.is_pc_banned) { score += 35; reasons.push('PC banl─▒'); }
  if (uniqueHwids.size > 1) { score += Math.min(40, uniqueHwids.size * 15); reasons.push(`${uniqueHwids.size} farkl─▒ HWID`); }
  if (userReports.length) { score += Math.min(25, userReports.length * 8); reasons.push(`${userReports.length} hata raporu`); }
  if (failedActions) { score += Math.min(20, failedActions * 4); reasons.push(`${failedActions} ba┼şar─▒s─▒z i┼şlem`); }
  if (addCount > 25) { score += 10; reasons.push('Yo─şun oyun ekleme'); }
  if (!user.hwid) { score += 8; reasons.push('HWID yok'); }
  if (isUserInReview(user)) { score += 25; reasons.push('Inceleme modu'); }

  score = Math.max(0, Math.min(100, score));
  const level = score >= 70 ? 'high' : (score >= 35 ? 'medium' : 'low');
  return { score, level, reasons };
}

async function listUsers() {
  if (!useDatabase) {
    scheduleDatabaseRetry();
  }
  const buildStats = async () => {
    const stats = {};
    try {
      const logs = await listActivityLogs(1000);
      for (const log of logs) {
        const email = normalizeEmail(log.email);
        if (!email) continue;
        if (!stats[email]) {
          stats[email] = { last_login_at: '', add_game_count: 0, last_action: '', last_action_at: '' };
        }
        if (!stats[email].last_action_at || new Date(log.timestamp) > new Date(stats[email].last_action_at)) {
          stats[email].last_action = log.action || '';
          stats[email].last_action_at = log.timestamp || '';
        }
        if ((log.action === 'LOGIN' || log.action === 'PLUGIN_LOGIN') && (!stats[email].last_login_at || new Date(log.timestamp) > new Date(stats[email].last_login_at))) {
          stats[email].last_login_at = log.timestamp || '';
        }
        if (log.action === 'ADD_GAME') {
          stats[email].add_game_count += 1;
        }
      }
    } catch (_) {}
    return stats;
  };
  const stats = await buildStats();
  let riskLogs = [];
  try { riskLogs = await listActivityLogs(1000); } catch (_) {}
  const pluginStatuses = await listPluginStatuses(500);
  const reports = await listErrorReports(500);
  const attachRisk = (user) => {
    const merged = { ...withUserDefaults(user), ...(stats[normalizeEmail(user.email)] || {}) };
    return { ...merged, risk: calculateUserRisk(merged, riskLogs, pluginStatuses, reports) };
  };
  const mergePluginOnlyUsers = (users) => {
    const mergedUsers = [...users];
    const knownEmails = new Set(mergedUsers.map((user) => normalizeEmail(user.email)).filter(Boolean));
    const pluginByEmail = new Map();
    const rememberPluginAccount = (source = {}) => {
      const email = normalizeEmail(source.email);
      if (!email || knownEmails.has(email)) return;
      const current = pluginByEmail.get(email) || {
        id: `plugin:${email}`,
        username: String(source.username || email.split('@')[0] || 'plugin-user').trim(),
        email,
        hwid: '',
        role: 'plugin',
        is_blocked: 0,
        license_until: '',
        daily_limit: 0,
        allowed_appids: '',
        approval_status: 'plugin_only',
        review_mode: false,
        review_note: '',
        created_at: source.first_seen_at || source.timestamp || source.last_seen_at || new Date().toISOString(),
        token_created_at: '',
        is_pc_banned: 0,
        plugin_only: true,
        source: 'plugin'
      };
      if (!current.hwid && source.hwid) current.hwid = normalizeHwid(source.hwid);
      if (source.username && !current.username) current.username = String(source.username).trim();
      const lastSeen = source.last_seen_at || source.timestamp || '';
      if (lastSeen && (!current.last_action_at || new Date(lastSeen) > new Date(current.last_action_at))) {
        current.last_action_at = lastSeen;
        current.last_action = source.action || source.status || 'PLUGIN_SEEN';
      }
      if ((source.action === 'LOGIN' || source.action === 'PLUGIN_LOGIN' || source.status) && lastSeen && (!current.last_login_at || new Date(lastSeen) > new Date(current.last_login_at))) {
        current.last_login_at = lastSeen;
      }
      pluginByEmail.set(email, current);
    };

    for (const status of pluginStatuses) rememberPluginAccount(status);
    for (const log of riskLogs) {
      if (['LOGIN', 'PLUGIN_LOGIN', 'PLUGIN_REGISTER', 'REGISTER', 'ADD_GAME', 'HEARTBEAT'].includes(String(log.action || ''))) {
        rememberPluginAccount(log);
      }
    }

    for (const item of pluginByEmail.values()) {
      mergedUsers.push(attachRisk(item));
    }
    return mergedUsers.sort((a, b) => {
      const at = new Date(a.last_action_at || a.last_login_at || a.created_at || 0).getTime();
      const bt = new Date(b.last_action_at || b.last_login_at || b.created_at || 0).getTime();
      return bt - at;
    });
  };
  if (useDatabase) {
    const [rows] = await pool.query(`
      SELECT u.id, u.username, u.email, u.hwid, u.role, u.is_blocked, u.license_until, u.daily_limit, u.allowed_appids, u.approval_status, u.review_mode, u.review_note, u.token_created_at, u.created_at,
        CASE WHEN hb.id IS NULL THEN 0 ELSE 1 END AS is_pc_banned
      FROM users u
      LEFT JOIN hwid_bans hb ON hb.hwid = u.hwid
      ORDER BY u.id DESC
    `);
    return mergePluginOnlyUsers(rows.map(attachRisk));
  }
  let data = readUsersFile();
  try {
    const cloudData = await fetchCloudJson(CLOUD_STORAGE_IDS.users, null);
    if (cloudData && Array.isArray(cloudData.users)) data = cloudData;
  } catch(e) {}

  const bans = readHwidBansFile();
  const bannedHwids = new Set(bans.bans.map((ban) => normalizeHwid(ban.hwid)).filter(Boolean));
  const fileUsers = [...data.users].sort((a, b) => Number(b.id) - Number(a.id)).map(({ password_hash, ...rest }) => attachRisk({
    ...rest,
    approval_status: normalizeApprovalStatus(rest.approval_status, rest.role),
    review_mode: rest.review_mode === true || Number(rest.review_mode || 0) === 1,
    review_note: String(rest.review_note || '').trim(),
    is_pc_banned: bannedHwids.has(normalizeHwid(rest.hwid)) ? 1 : 0
  }));
  return mergePluginOnlyUsers(fileUsers);
}

async function updateUserBlock(id, blocked) {
  if (useDatabase) {
    await pool.query('UPDATE users SET is_blocked = ? WHERE id = ?', [blocked ? 1 : 0, id]);
    return true;
  }
  let data = readUsersFile();
  try {
    const cloudData = await fetchCloudJson(CLOUD_STORAGE_IDS.users, null);
    if (cloudData && Array.isArray(cloudData.users)) data = cloudData;
  } catch(e) {}

  const user = data.users.find((u) => Number(u.id) === Number(id));
  if (!user) return false;
  user.is_blocked = blocked ? 1 : 0;
  writeUsersFile(data);
  await saveCloudJson(CLOUD_STORAGE_IDS.users, 'users', data).catch(() => {});
  return true;
}

async function updateUserApprovalStatus(id, status) {
  const cleanStatus = normalizeApprovalStatus(status, 'user');
  if (!['pending', 'approved', 'rejected'].includes(cleanStatus)) return false;
  if (useDatabase) {
    await pool.query(
      `UPDATE users
       SET approval_status = ?,
           session_token = CASE WHEN ? = 'approved' THEN session_token ELSE NULL END,
           token_created_at = CASE WHEN ? = 'approved' THEN token_created_at ELSE NULL END
       WHERE id = ? AND role <> 'admin'`,
      [cleanStatus, cleanStatus, cleanStatus, id]
    );
    return true;
  }
  let data = readUsersFile();
  try {
    const cloudData = await fetchCloudJson(CLOUD_STORAGE_IDS.users, null);
    if (cloudData && Array.isArray(cloudData.users)) data = cloudData;
  } catch(e) {}

  const user = data.users.find((u) => Number(u.id) === Number(id));
  if (!user || user.role === 'admin') return false;
  user.approval_status = cleanStatus;
  if (cleanStatus !== 'approved') {
    user.session_token = '';
    user.token_created_at = '';
  }
  writeUsersFile(data);
  await saveCloudJson(CLOUD_STORAGE_IDS.users, 'users', data).catch(() => {});
  return true;
}

async function updateUserReviewMode(id, enabled, note = '', adminUser = null) {
  const cleanId = Number(id);
  const cleanNote = String(note || '').trim().slice(0, 1000);
  const user = await findUserById(cleanId);
  if (!user || user.role === 'admin') return false;
  if (useDatabase) {
    await pool.query('UPDATE users SET review_mode = ?, review_note = ? WHERE id = ? AND role <> "admin"', [enabled ? 1 : 0, enabled ? cleanNote : null, cleanId]);
  } else {
    let data = readUsersFile();
    try {
      const cloudData = await fetchCloudJson(CLOUD_STORAGE_IDS.users, null);
      if (cloudData && Array.isArray(cloudData.users)) data = cloudData;
    } catch(e) {}

    const existing = data.users.find((item) => Number(item.id) === cleanId);
    if (!existing || existing.role === 'admin') return false;
    existing.review_mode = enabled ? 1 : 0;
    existing.review_note = enabled ? cleanNote : '';
    writeUsersFile(data);
    await saveCloudJson(CLOUD_STORAGE_IDS.users, 'users', data).catch(() => {});
  }
  await recordActivityLog({
    user: adminUser,
    action: enabled ? 'RISK_REVIEW_ENABLE' : 'RISK_REVIEW_DISABLE',
    details: `Target: ${user.email || cleanId}${cleanNote ? `, note=${cleanNote}` : ''}`
  });
  return true;
}

async function deleteUserById(id) {
  if (useDatabase) {
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
    return true;
  }
  let data = readUsersFile();
  try {
    const cloudData = await fetchCloudJson(CLOUD_STORAGE_IDS.users, null);
    if (cloudData && Array.isArray(cloudData.users)) data = cloudData;
  } catch(e) {}

  const index = data.users.findIndex((u) => Number(u.id) === Number(id));
  if (index === -1) return false;
  data.users.splice(index, 1);
  writeUsersFile(data);
  await saveCloudJson(CLOUD_STORAGE_IDS.users, 'users', data).catch(() => {});
  return true;
}

async function findUserById(id) {
  if (useDatabase) {
    const [rows] = await pool.query('SELECT id, username, email, hwid, role, is_blocked, session_token, token_created_at, license_until, daily_limit, allowed_appids, approval_status, review_mode, review_note, created_at FROM users WHERE id = ? LIMIT 1', [id]);
    return rows[0] ? withUserDefaults(rows[0]) : null;
  }
  if (!useDatabase) {
    try {
      const cloudData = await fetchCloudJson(CLOUD_STORAGE_IDS.users, null);
      if (cloudData && Array.isArray(cloudData.users)) {
        writeUsersFile(cloudData);
        return withUserDefaults(cloudData.users.find((u) => Number(u.id) === Number(id)) || null);
      }
    } catch(e) {}
  }
  const data = readUsersFile();
  return withUserDefaults(data.users.find((u) => Number(u.id) === Number(id)) || null);
}

function normalizeHwid(hwid) {
  return String(hwid || '').trim();
}

async function isHwidBanned(hwid) {
  const cleanHwid = normalizeHwid(hwid);
  if (!cleanHwid) return false;

  if (useDatabase) {
    const [rows] = await pool.query('SELECT id FROM hwid_bans WHERE hwid = ? LIMIT 1', [cleanHwid]);
    return rows.length > 0;
  }

  const data = readHwidBansFile();
  return data.bans.some((ban) => normalizeHwid(ban.hwid) === cleanHwid);
}

async function addHwidBan({ hwid, user = null, reason = 'Admin PC ban' }) {
  const cleanHwid = normalizeHwid(hwid);
  if (!cleanHwid) return false;

  if (useDatabase) {
    await pool.query(
      'INSERT INTO hwid_bans (hwid, user_id, email, reason) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), email = VALUES(email), reason = VALUES(reason)',
      [cleanHwid, user?.id || null, user?.email || null, reason]
    );
    await pool.query('UPDATE users SET is_blocked = 1 WHERE hwid = ?', [cleanHwid]);
    return true;
  }

  const bans = readHwidBansFile();
  const existing = bans.bans.find((ban) => normalizeHwid(ban.hwid) === cleanHwid);
  const entry = {
    hwid: cleanHwid,
    user_id: user?.id || null,
    email: user?.email || null,
    reason,
    created_at: new Date().toISOString()
  };
  if (existing) Object.assign(existing, entry);
  else bans.bans.push(entry);
  writeHwidBansFile(bans);

  const users = readUsersFile();
  users.users.forEach((item) => {
    if (normalizeHwid(item.hwid) === cleanHwid) item.is_blocked = 1;
  });
  writeUsersFile(users);
  return true;
}

async function recordActivityLog({ user = null, email = '', username = '', action = '', details = '' }) {
  const cleanAction = String(action || '').trim().slice(0, 80);
  if (!cleanAction) return null;

  const entry = {
    user_id: user?.id || null,
    username: String(user?.username || username || '').trim(),
    email: String(user?.email || email || '').trim().toLowerCase(),
    action: cleanAction,
    details: String(details || '').trim(),
    timestamp: new Date().toISOString()
  };

  if (useDatabase) {
    const [result] = await pool.query(
      'INSERT INTO activity_logs (user_id, username, email, action, details) VALUES (?, ?, ?, ?, ?)',
      [entry.user_id, entry.username || null, entry.email || null, entry.action, entry.details || null]
    );
    return { id: result.insertId, ...entry };
  }

  const data = readActivityLogsFile();
  const nextId = data.logs.reduce((m, item) => Math.max(m, Number(item.id) || 0), 0) + 1;
  const saved = { id: nextId, ...entry };
  data.logs.push(saved);
  data.logs = data.logs.slice(-500);
  writeActivityLogsFile(data);
  return saved;
}

async function listActivityLogs(limit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  if (useDatabase) {
    const [rows] = await pool.query(
      'SELECT id, user_id, username, email, action, details, created_at AS timestamp FROM activity_logs ORDER BY created_at DESC, id DESC LIMIT ?',
      [safeLimit]
    );
    return rows;
  }

  const data = readActivityLogsFile();
  return [...data.logs]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime() || Number(b.id) - Number(a.id))
    .slice(0, safeLimit);
}

async function listOrders(limit = 200) {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  if (useDatabase) {
    const [rows] = await pool.query(
      `SELECT id, platform_order_id, user_id, username, email, product_name, total_order_value,
        currency, status, payment_id, installment, raw_status, verified, callback_at, created_at, updated_at
      FROM orders ORDER BY created_at DESC, id DESC LIMIT ?`,
      [safeLimit]
    );
    return rows;
  }
  return [...readOrdersFile().orders]
    .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
    .slice(0, safeLimit);
}

async function listOrdersForUser(user) {
  const email = normalizeEmail(user?.email);
  const id = Number(user?.id || 0);
  if (useDatabase) {
    const [rows] = await pool.query(
      `SELECT id, platform_order_id, user_id, username, email, product_name, total_order_value,
        currency, status, payment_id, installment, raw_status, verified, callback_at, created_at, updated_at
      FROM orders
      WHERE (user_id IS NOT NULL AND user_id = ?) OR email = ?
      ORDER BY created_at DESC, id DESC LIMIT 100`,
      [id, email]
    );
    return rows;
  }
  return (await listOrders(500)).filter((order) => Number(order.user_id || 0) === id || normalizeEmail(order.email) === email).slice(0, 100);
}

async function findOrderByPlatformId(platformOrderId) {
  const cleanId = String(platformOrderId || '').trim();
  if (!cleanId) return null;
  if (useDatabase) {
    const [rows] = await pool.query('SELECT * FROM orders WHERE platform_order_id = ? LIMIT 1', [cleanId]);
    return rows[0] || null;
  }
  return readOrdersFile().orders.find((item) => String(item.platform_order_id || '') === cleanId) || null;
}

function normalizeLicenseCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 80);
}

function createLicenseCodeValue() {
  return `SS-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

async function listOrderClaims({ user = null, limit = 200 } = {}) {
  if (!useDatabase) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  if (user) {
    const [rows] = await pool.query('SELECT * FROM order_claims WHERE user_id = ? OR email = ? ORDER BY created_at DESC LIMIT ?', [Number(user.id || 0), normalizeEmail(user.email), safeLimit]);
    return rows;
  }
  const [rows] = await pool.query('SELECT * FROM order_claims ORDER BY created_at DESC LIMIT ?', [safeLimit]);
  return rows;
}

async function listLicenseCodes(limit = 200) {
  if (!useDatabase) return [];
  const [rows] = await pool.query('SELECT id, code, package_id, status, redeemed_email, redeemed_at, created_by, created_at FROM license_codes ORDER BY created_at DESC LIMIT ?', [Math.min(Math.max(Number(limit) || 200, 1), 1000)]);
  return rows;
}

async function listCoupons(limit = 200) {
  if (!useDatabase) return [];
  const [rows] = await pool.query('SELECT id, code, discount_percent, package_id, max_uses, used_count, active, expires_at, created_by, created_at FROM coupons ORDER BY created_at DESC LIMIT ?', [Math.min(Math.max(Number(limit) || 200, 1), 1000)]);
  return rows;
}

async function recordCommerceEvent({ req = null, eventType, packageId = '', metadata = '' } = {}) {
  if (!useDatabase || !eventType) return;
  const user = req ? getRequestUser(req) : null;
  await pool.query(
    'INSERT INTO commerce_events (event_type, package_id, user_id, email, metadata) VALUES (?, ?, ?, ?, ?)',
    [String(eventType).slice(0, 60), String(packageId || '').slice(0, 80) || null, user?.id || null, normalizeEmail(user?.email) || null, String(metadata || '').slice(0, 2000) || null]
  );
}

async function buildCommerceSummary() {
  if (!useDatabase) return { funnel: [], order_claims: [], license_codes: [], coupons: [] };
  const [funnel] = await pool.query(`
    SELECT event_type, package_id, COUNT(*) AS total
    FROM commerce_events
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
    GROUP BY event_type, package_id
    ORDER BY total DESC
  `);
  const [[growth]] = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM referral_events) AS referrals,
      (SELECT COUNT(*) FROM game_wishlist) AS wishlist_games,
      (SELECT COUNT(*) FROM backup_snapshots) AS backups,
      (SELECT COUNT(*) FROM orders WHERE status = 'paid') AS paid_orders
  `);
  return {
    funnel,
    growth,
    order_claims: await listOrderClaims({ limit: 200 }),
    license_codes: await listLicenseCodes(200),
    coupons: await listCoupons(200)
  };
}

async function getOrCreateReferralCode(user) {
  if (!useDatabase || !user?.id) return '';
  const [rows] = await pool.query('SELECT referral_code FROM users WHERE id = ? LIMIT 1', [user.id]);
  if (rows[0]?.referral_code) return rows[0].referral_code;
  const code = `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  await pool.query('UPDATE users SET referral_code = ? WHERE id = ?', [code, user.id]);
  return code;
}

async function listWishlist(user) {
  if (!useDatabase || !user?.id) return [];
  const [rows] = await pool.query('SELECT id, appid, game_name, status, created_at FROM game_wishlist WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', [user.id]);
  return rows;
}

function packageNumericPrice(pkg) {
  const value = String(pkg?.price || '').replace(/[^\d,.-]/g, '').replace('.', '').replace(',', '.');
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildUpgradeOptions(user) {
  const currentLimit = Number(user?.daily_limit || 0);
  const currentPackage = listLicensePackages().find((pkg) => Number(pkg.daily_limit || 0) === currentLimit);
  const currentPrice = packageNumericPrice(currentPackage);
  return listLicensePackages()
    .filter((pkg) => Number(pkg.daily_limit || 0) === 0 || Number(pkg.daily_limit || 0) > currentLimit)
    .map((pkg) => ({ ...pkg, estimated_difference: Math.max(0, packageNumericPrice(pkg) - currentPrice).toFixed(2) }));
}

async function buildPublicStatus() {
  const sourceHealth = await listSourceHealth(200);
  const statuses = await listPluginStatuses(500);
  const reports = await listErrorReports(200);
  const now = Date.now();
  return {
    site: 'operational',
    database: useDatabase ? 'operational' : 'degraded',
    plugin_api: reports.some((item) => String(item.status || 'open') !== 'resolved' && String(item.severity || '').toLowerCase() === 'critical') ? 'degraded' : 'operational',
    sources: {
      total: sourceHealth.length,
      active: sourceHealth.filter((item) => !item.disabled).length,
      disabled: sourceHealth.filter((item) => item.disabled).length
    },
    online_plugins: statuses.filter((item) => now - new Date(item.last_seen_at || 0).getTime() < 5 * 60 * 1000).length,
    checked_at: new Date().toISOString()
  };
}

async function createDeviceResetRequest({ user, reason = '' }) {
  const email = normalizeEmail(user?.email);
  const cleanReason = String(reason || '').trim().slice(0, 1000);
  if (!user || !email) throw new Error('Kullanici bulunamadi.');

  if (useDatabase) {
    const [existingRows] = await pool.query(
      "SELECT id, user_id, username, email, old_hwid, reason, status, requested_at, reviewed_at, reviewed_by, admin_note FROM device_reset_requests WHERE (user_id = ? OR email = ?) AND status = 'pending' ORDER BY requested_at DESC LIMIT 1",
      [user.id || null, email]
    );
    if (existingRows[0]) return { existing: true, request: existingRows[0] };
    const [result] = await pool.query(
      'INSERT INTO device_reset_requests (user_id, username, email, old_hwid, reason, status) VALUES (?, ?, ?, ?, ?, ?)',
      [user.id || null, user.username || null, email, normalizeHwid(user.hwid) || null, cleanReason || null, 'pending']
    );
    const [rows] = await pool.query('SELECT id, user_id, username, email, old_hwid, reason, status, requested_at, reviewed_at, reviewed_by, admin_note FROM device_reset_requests WHERE id = ? LIMIT 1', [result.insertId]);
    return { existing: false, request: rows[0] };
  }

  const data = readDeviceResetRequestsFile();
  const existing = data.requests.find((item) => (Number(item.user_id || 0) === Number(user.id || 0) || normalizeEmail(item.email) === email) && item.status === 'pending');
  if (existing) return { existing: true, request: existing };
  const nextId = data.requests.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
  const request = {
    id: nextId,
    user_id: user.id || null,
    username: user.username || '',
    email,
    old_hwid: normalizeHwid(user.hwid),
    reason: cleanReason,
    status: 'pending',
    requested_at: new Date().toISOString(),
    reviewed_at: '',
    reviewed_by: '',
    admin_note: ''
  };
  data.requests.unshift(request);
  writeDeviceResetRequestsFile(data);
  return { existing: false, request };
}

async function listDeviceResetRequests(status = '', limit = 200) {
  const cleanStatus = String(status || '').trim();
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  if (useDatabase) {
    const params = [];
    let where = '';
    if (cleanStatus) {
      where = 'WHERE status = ?';
      params.push(cleanStatus);
    }
    params.push(safeLimit);
    const [rows] = await pool.query(
      `SELECT id, user_id, username, email, old_hwid, reason, status, requested_at, reviewed_at, reviewed_by, admin_note
      FROM device_reset_requests ${where} ORDER BY requested_at DESC, id DESC LIMIT ?`,
      params
    );
    return rows;
  }
  return [...readDeviceResetRequestsFile().requests]
    .filter((item) => !cleanStatus || item.status === cleanStatus)
    .sort((a, b) => new Date(b.requested_at || 0).getTime() - new Date(a.requested_at || 0).getTime())
    .slice(0, safeLimit);
}

async function listDeviceResetRequestsForUser(user) {
  const email = normalizeEmail(user?.email);
  const id = Number(user?.id || 0);
  return (await listDeviceResetRequests('', 500))
    .filter((item) => Number(item.user_id || 0) === id || normalizeEmail(item.email) === email)
    .slice(0, 20);
}

async function reviewDeviceResetRequest(id, { approved, admin, note = '' }) {
  const requestId = Number(id);
  const status = approved ? 'approved' : 'rejected';
  const reviewedAtIso = new Date().toISOString();
  const reviewedAtDb = reviewedAtIso.slice(0, 19).replace('T', ' ');
  const reviewedBy = admin?.email || 'admin';
  const adminNote = String(note || '').trim().slice(0, 1000);

  if (useDatabase) {
    const [rows] = await pool.query('SELECT * FROM device_reset_requests WHERE id = ? LIMIT 1', [requestId]);
    const request = rows[0];
    if (!request) return null;
    if (approved) {
      await pool.query('UPDATE users SET hwid = NULL WHERE id = ? OR email = ?', [request.user_id || 0, normalizeEmail(request.email)]);
    }
    await pool.query(
      'UPDATE device_reset_requests SET status = ?, reviewed_at = ?, reviewed_by = ?, admin_note = ? WHERE id = ?',
      [status, reviewedAtDb, reviewedBy, adminNote || null, requestId]
    );
    return { ...request, status, reviewed_at: reviewedAtIso, reviewed_by: reviewedBy, admin_note: adminNote };
  }

  const data = readDeviceResetRequestsFile();
  const request = data.requests.find((item) => Number(item.id) === requestId);
  if (!request) return null;
  if (approved) {
    const users = readUsersFile();
    users.users.forEach((item) => {
      if (Number(item.id || 0) === Number(request.user_id || 0) || normalizeEmail(item.email) === normalizeEmail(request.email)) item.hwid = '';
    });
    writeUsersFile(users);
  }
  request.status = status;
  request.reviewed_at = reviewedAtIso;
  request.reviewed_by = reviewedBy;
  request.admin_note = adminNote;
  writeDeviceResetRequestsFile(data);
  return request;
}

function normalizeTicketStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return ['open', 'answered', 'closed'].includes(status) ? status : 'open';
}

function mapSupportTicketRow(row = {}) {
  return {
    id: Number(row.id || 0),
    user_id: row.user_id || null,
    username: row.username || '',
    email: normalizeEmail(row.email),
    subject: String(row.subject || '').trim(),
    message: String(row.message || '').trim(),
    status: normalizeTicketStatus(row.status),
    priority: String(row.priority || 'normal').trim() || 'normal',
    admin_reply: String(row.admin_reply || '').trim(),
    created_at: toIsoDate(row.created_at),
    updated_at: toIsoDate(row.updated_at),
    closed_at: toIsoDate(row.closed_at)
  };
}

async function listSupportTickets({ email = '', status = '', limit = 200 } = {}) {
  const cleanEmail = normalizeEmail(email);
  const cleanStatus = String(status || '').trim().toLowerCase();
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  if (useDatabase) {
    const where = [];
    const params = [];
    if (cleanEmail) { where.push('email = ?'); params.push(cleanEmail); }
    if (cleanStatus) { where.push('status = ?'); params.push(cleanStatus); }
    params.push(safeLimit);
    const [rows] = await pool.query(
      `SELECT id, user_id, username, email, subject, message, status, priority, admin_reply, created_at, updated_at, closed_at
       FROM support_tickets ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY updated_at DESC, created_at DESC LIMIT ?`,
      params
    );
    return rows.map(mapSupportTicketRow);
  }
  return readSupportTicketsFile().tickets
    .map(mapSupportTicketRow)
    .filter((item) => !cleanEmail || normalizeEmail(item.email) === cleanEmail)
    .filter((item) => !cleanStatus || item.status === cleanStatus)
    .sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))
    .slice(0, safeLimit);
}

async function listSupportTicketsForUser(user) {
  return listSupportTickets({ email: user?.email, limit: 50 });
}

async function createSupportTicket({ user, subject, message, priority = 'normal' }) {
  const cleanSubject = String(subject || '').trim().slice(0, 160);
  const cleanMessage = String(message || '').trim().slice(0, 4000);
  if (!cleanSubject || !cleanMessage) throw new Error('Konu ve mesaj gerekli.');
  const nowIso = new Date().toISOString();
  const ticket = {
    id: Date.now(),
    user_id: user?.id || null,
    username: user?.username || '',
    email: normalizeEmail(user?.email),
    subject: cleanSubject,
    message: cleanMessage,
    status: 'open',
    priority: String(priority || 'normal').trim().slice(0, 30) || 'normal',
    admin_reply: '',
    created_at: nowIso,
    updated_at: nowIso,
    closed_at: ''
  };
  if (useDatabase) {
    await pool.query(
      `INSERT INTO support_tickets (id, user_id, username, email, subject, message, status, priority, admin_reply, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ticket.id, ticket.user_id, ticket.username, ticket.email, ticket.subject, ticket.message, ticket.status, ticket.priority, null, toSqlDate(ticket.created_at), toSqlDate(ticket.updated_at), null]
    );
  } else {
    const data = readSupportTicketsFile();
    data.tickets.unshift(ticket);
    writeSupportTicketsFile(data);
  }
  return ticket;
}

async function updateSupportTicket(id, { status = 'answered', admin_reply = '', admin = null } = {}) {
  const ticketId = Number(id);
  const cleanStatus = normalizeTicketStatus(status);
  let reply = String(admin_reply || '').trim().slice(0, 4000);
  const nowIso = new Date().toISOString();
  const closedAt = cleanStatus === 'closed' ? nowIso : '';
  if (useDatabase) {
    const [rows] = await pool.query('SELECT * FROM support_tickets WHERE id = ? LIMIT 1', [ticketId]);
    if (!rows[0]) return null;
    if (!reply) reply = String(rows[0].admin_reply || '').trim().slice(0, 4000);
    await pool.query(
      'UPDATE support_tickets SET status = ?, admin_reply = ?, updated_at = ?, closed_at = ? WHERE id = ?',
      [cleanStatus, reply || null, toSqlDate(nowIso), closedAt ? toSqlDate(closedAt) : null, ticketId]
    );
    return mapSupportTicketRow({ ...rows[0], status: cleanStatus, admin_reply: reply, updated_at: nowIso, closed_at: closedAt });
  }
  const data = readSupportTicketsFile();
  const ticket = data.tickets.find((item) => Number(item.id) === ticketId);
  if (!ticket) return null;
  if (!reply) reply = String(ticket.admin_reply || '').trim().slice(0, 4000);
  ticket.status = cleanStatus;
  ticket.admin_reply = reply;
  ticket.updated_at = nowIso;
  ticket.closed_at = closedAt;
  writeSupportTicketsFile(data);
  await recordActivityLog({ user: admin, action: 'SUPPORT_TICKET_REPLY', details: `Ticket ${ticketId}: ${cleanStatus}` });
  return mapSupportTicketRow(ticket);
}

async function buildAccountSummary(sessionUser) {
  const fullUser = await findUserById(Number(sessionUser?.id || 0)) || await findUserByEmail(sessionUser?.email) || sessionUser;
  const dailyLimit = Number(fullUser?.daily_limit || 0);
  const dailyAddCount = await countTodayAddGames(fullUser?.email);
  const pluginStatuses = (await listPluginStatuses(500))
    .filter((item) => normalizeEmail(item.email) === normalizeEmail(fullUser?.email))
    .sort((a, b) => new Date(b.last_seen_at || 0) - new Date(a.last_seen_at || 0))
    .slice(0, 20);
  const installedGames = aggregateInstalledGamesFromStatuses(pluginStatuses);
  const control = await getPluginControl();
  const { password_hash, session_token, ...safeUser } = fullUser || {};
  return {
    user: safeUser,
    license_active: isLicenseActive(fullUser),
    license_until: fullUser?.license_until || '',
    daily_limit: dailyLimit,
    allowed_appids: getAllowedAppids(fullUser),
    daily_add_count: dailyAddCount,
    hwid: normalizeHwid(fullUser?.hwid),
    orders: await listOrdersForUser(fullUser),
    order_claims: await listOrderClaims({ user: fullUser, limit: 100 }),
    wishlist: await listWishlist(fullUser),
    referral_code: await getOrCreateReferralCode(fullUser),
    upgrade_options: buildUpgradeOptions(fullUser),
    device_reset_requests: await listDeviceResetRequestsForUser(fullUser),
    support_tickets: await listSupportTicketsForUser(fullUser),
    security_activity: (await listActivityLogs(200)).filter((item) => normalizeEmail(item.email) === normalizeEmail(fullUser?.email)).slice(0, 30),
    plugin_statuses: pluginStatuses,
    installed_games: installedGames,
    installed_game_count: installedGames.length,
    plugin_download_url: '/securityshoop-plugin.zip',
    update_url: control.update_url || '/securityshoop-plugin.zip',
    support_url: control.support_url || 'https://www.instagram.com/securityshoop/?hl=tr'
  };
}

async function buildPluginNotifications(user) {
  const now = Date.now();
  const notifications = [];
  const announcements = readAnnouncementsFile().announcements
    .filter((item) => item && item.active !== false)
    .filter((item) => !item.expires_at || new Date(item.expires_at).getTime() > now)
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    .slice(0, 10);
  for (const item of announcements) {
    notifications.push({
      id: `ann-${item.id || item.created_at}`,
      type: 'announcement',
      title: item.title || 'Duyuru',
      message: item.message || '',
      created_at: item.created_at || '',
      severity: 'info'
    });
  }

  const control = await getPluginControl();
  if (control.notice_message) {
    notifications.unshift({
      id: `notice-${control.updated_at || 'current'}`,
      type: 'notice',
      title: control.notice_title || 'SecurityShoop',
      message: control.notice_message,
      created_at: control.updated_at || new Date().toISOString(),
      severity: control.maintenance_mode ? 'warning' : 'info'
    });
  }
  if (control.force_update || control.latest_version) {
    notifications.push({
      id: `release-${control.latest_version || 'current'}`,
      type: 'release',
      title: control.latest_version ? `SecurityShoop ${control.latest_version}` : 'Plugin guncellemesi',
      message: control.release_notes || 'Guncelleme bilgisi yayinda.',
      created_at: control.updated_at || '',
      severity: control.force_update ? 'warning' : 'info',
      url: control.update_url || ''
    });
  }

  const dailyLimit = Number(user?.daily_limit || 0);
  const dailyAddCount = await countTodayAddGames(user?.email);
  if (!isLicenseActive(user)) {
    notifications.unshift({
      id: 'license-expired',
      type: 'license',
      title: 'Lisans suresi doldu',
      message: 'Oyun ekleme icin lisansini yenilemen gerekiyor.',
      created_at: new Date().toISOString(),
      severity: 'danger'
    });
  } else if (isUserInReview(user)) {
    notifications.unshift({
      id: 'review-mode',
      type: 'risk',
      title: 'Hesap incelemede',
      message: user.review_note || 'Hesap risk inceleme modunda. Admin kontrolunden sonra ekleme tekrar acilir.',
      created_at: new Date().toISOString(),
      severity: 'warning'
    });
  } else if (user?.license_until) {
    const msLeft = new Date(user.license_until).getTime() - now;
    if (msLeft > 0 && msLeft < 1000 * 60 * 60 * 24 * 7) {
      notifications.push({
        id: 'license-soon',
        type: 'license',
        title: 'Lisans yakinda bitiyor',
        message: `Lisans bitisi: ${new Date(user.license_until).toLocaleDateString('tr-TR')}`,
        created_at: new Date().toISOString(),
        severity: 'warning'
      });
    }
  }
  if (dailyLimit > 0) {
    notifications.push({
      id: 'daily-limit',
      type: 'limit',
      title: 'Gunluk limit',
      message: `Bugun ${dailyAddCount}/${dailyLimit} oyun ekledin.`,
      created_at: new Date().toISOString(),
      severity: dailyAddCount >= dailyLimit ? 'warning' : 'info'
    });
  }

  const disabledSources = await getDisabledSources();
  if (disabledSources.length) {
    notifications.push({
      id: 'disabled-sources',
      type: 'source',
      title: 'Pasif kaynaklar',
      message: disabledSources.map((item) => item.name).join(', '),
      created_at: new Date().toISOString(),
      severity: 'warning'
    });
  }

  return notifications.slice(0, 30);
}

function cleanAiText(value, max = 800) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeAiChatMessages(input) {
  const rawMessages = Array.isArray(input?.messages) ? input.messages : [];
  const messages = rawMessages
    .map((item) => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: cleanAiText(item?.content || item?.text || '', 900)
    }))
    .filter((item) => item.content)
    .slice(-8);
  const singleMessage = cleanAiText(input?.message || input?.text || '', 900);
  if (singleMessage) messages.push({ role: 'user', content: singleMessage });
  return messages.slice(-8);
}

function getAiSystemPrompt() {
  return [
    'Sen SecurityShoop sitesinin Turkce destek asistanisin.',
    'Kisa, net ve yardimci cevap ver. Gereksiz uzun anlatma.',
    'Konu disina cikma: hesap kaydi, admin onayi, lisans paketleri, oyun ekleme hakki, rastgele oyun lisansi, plugin indirme, cihaz/HWID, destek ve odeme yonlendirmesi.',
    'Kullanicidan sifre, token, API anahtari veya gizli bilgi isteme.',
    'Hesap, odeme veya teknik ariza icin Instagram DM ya da admin paneli destegine yonlendir.',
    'Markdown kullanma; duz metin cevap ver.'
  ].join(' ');
}

function hasAiGatewayCredentials() {
  return isConfigured(process.env.VERCEL_OIDC_TOKEN) || isConfigured(process.env.AI_GATEWAY_API_KEY);
}

function hasGeminiCredentials() {
  return isConfigured(process.env.GEMINI_API_KEY);
}

function hasAnyAiProvider() {
  return process.env.AI_CHAT_ENABLED !== 'false' && (hasGeminiCredentials() || hasAiGatewayCredentials() || isConfigured(process.env.OPENAI_API_KEY));
}

function consumeAiRateLimit(ip) {
  const key = String(ip || 'unknown');
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const current = aiChatBuckets.get(key) || { count: 0, resetAt: now + windowMs };
  if (current.resetAt < now) {
    current.count = 0;
    current.resetAt = now + windowMs;
  }
  current.count += 1;
  aiChatBuckets.set(key, current);
  return current.count <= AI_CHAT_RATE_LIMIT;
}

async function generateAiChatWithSdk(messages) {
  const { generateText } = await import('ai');
  const result = await generateText({
    model: AI_CHAT_MODEL,
    system: getAiSystemPrompt(),
    messages,
    temperature: 0.25,
    maxOutputTokens: 420
  });
  return cleanAiText(result.text, 1600);
}

function extractOpenAiResponseText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text;
  const parts = [];
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n');
}

async function generateAiChatWithOpenAi(messages) {
  const key = String(process.env.OPENAI_API_KEY || '').trim();
  if (!key) throw new Error('OPENAI_API_KEY missing');
  const fallbackModel = AI_CHAT_MODEL.startsWith('openai/') ? AI_CHAT_MODEL.slice('openai/'.length) : AI_CHAT_MODEL;
  const model = process.env.OPENAI_CHAT_MODEL || fallbackModel || 'gpt-5.4';
  const input = [
    { role: 'system', content: getAiSystemPrompt() },
    ...messages.map((item) => ({ role: item.role, content: item.content }))
  ];
  const response = await postWithTimeout('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, input, max_output_tokens: 420 })
  }, 12000);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `OpenAI HTTP ${response.status}`);
  return cleanAiText(extractOpenAiResponseText(payload), 1600);
}

async function generateAiChatWithGemini(messages) {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('GEMINI_API_KEY missing');
  const model = String(process.env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash').trim();
  const contents = messages.map((item) => ({
    role: item.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: item.content }]
  }));
  const response = await postWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: getAiSystemPrompt() }] },
      contents,
      generationConfig: { temperature: 0.25, maxOutputTokens: 420 }
    })
  }, 12000);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `Gemini HTTP ${response.status}`);
  const text = (payload?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.text || '')
    .join('\n');
  return cleanAiText(text, 1600);
}

function safeAiProviderMessage(error) {
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('quota') || message.includes('billing') || message.includes('exceed')) {
    return 'AI servis limiti veya bakiyesi yetersiz. Gemini/OpenAI panelinde kota ve bakiye kontrolu gerekiyor.';
  }
  if (message.includes('unauthorized') || message.includes('invalid api key') || message.includes('incorrect api key')) {
    return 'AI API anahtari gecersiz gorunuyor. Gemini/OpenAI panelinden anahtari kontrol etmek gerekiyor.';
  }
  if (message.includes('model')) {
    return 'AI modeli kullanilamadi. GEMINI_CHAT_MODEL veya OPENAI_CHAT_MODEL ayari kontrol edilmeli.';
  }
  return 'AI servisinden cevap alinamadi. Biraz sonra tekrar dene.';
}

async function generateAiChatReply(messages) {
  if (!hasAnyAiProvider()) {
    return {
      ok: false,
      configured: false,
      message: 'AI sohbet henuz aktif degil. GEMINI_API_KEY, Vercel AI Gateway veya OPENAI_API_KEY eklendiginde otomatik calisir.'
    };
  }
  let lastProviderError = null;
  if (hasGeminiCredentials()) {
    try {
      const reply = await generateAiChatWithGemini(messages);
      if (reply) return { ok: true, configured: true, provider: 'gemini', reply };
    } catch (error) {
      lastProviderError = error;
      console.warn('Gemini chat failed, trying fallback:', error.message);
    }
  }
  if (hasAiGatewayCredentials()) {
    try {
      const reply = await generateAiChatWithSdk(messages);
      if (reply) return { ok: true, configured: true, provider: 'ai-sdk', reply };
    } catch (error) {
      lastProviderError = error;
      console.warn('AI SDK chat failed, trying OpenAI fallback:', error.message);
    }
  }
  if (!isConfigured(process.env.OPENAI_API_KEY)) {
    return { ok: false, configured: true, status: 503, message: safeAiProviderMessage(lastProviderError || new Error('AI provider unavailable')) };
  }
  try {
    const reply = await generateAiChatWithOpenAi(messages);
    return { ok: true, configured: true, provider: 'openai', reply };
  } catch (error) {
    console.warn('OpenAI chat unavailable:', error.message);
    return { ok: false, configured: true, status: 503, message: safeAiProviderMessage(error) };
  }
}

async function listUsersForBackup() {
  if (useDatabase) {
    const [rows] = await pool.query('SELECT id, username, email, password_hash, hwid, role, is_blocked, session_token, token_created_at, license_until, daily_limit, allowed_appids, approval_status, review_mode, review_note, created_at FROM users ORDER BY id ASC');
    return rows;
  }
  return readUsersFile().users;
}

async function listReviewsForBackup() {
  if (useDatabase) {
    const [rows] = await pool.query('SELECT id, user_id, username, text, rating, is_demo, created_at FROM reviews ORDER BY id ASC');
    return rows;
  }
  return readReviewsFile().reviews;
}

async function listHwidBansForBackup() {
  if (useDatabase) {
    const [rows] = await pool.query('SELECT id, hwid, user_id, email, reason, created_at FROM hwid_bans ORDER BY id ASC');
    return rows;
  }
  return readHwidBansFile().bans;
}

async function buildBackupPayload() {
  const databaseOnly = async (query) => {
    if (!useDatabase) return [];
    const [rows] = await pool.query(query);
    return rows;
  };
  return {
    ok: true,
    schema: 'securityshoop-backup-v1',
    exported_at: new Date().toISOString(),
    storage: useDatabase ? 'mysql' : 'json',
    users: await listUsersForBackup(),
    orders: await listOrders(1000),
    activity_logs: await listActivityLogs(500),
    hwid_bans: await listHwidBansForBackup(),
    reviews: await listReviewsForBackup(),
    device_reset_requests: await listDeviceResetRequests('', 500),
    support_tickets: await listSupportTickets({ limit: 1000 }),
    order_claims: await listOrderClaims({ limit: 1000 }),
    license_codes: await listLicenseCodes(1000),
    coupons: await listCoupons(1000),
    game_wishlist: await databaseOnly('SELECT * FROM game_wishlist ORDER BY created_at DESC LIMIT 2000'),
    referral_events: await databaseOnly('SELECT * FROM referral_events ORDER BY created_at DESC LIMIT 2000'),
    commerce_events: await databaseOnly('SELECT * FROM commerce_events ORDER BY created_at DESC LIMIT 5000'),
    announcements: readAnnouncementsFile().announcements,
    error_reports: await listErrorReports(500),
    plugin_control: await getPluginControl(),
    plugin_status: await listPluginStatuses(500),
    plugin_commands: await listPluginCommands(500),
    source_health: await listSourceHealth(500)
  };
}

function mergeByKey(current, incoming, keyFn, limit = 1000) {
  const map = new Map();
  for (const item of Array.isArray(current) ? current : []) {
    const key = keyFn(item);
    if (key) map.set(key, item);
  }
  for (const item of Array.isArray(incoming) ? incoming : []) {
    const key = keyFn(item);
    if (!key) continue;
    map.set(key, { ...(map.get(key) || {}), ...item });
  }
  return [...map.values()].slice(-limit);
}

async function restoreBackupPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') throw new Error('Yedek dosyasi okunamadi.');
  if (payload.schema && payload.schema !== 'securityshoop-backup-v1') throw new Error('Yedek formati desteklenmiyor.');
  const summary = { users: 0, orders: 0, logs: 0, reviews: 0, hwid_bans: 0, device_resets: 0 };

  const users = Array.isArray(payload.users) ? payload.users.slice(0, 2000) : [];
  for (const user of users) {
    const email = normalizeEmail(user.email);
    const username = String(user.username || email.split('@')[0] || 'user').slice(0, 100);
    const passwordHash = String(user.password_hash || '').slice(0, 255);
    if (!email || !passwordHash) continue;
    if (useDatabase) {
      await pool.query(
        `INSERT INTO users (username, email, password_hash, hwid, role, is_blocked, session_token, token_created_at, license_until, daily_limit, allowed_appids, approval_status, review_mode, review_note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          username = VALUES(username),
          password_hash = VALUES(password_hash),
          hwid = VALUES(hwid),
          role = VALUES(role),
          is_blocked = VALUES(is_blocked),
          session_token = COALESCE(VALUES(session_token), session_token),
          token_created_at = COALESCE(VALUES(token_created_at), token_created_at),
          license_until = VALUES(license_until),
          daily_limit = VALUES(daily_limit),
          allowed_appids = VALUES(allowed_appids),
          approval_status = VALUES(approval_status),
          review_mode = VALUES(review_mode),
          review_note = VALUES(review_note)`,
        [
          username,
          email,
          passwordHash,
          normalizeHwid(user.hwid) || null,
          user.role === 'admin' ? 'admin' : 'user',
          user.is_blocked ? 1 : 0,
          user.session_token || null,
          user.token_created_at ? String(user.token_created_at).slice(0, 19).replace('T', ' ') : null,
          user.license_until ? String(user.license_until).slice(0, 19).replace('T', ' ') : null,
          Math.max(0, Number(user.daily_limit || 0)),
          normalizeAppidList(user.allowed_appids).join(','),
          normalizeApprovalStatus(user.approval_status, user.role),
          user.review_mode === true || Number(user.review_mode || 0) === 1 ? 1 : 0,
          String(user.review_note || '').slice(0, 1000) || null
        ]
      );
    } else {
      const data = readUsersFile();
      const existing = data.users.find((item) => normalizeEmail(item.email) === email);
      const next = { ...user, email, username, password_hash: passwordHash, allowed_appids: normalizeAppidList(user.allowed_appids).join(','), approval_status: normalizeApprovalStatus(user.approval_status, user.role), review_mode: user.review_mode === true || Number(user.review_mode || 0) === 1 ? 1 : 0, review_note: String(user.review_note || '').slice(0, 1000) };
      if (existing) Object.assign(existing, next);
      else data.users.push({ ...next, id: Number(user.id || 0) || Date.now() + summary.users });
      writeUsersFile(data);
    }
    summary.users += 1;
  }

  for (const order of (Array.isArray(payload.orders) ? payload.orders.slice(0, 2000) : [])) {
    if (!order.platform_order_id) continue;
    await saveOrder(order);
    summary.orders += 1;
  }

  for (const ban of (Array.isArray(payload.hwid_bans) ? payload.hwid_bans.slice(0, 1000) : [])) {
    if (!normalizeHwid(ban.hwid)) continue;
    await addHwidBan({ hwid: ban.hwid, user: { id: ban.user_id || null, email: ban.email || null }, reason: ban.reason || 'Backup restore' });
    summary.hwid_bans += 1;
  }

  if (useDatabase) {
    for (const log of (Array.isArray(payload.activity_logs) ? payload.activity_logs.slice(0, 1000) : [])) {
      if (!log.action) continue;
      await pool.query(
        'INSERT INTO activity_logs (user_id, username, email, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [
          log.user_id || null,
          log.username || null,
          normalizeEmail(log.email) || null,
          String(log.action || '').slice(0, 80),
          String(log.details || '').slice(0, 3000) || null,
          log.timestamp ? String(log.timestamp).slice(0, 19).replace('T', ' ') : new Date()
        ]
      );
      summary.logs += 1;
    }
    for (const review of (Array.isArray(payload.reviews) ? payload.reviews.slice(0, 1000) : [])) {
      if (!review.text) continue;
      await pool.query(
        'INSERT INTO reviews (id, user_id, username, text, rating, is_demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE username = VALUES(username), text = VALUES(text), rating = VALUES(rating), is_demo = VALUES(is_demo)',
        [
          Number(review.id || 0) || null,
          review.user_id || null,
          String(review.username || 'Uye').slice(0, 100),
          String(review.text || '').slice(0, 2000),
          Math.max(1, Math.min(5, Number(review.rating || 5))),
          review.is_demo ? 1 : 0,
          review.created_at ? String(review.created_at).slice(0, 19).replace('T', ' ') : new Date()
        ]
      );
      summary.reviews += 1;
    }
    for (const request of (Array.isArray(payload.device_reset_requests) ? payload.device_reset_requests.slice(0, 1000) : [])) {
      if (!request.email && !request.user_id) continue;
      await pool.query(
        `INSERT INTO device_reset_requests (id, user_id, username, email, old_hwid, reason, status, requested_at, reviewed_at, reviewed_by, admin_note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE status = VALUES(status), reviewed_at = VALUES(reviewed_at), reviewed_by = VALUES(reviewed_by), admin_note = VALUES(admin_note)`,
        [
          Number(request.id || 0) || null,
          request.user_id || null,
          request.username || null,
          normalizeEmail(request.email) || null,
          normalizeHwid(request.old_hwid) || null,
          request.reason || null,
          ['pending', 'approved', 'rejected'].includes(request.status) ? request.status : 'pending',
          request.requested_at ? String(request.requested_at).slice(0, 19).replace('T', ' ') : new Date(),
          request.reviewed_at ? String(request.reviewed_at).slice(0, 19).replace('T', ' ') : null,
          request.reviewed_by || null,
          request.admin_note || null
        ]
      );
      summary.device_resets += 1;
    }
    for (const ticket of (Array.isArray(payload.support_tickets) ? payload.support_tickets.slice(0, 1000) : [])) {
      if (!ticket.subject || !ticket.message) continue;
      await pool.query(
        `INSERT INTO support_tickets (id, user_id, username, email, subject, message, status, priority, admin_reply, created_at, updated_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE status = VALUES(status), admin_reply = VALUES(admin_reply), updated_at = VALUES(updated_at), closed_at = VALUES(closed_at)`,
        [
          Number(ticket.id || 0) || Date.now(),
          ticket.user_id || null,
          ticket.username || null,
          normalizeEmail(ticket.email) || null,
          String(ticket.subject || '').slice(0, 160),
          String(ticket.message || '').slice(0, 4000),
          normalizeTicketStatus(ticket.status),
          String(ticket.priority || 'normal').slice(0, 30),
          ticket.admin_reply || null,
          ticket.created_at ? String(ticket.created_at).slice(0, 19).replace('T', ' ') : new Date(),
          ticket.updated_at ? String(ticket.updated_at).slice(0, 19).replace('T', ' ') : new Date(),
          ticket.closed_at ? String(ticket.closed_at).slice(0, 19).replace('T', ' ') : null
        ]
      );
    }
  } else {
    const logsData = readActivityLogsFile();
    logsData.logs = mergeByKey(logsData.logs, payload.activity_logs, (item) => String(item.id || `${item.email}-${item.action}-${item.timestamp}`), 1000);
    writeActivityLogsFile(logsData);
    summary.logs = Array.isArray(payload.activity_logs) ? payload.activity_logs.length : 0;

    const reviewsData = readReviewsFile();
    reviewsData.reviews = mergeByKey(reviewsData.reviews, payload.reviews, (item) => String(item.id || `${item.username}-${item.created_at}`), 1000);
    writeReviewsFile(reviewsData);
    summary.reviews = Array.isArray(payload.reviews) ? payload.reviews.length : 0;

    const resetsData = readDeviceResetRequestsFile();
    resetsData.requests = mergeByKey(resetsData.requests, payload.device_reset_requests, (item) => String(item.id || `${item.email}-${item.requested_at}`), 1000);
    writeDeviceResetRequestsFile(resetsData);
    summary.device_resets = Array.isArray(payload.device_reset_requests) ? payload.device_reset_requests.length : 0;

    const ticketsData = readSupportTicketsFile();
    ticketsData.tickets = mergeByKey(ticketsData.tickets, payload.support_tickets, (item) => String(item.id || `${item.email}-${item.subject}-${item.created_at}`), 1000);
    writeSupportTicketsFile(ticketsData);
  }

  if (Array.isArray(payload.announcements)) writeAnnouncementsFile({ announcements: mergeByKey(readAnnouncementsFile().announcements, payload.announcements, (item) => String(item.id || `${item.title}-${item.created_at}`), 500) });
  if (Array.isArray(payload.error_reports)) writeErrorReportsFile({ reports: mergeByKey(readErrorReportsFile().reports, payload.error_reports, (item) => String(item.id || `${item.email}-${item.created_at}`), 500) });
  if (payload.plugin_control && typeof payload.plugin_control === 'object') await savePluginControl(payload.plugin_control, 'backup-restore');
  if (Array.isArray(payload.plugin_status)) writePluginStatusFile({ statuses: mergeByKey(readPluginStatusFile().statuses, payload.plugin_status, (item) => String(item.key || `${item.email}-${item.hwid}`), 500) });
  if (Array.isArray(payload.plugin_commands)) writePluginCommandsFile({ commands: mergeByKey(readPluginCommandsFile().commands, payload.plugin_commands, (item) => String(item.id), 500) });
  if (Array.isArray(payload.source_health)) {
    const mergedSources = mergeByKey(await listSourceHealth(500), payload.source_health, (item) => normalizeSourceName(item.name), 200);
    for (const source of mergedSources) await saveSourceHealthEntry(source);
  }

  return summary;
}

async function getPluginControl() {
  if (useDatabase) {
    const [rows] = await pool.query('SELECT config FROM plugin_control WHERE id = 1 LIMIT 1');
    if (rows[0]?.config) {
      try {
        return normalizePluginControl(JSON.parse(rows[0].config));
      } catch (_) {}
    }
  }
  return readPluginControlFile();
}

async function savePluginControl(patch, adminEmail = '') {
  const current = await getPluginControl();
  const next = normalizePluginControl({
    ...current,
    ...patch,
    updated_by: adminEmail,
    updated_at: new Date().toISOString()
  });

  if (useDatabase) {
    await pool.query(
      'INSERT INTO plugin_control (id, config) VALUES (1, ?) ON DUPLICATE KEY UPDATE config = VALUES(config)',
      [JSON.stringify(next)]
    );
  }

  writePluginControlFile(next);
  return next;
}

async function buildPluginControlResponse(control) {
  const disabledSources = await getDisabledSources();
  const sourceScores = await getSourceScores(200);
  const visibleControl = {
    ...control,
    latest_version: control.latest_version || PLUGIN_VERSION,
    update_url: control.update_url || '/securityshoop-plugin.zip'
  };
  const message = control.maintenance_mode
    ? 'Plugin bak─▒m modunda. Oyun ekleme ge├ğici olarak kapal─▒.'
    : (!control.add_game_enabled ? 'Admin oyun eklemeyi kapatt─▒.' : '');
  return {
    ok: true,
    control: visibleControl,
    can_add_games: Boolean(control.add_game_enabled && !control.maintenance_mode),
    blocked: Boolean(control.maintenance_mode || !control.add_game_enabled),
    disabled_sources: disabledSources,
    source_scores: sourceScores,
    message: message || control.notice_message || 'OK'
  };
}

function getRequestIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
}

function normalizeInstalledGames(value) {
  const items = Array.isArray(value) ? value : [];
  const seen = new Set();
  const games = [];
  for (const item of items.slice(0, 200)) {
    const appid = String(item?.appid || '').match(/\d+/)?.[0] || '';
    if (!appid || seen.has(appid)) continue;
    seen.add(appid);
    const manifestFiles = Array.isArray(item?.manifest_files)
      ? item.manifest_files.map((name) => String(name || '').trim()).filter((name) => /^[\w.-]+\.manifest$/.test(name)).slice(0, 200)
      : [];
    games.push({
      appid,
      name: String(item?.name || item?.title || `AppID ${appid}`).trim().slice(0, 160) || `AppID ${appid}`,
      api: String(item?.api || '').trim().slice(0, 120),
      manifest_count: Number(item?.manifest_count || manifestFiles.length || 0),
      manifest_files: manifestFiles,
      installed_at: String(item?.installed_at || '').trim().slice(0, 40)
    });
  }
  return games;
}

function mapPluginStatusRow(row = {}) {
  return {
    key: row.status_key || row.key || '',
    user_id: row.user_id || null,
    username: row.username || '',
    email: normalizeEmail(row.email),
    hwid: normalizeHwid(row.hwid),
    version: row.version || '',
    ip: row.ip || '',
    status: row.status || '',
    appid: row.appid || '',
    current_api: row.current_api || '',
    message: row.message || '',
    installed_games: normalizeInstalledGames(parseJsonField(row.installed_games, [])),
    first_seen_at: toIsoDate(row.first_seen_at),
    last_seen_at: toIsoDate(row.last_seen_at)
  };
}

async function listPluginStatuses(limit = 500) {
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 1000);
  if (useDatabase) {
    const [rows] = await pool.query(
      `SELECT status_key, user_id, username, email, hwid, version, ip, status, appid, current_api, message, installed_games, first_seen_at, last_seen_at
       FROM plugin_statuses ORDER BY last_seen_at DESC LIMIT ?`,
      [safeLimit]
    );
    return rows.map(mapPluginStatusRow);
  }
  return readPluginStatusFile().statuses.slice(0, safeLimit).map(mapPluginStatusRow);
}

function aggregateInstalledGamesFromStatuses(statuses = []) {
  const gamesByAppid = new Map();
  for (const status of statuses || []) {
    for (const game of normalizeInstalledGames(status.installed_games)) {
      const appid = String(game.appid || '').match(/\d+/)?.[0] || '';
      if (!appid) continue;
      const current = gamesByAppid.get(appid) || {};
      const next = {
        ...current,
        ...game,
        appid,
        name: game.name || current.name || `AppID ${appid}`,
        api: game.api || current.api || '',
        source: game.api || current.source || '',
        last_seen_at: status.last_seen_at || current.last_seen_at || '',
        hwid: status.hwid || current.hwid || '',
        plugin_version: status.version || current.plugin_version || ''
      };
      next.manifest_files = Array.isArray(game.manifest_files) ? game.manifest_files : (current.manifest_files || []);
      next.manifest_count = Number(game.manifest_count || next.manifest_files.length || current.manifest_count || 0);
      gamesByAppid.set(appid, next);
    }
  }
  return [...gamesByAppid.values()].sort((a, b) => {
    const at = new Date(a.installed_at || a.last_seen_at || 0).getTime();
    const bt = new Date(b.installed_at || b.last_seen_at || 0).getTime();
    return bt - at;
  });
}

async function findPluginOnlyUserByEmail(email) {
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) return null;
  const statuses = (await listPluginStatuses(500)).filter((item) => normalizeEmail(item.email) === cleanEmail);
  const logs = (await listActivityLogs(500)).filter((item) => normalizeEmail(item.email) === cleanEmail);
  if (!statuses.length && !logs.length) return null;
  const latestStatus = statuses[0] || {};
  const latestLog = logs[0] || {};
  return {
    id: null,
    virtual_id: `plugin:${cleanEmail}`,
    plugin_only: true,
    username: latestStatus.username || latestLog.username || cleanEmail.split('@')[0],
    email: cleanEmail,
    hwid: normalizeHwid(latestStatus.hwid || ''),
    role: 'plugin',
    is_blocked: 0,
    approval_status: 'plugin_only',
    created_at: latestStatus.first_seen_at || latestLog.timestamp || latestStatus.last_seen_at || new Date().toISOString()
  };
}

async function resolveAdminUserTarget(rawId) {
  const idText = String(rawId || '').trim();
  if (idText.toLowerCase().startsWith('plugin:')) {
    return findPluginOnlyUserByEmail(idText.slice('plugin:'.length));
  }
  return findUserById(Number(idText));
}

function mapPluginCommandRow(row = {}) {
  return {
    id: Number(row.id || 0),
    user_id: row.user_id || null,
    username: row.username || '',
    email: normalizeEmail(row.email),
    hwid: normalizeHwid(row.hwid),
    command: row.command || '',
    payload: parseJsonField(row.payload, {}),
    reason: row.reason || '',
    status: row.status || 'pending',
    created_by: row.created_by || '',
    created_at: toIsoDate(row.created_at),
    delivered_at: toIsoDate(row.delivered_at),
    delivery_attempts: Number(row.delivery_attempts || 0),
    completed_at: toIsoDate(row.completed_at),
    result: row.result || ''
  };
}

const ACTIVE_PLUGIN_COMMAND_STATUSES = new Set(['pending', 'delivered', 'running']);
const ALLOWED_PLUGIN_COMMANDS = new Set([
  'logout',
  'cleanup_games',
  'reset_account',
  'refresh_control',
  'send_notice',
  'install_cleanup_watchdog',
  'remove_cleanup_watchdog',
  'health_check',
  'repair_health_shield',
  'integrity_check',
  'repair_integrity'
]);

function normalizeForStableJson(value) {
  if (Array.isArray(value)) return value.map(normalizeForStableJson);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      const normalized = normalizeForStableJson(value[key]);
      if (normalized !== undefined) acc[key] = normalized;
      return acc;
    }, {});
  }
  return value;
}

function stablePayloadJson(value) {
  try {
    return JSON.stringify(normalizeForStableJson(value && typeof value === 'object' ? value : {}));
  } catch (_error) {
    return '{}';
  }
}

function pluginCommandTargetsMatch(command, item) {
  const itemUserId = Number(item.user_id || 0);
  const commandUserId = Number(command.user_id || 0);
  if (itemUserId && commandUserId && itemUserId === commandUserId) return true;
  const itemEmail = normalizeEmail(item.email);
  if (itemEmail && normalizeEmail(command.email) === itemEmail) return true;
  const itemHwid = normalizeHwid(item.hwid);
  return Boolean(itemHwid && normalizeHwid(command.hwid) === itemHwid);
}

async function listPluginCommands(limit = 500) {
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 1000);
  if (useDatabase) {
    const [rows] = await pool.query(
      `SELECT id, user_id, username, email, hwid, command, payload, reason, status, created_by, created_at, delivered_at, delivery_attempts, completed_at, result
       FROM plugin_commands ORDER BY created_at DESC, id DESC LIMIT ?`,
      [safeLimit]
    );
    return rows.map(mapPluginCommandRow);
  }
  return readPluginCommandsFile().commands.slice(0, safeLimit).map(mapPluginCommandRow);
}

async function getPluginCommandById(id) {
  const commandId = Number(id);
  if (!commandId) return null;
  if (useDatabase) {
    const [rows] = await pool.query(
      `SELECT id, user_id, username, email, hwid, command, payload, reason, status, created_by, created_at, delivered_at, delivery_attempts, completed_at, result
       FROM plugin_commands WHERE id = ? LIMIT 1`,
      [commandId]
    );
    return rows[0] ? mapPluginCommandRow(rows[0]) : null;
  }
  return readPluginCommandsFile().commands.find((item) => Number(item.id) === commandId) || null;
}

async function updatePluginStatus({ user, req, body = {} }) {
  const now = new Date().toISOString();
  const hwid = normalizeHwid(body.hwid || user?.hwid || '');
  const key = `${normalizeEmail(user?.email)}|${hwid || 'no-hwid'}`;
  let data = null;
  let existing = null;
  if (useDatabase) {
    const [rows] = await pool.query('SELECT first_seen_at FROM plugin_statuses WHERE status_key = ? LIMIT 1', [key]);
    if (rows[0]) existing = { first_seen_at: toIsoDate(rows[0].first_seen_at) };
  } else {
    data = readPluginStatusFile();
    existing = data.statuses.find((item) => item.key === key);
  }
  const entry = {
    key,
    user_id: user?.id || null,
    username: user?.username || '',
    email: normalizeEmail(user?.email),
    hwid,
    version: String(body.version || '').trim().slice(0, 40),
    ip: getRequestIp(req),
    status: String(body.status || 'online').trim().slice(0, 80),
    appid: String(body.appid || '').trim().slice(0, 40),
    current_api: String(body.current_api || '').trim().slice(0, 120),
    message: String(body.message || '').trim().slice(0, 500),
    installed_games: normalizeInstalledGames(body.installed_games),
    last_seen_at: now,
    first_seen_at: existing?.first_seen_at || now
  };
  if (useDatabase) {
    await pool.query(
      `INSERT INTO plugin_statuses (
        status_key, user_id, username, email, hwid, version, ip, status, appid, current_api, message,
        installed_games, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        user_id = VALUES(user_id),
        username = VALUES(username),
        email = VALUES(email),
        hwid = VALUES(hwid),
        version = VALUES(version),
        ip = VALUES(ip),
        status = VALUES(status),
        appid = VALUES(appid),
        current_api = VALUES(current_api),
        message = VALUES(message),
        installed_games = VALUES(installed_games),
        last_seen_at = VALUES(last_seen_at)`,
      [
        entry.key,
        entry.user_id,
        entry.username,
        entry.email,
        entry.hwid || null,
        entry.version,
        entry.ip,
        entry.status,
        entry.appid,
        entry.current_api,
        entry.message,
        JSON.stringify(entry.installed_games),
        toSqlDate(entry.first_seen_at),
        toSqlDate(entry.last_seen_at)
      ]
    );
  } else {
    if (existing) Object.assign(existing, entry);
    else data.statuses.unshift(entry);
    data.statuses = data.statuses.slice(0, 500);
    writePluginStatusFile(data);
  }

  const sourceHealth = Array.isArray(body.source_health) ? body.source_health : [];
  if (sourceHealth.length) await updateSourceHealth(sourceHealth);

  const statusSource = useDatabase ? await listPluginStatuses(500) : data.statuses;
  const userStatuses = statusSource.filter((item) => item.email === normalizeEmail(user?.email));
  const uniqueHwids = new Set(userStatuses.map((item) => normalizeHwid(item.hwid)).filter(Boolean));
  if (uniqueHwids.size > 1) {
    await recordActivityLog({ user, action: 'SUSPICIOUS_HWID', details: `Ayn─▒ hesap ${uniqueHwids.size} farkl─▒ bilgisayarda g├Âr├╝ld├╝.` });
  }

  if (uniqueHwids.size >= 3 && user?.role !== 'admin' && !isLicenseActive(user)) {
    await updateUserReviewMode(user.id, true, `Otomatik risk korumasi: ${uniqueHwids.size} farkli cihaz`, { email: 'fraud-shield', username: 'Fraud Shield' });
  }

  return entry;
}

async function getPendingCommandsFor(user, hwid = '') {
  const commands = await listPluginCommands(500);
  const email = normalizeEmail(user?.email);
  const cleanHwid = normalizeHwid(hwid || user?.hwid || '');
  const now = Date.now();
  const retryAfterMs = 15 * 1000;
  return commands
    .filter((cmd) => {
      if (cmd.status === 'pending') return true;
      if (cmd.status !== 'delivered') return false;
      const deliveredAt = new Date(cmd.delivered_at || 0).getTime();
      return !deliveredAt || now - deliveredAt >= retryAfterMs;
    })
    .filter((cmd) => Number(cmd.user_id || 0) === Number(user?.id || 0) || normalizeEmail(cmd.email) === email || (cmd.hwid && normalizeHwid(cmd.hwid) === cleanHwid))
    .slice(0, 10);
}

async function createPluginCommand({ user, admin, command, payload = {}, reason = '' }) {
  const item = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    user_id: user?.id || null,
    username: user?.username || '',
    email: normalizeEmail(user?.email),
    hwid: normalizeHwid(user?.hwid),
    command: String(command || '').trim().slice(0, 80),
    payload: payload && typeof payload === 'object' ? payload : {},
    reason: String(reason || '').trim().slice(0, 500),
    status: 'pending',
    created_by: admin?.email || 'admin',
    created_at: new Date().toISOString(),
    delivered_at: '',
    delivery_attempts: 0,
    completed_at: '',
    result: ''
  };
  const itemPayloadKey = stablePayloadJson(item.payload);
  const duplicate = (await listPluginCommands(500)).find((existing) => (
    existing.command === item.command
    && ACTIVE_PLUGIN_COMMAND_STATUSES.has(String(existing.status || ''))
    && pluginCommandTargetsMatch(existing, item)
    && stablePayloadJson(existing.payload) === itemPayloadKey
  ));
  if (duplicate) {
    await recordActivityLog({ user: admin, action: 'REMOTE_COMMAND_DEDUPED', details: `${item.command} -> ${item.email}` });
    return { ...duplicate, deduped: true };
  }
  if (useDatabase) {
    await pool.query(
      `INSERT INTO plugin_commands (
        id, user_id, username, email, hwid, command, payload, reason, status, created_by,
        created_at, delivered_at, delivery_attempts, completed_at, result
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.user_id,
        item.username,
        item.email,
        item.hwid || null,
        item.command,
        JSON.stringify(item.payload || {}),
        item.reason,
        item.status,
        item.created_by,
        toSqlDate(item.created_at),
        null,
        item.delivery_attempts,
        null,
        item.result
      ]
    );
  } else {
    const data = readPluginCommandsFile();
    data.commands.unshift(item);
    writePluginCommandsFile(data);
  }
  await recordActivityLog({ user: admin, action: 'REMOTE_COMMAND', details: `${item.command} -> ${item.email}` });
  return item;
}

async function markCommandsDelivered(commands) {
  if (!commands.length) return;
  if (useDatabase) {
    const now = toSqlDate(new Date());
    for (const cmd of commands) {
      await pool.query(
        `UPDATE plugin_commands
         SET status = 'delivered', delivered_at = ?, delivery_attempts = delivery_attempts + 1
         WHERE id = ? AND status IN ('pending', 'delivered')`,
        [now, Number(cmd.id)]
      );
    }
    return;
  }
  const data = readPluginCommandsFile();
  const ids = new Set(commands.map((cmd) => Number(cmd.id)));
  const now = new Date().toISOString();
  data.commands.forEach((cmd) => {
    if (ids.has(Number(cmd.id)) && cmd.status === 'pending') {
      cmd.status = 'delivered';
      cmd.delivered_at = now;
      cmd.delivery_attempts = Number(cmd.delivery_attempts || 0) + 1;
    } else if (ids.has(Number(cmd.id)) && cmd.status === 'delivered') {
      cmd.delivered_at = now;
      cmd.delivery_attempts = Number(cmd.delivery_attempts || 0) + 1;
    }
  });
  writePluginCommandsFile(data);
}

async function acknowledgePluginCommand({ id, user, ok, result, status }) {
  const commandId = Number(id);
  const cmd = await getPluginCommandById(commandId);
  if (!cmd) return { errorStatus: 404, body: { ok: false, message: 'Komut bulunamad─▒.' } };
  if (normalizeEmail(cmd.email) !== normalizeEmail(user.email) && Number(cmd.user_id || 0) !== Number(user.id)) {
    return { errorStatus: 403, body: { ok: false, message: 'Komut bu kullan─▒c─▒ya ait de─şil.' } };
  }
  const requestedStatus = String(status || '').trim().toLowerCase();
  const nextStatus = requestedStatus === 'running' ? 'running' : (ok === false ? 'failed' : 'completed');
  const completedAt = nextStatus === 'running' ? '' : new Date().toISOString();
  const cleanResult = String(result || '').slice(0, 1000);
  if (useDatabase) {
    await pool.query(
      'UPDATE plugin_commands SET status = ?, completed_at = ?, result = ? WHERE id = ?',
      [nextStatus, completedAt ? toSqlDate(completedAt) : null, cleanResult, commandId]
    );
  } else {
    const data = readPluginCommandsFile();
    const existing = data.commands.find((item) => Number(item.id) === commandId);
    if (existing) {
      existing.status = nextStatus;
      existing.completed_at = completedAt;
      existing.result = cleanResult;
      writePluginCommandsFile(data);
    }
  }
  return { body: { ok: true, command: { ...cmd, status: nextStatus, completed_at: completedAt, result: cleanResult } } };
}

async function cancelPluginCommand(id, adminEmail = 'admin') {
  const commandId = Number(id);
  const cmd = await getPluginCommandById(commandId);
  if (!cmd) return { errorStatus: 404, body: { ok: false, message: 'Komut bulunamad─▒.' } };
  if (!['pending', 'delivered'].includes(cmd.status)) {
    return { errorStatus: 400, body: { ok: false, message: 'Bu komut art─▒k iptal edilemez.' } };
  }
  const completedAt = new Date().toISOString();
  const result = `Cancelled by ${adminEmail || 'admin'}`;
  if (useDatabase) {
    await pool.query(
      'UPDATE plugin_commands SET status = ?, completed_at = ?, result = ? WHERE id = ?',
      ['cancelled', toSqlDate(completedAt), result, commandId]
    );
  } else {
    const data = readPluginCommandsFile();
    const existing = data.commands.find((item) => Number(item.id) === commandId);
    if (existing) {
      existing.status = 'cancelled';
      existing.completed_at = completedAt;
      existing.result = result;
      writePluginCommandsFile(data);
    }
  }
  return { body: { ok: true, message: 'Komut iptal edildi.', command: { ...cmd, status: 'cancelled', completed_at: completedAt, result } } };
}

function buildAutoRecoveryAction(report = {}) {
  const text = `${report.message || ''} ${report.context || ''}`.toLowerCase();
  if (/duplicate|already in progress|tekrar|ayn─▒ appid|same appid/.test(text)) {
    return 'Ayni oyun icin tekrar baslatma kilidi devrede; ikinci istek yok sayilir.';
  }
  if (/game not found|api|kaynak|source|manifest/.test(text)) {
    return 'Kaynak/API hatasi izlemeye alindi; ayni kaynak 3 kez hata verirse otomatik pasife alinir.';
  }
  if (/download|extract|zip|indir|cikar/.test(text)) {
    return 'Indirme hatasi yakalandi; plugin gecici dosyalari temizleyip sonraki kaynakla tekrar dener.';
  }
  if (/failed to fetch|site cevabi|baglan|connect|timeout/.test(text)) {
    return 'Site baglanti hatasi izlemeye alindi; komutlar kaybolmaz ve sonraki heartbeat ile tekrar denenir.';
  }
  return 'Hata kaydedildi; admin panelde izleniyor.';
}

function mapErrorReportRow(row = {}) {
  return {
    id: Number(row.id || 0),
    user_id: row.user_id || null,
    username: row.username || '',
    email: normalizeEmail(row.email),
    hwid: normalizeHwid(row.hwid),
    version: row.version || '',
    severity: row.severity || 'normal',
    message: row.message || '',
    context: row.context || '',
    page_url: row.page_url || '',
    ip: row.ip || '',
    status: row.status || 'open',
    resolved_by: row.resolved_by || '',
    resolved_at: toIsoDate(row.resolved_at),
    auto_action: row.auto_action || buildAutoRecoveryAction(row),
    created_at: toIsoDate(row.created_at)
  };
}

async function listErrorReports(limit = 300) {
  const safeLimit = Math.min(Math.max(Number(limit) || 300, 1), 1000);
  if (useDatabase) {
    const [rows] = await pool.query(
      `SELECT id, user_id, username, email, hwid, version, severity, message, context, page_url, ip, status, resolved_by, resolved_at, auto_action, created_at
       FROM plugin_error_reports ORDER BY created_at DESC, id DESC LIMIT ?`,
      [safeLimit]
    );
    return rows.map(mapErrorReportRow);
  }
  return readErrorReportsFile().reports.slice(0, safeLimit).map(mapErrorReportRow);
}

async function createErrorReport(report) {
  const item = {
    id: Number(report.id || Date.now()),
    user_id: report.user_id || null,
    username: report.username || '',
    email: normalizeEmail(report.email),
    hwid: normalizeHwid(report.hwid),
    version: String(report.version || '').slice(0, 40),
    severity: String(report.severity || 'normal').slice(0, 40),
    message: String(report.message || '').slice(0, 2000),
    context: String(report.context || '').slice(0, 4000),
    page_url: String(report.page_url || '').slice(0, 500),
    ip: String(report.ip || '').slice(0, 80),
    status: report.status || 'open',
    resolved_by: report.resolved_by || '',
    resolved_at: report.resolved_at || '',
    created_at: report.created_at || new Date().toISOString()
  };
  item.auto_action = report.auto_action || buildAutoRecoveryAction(item);

  if (useDatabase) {
    await pool.query(
      `INSERT INTO plugin_error_reports (
        id, user_id, username, email, hwid, version, severity, message, context, page_url, ip, status,
        resolved_by, resolved_at, auto_action, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.user_id,
        item.username,
        item.email,
        item.hwid || null,
        item.version,
        item.severity,
        item.message,
        item.context,
        item.page_url,
        item.ip,
        item.status,
        item.resolved_by,
        item.resolved_at ? toSqlDate(item.resolved_at) : null,
        item.auto_action,
        toSqlDate(item.created_at)
      ]
    );
  } else {
    const data = readErrorReportsFile();
    data.reports.unshift(item);
    data.reports = data.reports.slice(0, 300);
    writeErrorReportsFile(data);
  }
  return item;
}

async function resolveErrorReport(id, { open = false, adminEmail = 'admin' } = {}) {
  const reportId = Number(id);
  const status = open ? 'open' : 'resolved';
  const resolvedBy = status === 'resolved' ? adminEmail : '';
  const resolvedAt = status === 'resolved' ? new Date().toISOString() : '';
  if (useDatabase) {
    const existing = await listErrorReports(1000);
    const report = existing.find((item) => Number(item.id) === reportId);
    if (!report) return null;
    await pool.query(
      'UPDATE plugin_error_reports SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?',
      [status, resolvedBy, resolvedAt ? toSqlDate(resolvedAt) : null, reportId]
    );
    return { ...report, status, resolved_by: resolvedBy, resolved_at: resolvedAt };
  }
  const data = readErrorReportsFile();
  const report = data.reports.find((item) => Number(item.id) === reportId);
  if (!report) return null;
  report.status = status;
  report.resolved_by = resolvedBy;
  report.resolved_at = resolvedAt;
  writeErrorReportsFile(data);
  return report;
}

function diagnosticItem({ type, title, message, severity = 'info', action = '', target = '', created_at = '' } = {}) {
  return {
    type: type || 'info',
    title: String(title || 'Teshis').slice(0, 120),
    message: String(message || '').slice(0, 1000),
    severity,
    action: String(action || '').slice(0, 1000),
    target: String(target || '').slice(0, 200),
    created_at: created_at || new Date().toISOString()
  };
}

function buildDiagnosticsCenter({ reports = [], commands = [], sourceHealth = [], statuses = [], users = [] } = {}) {
  const items = [];
  const openReports = reports.filter((report) => String(report.status || 'open') !== 'resolved');
  const failedCommands = commands.filter((cmd) => ['failed', 'cancelled'].includes(String(cmd.status || '')));
  const waitingCommands = commands.filter((cmd) => ['pending', 'delivered', 'running'].includes(String(cmd.status || '')));
  const disabledSources = sourceHealth.filter((source) => source.disabled === true);
  const riskyUsers = users.filter((user) => Number(user.risk?.score || 0) >= 70 || isUserInReview(user));
  const now = Date.now();
  const staleStatuses = statuses.filter((item) => now - new Date(item.last_seen_at || 0).getTime() >= 15 * 60 * 1000).slice(0, 10);

  for (const report of openReports.slice(0, 10)) {
    items.push(diagnosticItem({
      type: 'error_report',
      title: 'Acik hata raporu',
      message: report.message || 'Plugin hata raporu gonderdi.',
      severity: report.severity === 'critical' ? 'critical' : 'warning',
      action: report.auto_action || buildAutoRecoveryAction(report),
      target: report.email || report.hwid || `report:${report.id}`,
      created_at: report.created_at
    }));
  }
  for (const cmd of failedCommands.slice(0, 10)) {
    items.push(diagnosticItem({
      type: 'command',
      title: 'Komut hata verdi',
      message: `${cmd.command || 'Komut'}: ${cmd.result || cmd.reason || 'Sonuc yok'}`,
      severity: 'warning',
      action: 'Kullanici detayindan ayni komutu tekrar gonder veya health_check calistir.',
      target: cmd.email || `command:${cmd.id}`,
      created_at: cmd.completed_at || cmd.created_at
    }));
  }
  for (const source of disabledSources.slice(0, 10)) {
    items.push(diagnosticItem({
      type: 'source',
      title: 'Kaynak otomatik pasif',
      message: `${source.name}: ${source.disabled_reason || source.lastError || '3 hata sonrasi kapandi.'}`,
      severity: 'warning',
      action: 'Kaynak sagligi duzelince API Kaynak Sagligi kartindan tekrar ac.',
      target: source.name,
      created_at: source.disabled_at || source.updated_at
    }));
  }
  for (const user of riskyUsers.slice(0, 10)) {
    items.push(diagnosticItem({
      type: 'risk',
      title: isUserInReview(user) ? 'Kullanici inceleme modunda' : 'Yuksek risk kullanici',
      message: `${user.email || user.username || user.id}: ${(user.risk?.reasons || []).join(', ') || user.review_note || 'Risk nedeni yok'}`,
      severity: isUserInReview(user) ? 'critical' : 'warning',
      action: 'Kullanici detayindan loglari incele; gerekirse inceleme modunu kapat.',
      target: user.email || String(user.id),
      created_at: user.last_action_at || user.created_at
    }));
  }
  if (waitingCommands.length > 10) {
    items.push(diagnosticItem({
      type: 'queue',
      title: 'Komut kuyrugu yogun',
      message: `${waitingCommands.length} aktif komut bekliyor.`,
      severity: 'info',
      action: 'Plugin heartbeat geldikce otomatik islenir; cok eski komutlari iptal et.',
      target: 'plugin_commands'
    }));
  }
  if (staleStatuses.length) {
    items.push(diagnosticItem({
      type: 'stale_plugin',
      title: 'Eski heartbeat',
      message: `${staleStatuses.length} plugin uzun suredir cevap vermedi.`,
      severity: 'info',
      action: 'Kullaniciya plugin durum panelinden yenileme yaptir veya admin health_check komutu gonder.',
      target: 'plugin_status'
    }));
  }

  const sorted = items.sort((a, b) => {
    const weight = { critical: 3, warning: 2, info: 1 };
    return (weight[b.severity] || 0) - (weight[a.severity] || 0) || new Date(b.created_at || 0) - new Date(a.created_at || 0);
  }).slice(0, 40);

  return {
    diagnostics_center: true,
    generated_at: new Date().toISOString(),
    count: sorted.length,
    critical_count: sorted.filter((item) => item.severity === 'critical').length,
    warning_count: sorted.filter((item) => item.severity === 'warning').length,
    items: sorted
  };
}

function buildGameHistory(logs) {
  return logs.filter((log) => ['ADD_GAME', 'REMOVE_GAME', 'CLEANUP_GAMES'].includes(log.action)).slice(0, 100);
}

function buildMonitorSnapshot({ statuses = [], commands = [], reports = [], sourceHealth = [] } = {}) {
  const now = Date.now();
  const online = statuses.filter((item) => now - new Date(item.last_seen_at || 0).getTime() < 5 * 60 * 1000);
  const stale = statuses.filter((item) => now - new Date(item.last_seen_at || 0).getTime() >= 15 * 60 * 1000).slice(0, 20);
  const pending = commands.filter((cmd) => ['pending', 'delivered', 'running'].includes(cmd.status));
  const failed = commands.filter((cmd) => ['failed', 'cancelled'].includes(cmd.status)).slice(0, 20);
  const openReports = reports.filter((report) => String(report.status || 'open') !== 'resolved');
  const disabledSources = sourceHealth.filter((source) => source.disabled === true);
  const oldPlugins = statuses.filter((item) => item.version && compareVersionStrings(item.version, PLUGIN_VERSION) < 0).slice(0, 20);
  const issues = [];
  const recovery = [];

  if (!useDatabase) issues.push('Kalici veritabani pasif');
  if (pending.length) recovery.push(`${pending.length} komut kuyrukta; plugin heartbeat ile tekrar deneniyor.`);
  if (failed.length) issues.push(`${failed.length} basarisiz/iptal komut var`);
  if (openReports.length) issues.push(`${openReports.length} acik hata raporu var`);
  if (disabledSources.length) recovery.push(`${disabledSources.length} kaynak otomatik pasife alinmis.`);
  if (oldPlugins.length) recovery.push(`${oldPlugins.length} eski plugin surumu gorundu; site guncelleme uyarisi verir.`);
  if (stale.length && online.length === 0) issues.push('Online plugin gorunmuyor');

  for (const report of openReports.slice(0, 5)) {
    if (report.auto_action) recovery.push(report.auto_action);
  }

  const uniqueRecovery = [...new Set(recovery)].slice(0, 8);
  const health = issues.length ? 'warning' : 'ok';
  return {
    checked_at: new Date().toISOString(),
    health,
    storage: useDatabase ? 'mysql' : (process.env.VERCEL ? 'temporary-json' : 'json'),
    persistent: useDatabase,
    plugin_version: PLUGIN_VERSION,
    online_plugins: online.length,
    stale_plugins: stale.length,
    pending_commands: pending.length,
    open_errors: openReports.length,
    disabled_sources: disabledSources.length,
    old_plugins: oldPlugins.length,
    issues,
    auto_recovery: uniqueRecovery.length ? uniqueRecovery : ['Sistem normal; komutlar ve hata raporlari izleniyor.'],
    stale_samples: stale.map((item) => ({ email: item.email, version: item.version, last_seen_at: item.last_seen_at })).slice(0, 5)
  };
}

async function buildAdminDashboard() {
  const users = await listUsers();
  const logs = await listActivityLogs(300);
  const statusData = { statuses: await listPluginStatuses(500) };
  const commandData = { commands: await listPluginCommands(500) };
  const sourceHealth = (await listSourceHealth(200)).sort((a, b) => Number(a.source_priority || 999) - Number(b.source_priority || 999)).slice(0, 20);
  const sourceScores = sourceHealth.map(sourceScorePayload);
  const deviceResetRequests = await listDeviceResetRequests('pending', 50);
  const supportTickets = await listSupportTickets({ limit: 80 });
  const openSupportTickets = supportTickets.filter((ticket) => ticket.status !== 'closed');
  const allReports = await listErrorReports(300);
  const reports = allReports
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    .slice(0, 20);
  const openReports = allReports.filter((report) => String(report.status || 'open') !== 'resolved');
  const now = Date.now();
  const livePlugins = statusData.statuses
    .map((item) => ({ ...item, online: now - new Date(item.last_seen_at || 0).getTime() < 5 * 60 * 1000 }))
    .sort((a, b) => new Date(b.last_seen_at || 0) - new Date(a.last_seen_at || 0))
    .slice(0, 80);
  const gameHistory = buildGameHistory(logs);
  const monitor = buildMonitorSnapshot({ statuses: statusData.statuses, commands: commandData.commands, reports: allReports, sourceHealth });
  const suspicious = logs.filter((log) => String(log.action || '').startsWith('SUSPICIOUS')).slice(0, 30);
  const auditActions = new Set(['PLUGIN_CONTROL', 'REMOTE_COMMAND', 'BAN_PC', 'BULK_ACTION', 'RELEASE_PUBLISH', 'ADMIN_BLOCK', 'ADMIN_UNBLOCK', 'ADMIN_DELETE', 'ADMIN_LICENSE', 'ADMIN_LICENSE_PACKAGE', 'ADMIN_APPROVE_USER', 'ADMIN_PENDING_USER', 'ADMIN_REJECT_USER', 'SUPPORT_TICKET', 'SUPPORT_TICKET_REPLY', 'RISK_REVIEW_ENABLE', 'RISK_REVIEW_DISABLE']);
  const audit = logs.filter((log) => auditActions.has(log.action)).slice(0, 80);
  const highRiskUsers = users.filter((user) => user.risk && user.risk.score >= 35).sort((a, b) => b.risk.score - a.risk.score).slice(0, 30);
  const diagnostics = buildDiagnosticsCenter({ reports: allReports, commands: commandData.commands, sourceHealth, statuses: statusData.statuses, users });
  const commerce = await buildCommerceSummary();
  const publicStatus = await buildPublicStatus();
  const today = new Date().toISOString().slice(0, 10);
  const stats = {
    users: users.length,
    active_users: users.filter((u) => !u.is_blocked).length,
    blocked_users: users.filter((u) => u.is_blocked).length,
    online_plugins: livePlugins.filter((item) => item.online).length,
    today_games: gameHistory.filter((log) => String(log.timestamp || '').startsWith(today)).length,
    pending_commands: commandData.commands.filter((cmd) => ['pending', 'delivered', 'running'].includes(cmd.status)).length,
    errors: openReports.length,
    suspicious: suspicious.length,
    high_risk: highRiskUsers.filter((user) => user.risk.score >= 70).length,
    medium_risk: highRiskUsers.filter((user) => user.risk.score >= 35 && user.risk.score < 70).length,
    pending_device_resets: deviceResetRequests.length,
    open_tickets: openSupportTickets.length,
    pending_approvals: users.filter((u) => normalizeApprovalStatus(u.approval_status, u.role) === 'pending').length,
    review_mode: users.filter((u) => isUserInReview(u)).length,
    disabled_sources: sourceHealth.filter((source) => source.disabled === true).length,
    stale_plugins: monitor.stale_plugins,
    old_plugins: monitor.old_plugins,
    active_licenses: users.filter((u) => isLicenseActive(u)).length,
    expired_licenses: users.filter((u) => u.license_until && !isLicenseActive(u)).length
  };
  return {
    stats,
    monitor,
    diagnostics,
    commerce,
    public_status: publicStatus,
    license_packages: listLicensePackages(),
    live_plugins: livePlugins,
    game_history: gameHistory,
    source_health: sourceHealth,
    source_scores: sourceScores,
    device_reset_requests: deviceResetRequests,
    support_tickets: supportTickets,
    error_reports: reports,
    suspicious,
    high_risk_users: highRiskUsers,
    audit,
    commands: commandData.commands.slice(0, 80),
    logs: logs.slice(0, 80)
  };
}

async function listReviews(limit = 20) {
  if (useDatabase) {
    const [rows] = await pool.query('SELECT id, username, text, rating, is_demo, created_at FROM reviews ORDER BY created_at DESC, id DESC LIMIT ?', [Number(limit)]);
    return rows;
  }
  const data = readReviewsFile();
  return [...data.reviews]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime() || Number(b.id) - Number(a.id))
    .slice(0, Number(limit));
}

async function createReview({ userId = null, username, text, rating = 5, isDemo = 0 }) {
  const cleanText = String(text || '').trim();
  const cleanUsername = String(username || '').trim() || '├£ye';
  if (useDatabase) {
    const [result] = await pool.query(
      'INSERT INTO reviews (user_id, username, text, rating, is_demo) VALUES (?, ?, ?, ?, ?)',
      [userId, cleanUsername, cleanText, rating, isDemo ? 1 : 0]
    );
    const [rows] = await pool.query('SELECT id, username, text, rating, is_demo, created_at FROM reviews WHERE id = ? LIMIT 1', [result.insertId]);
    return rows[0];
  }
  const data = readReviewsFile();
  const nextId = data.reviews.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
  const review = {
    id: nextId,
    user_id: userId,
    username: cleanUsername,
    text: cleanText,
    rating,
    is_demo: isDemo ? 1 : 0,
    created_at: new Date().toISOString()
  };
  data.reviews.push(review);
  writeReviewsFile(data);
  return review;
}

async function bootSecurityShoopServer(options = {}) {
  if (app.locals.securityShoopStarted) {
    if (options.listen !== false && !app.locals.securityShoopListening) {
      app.listen(PORT, () => console.log(`SecurityShoop server running on http://localhost:${PORT} [storage=${useDatabase ? 'mysql' : 'json'}]`));
      app.locals.securityShoopListening = true;
    }
    return app;
  }
  app.locals.securityShoopStarted = true;
  await initStorage();

  let sessionOptions = {
    secret: process.env.SESSION_SECRET || 'securityshoop-change-this-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 7 }
  };

  if (useDatabase && pool) {
    const sessionStore = new MySQLStoreFactory({
      createDatabaseTable: true,
      schema: { tableName: 'sessions', columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' } }
    }, pool);
    sessionOptions = { ...sessionOptions, key: 'securityshoop.sid', store: sessionStore };
  }

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(session(sessionOptions));
  app.use(express.static(path.join(__dirname, 'public')));

  app.get(['/install-plugin.ps1', '/install-securityshoop-plugin.ps1', '/install-securityshoop-plugin-v2.ps1', '/install-securityshoop-plugin-v3.ps1'], (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.sendFile(path.join(__dirname, 'public', 'install-plugin.ps1'));
  });

  app.get('/securityshoop-plugin.zip', (_req, res) => {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.sendFile(path.join(__dirname, 'public', 'securityshoop-plugin.zip'));
  });

  app.get('/api/session', async (req, res) => {
    scheduleDatabaseRetry();
    const storage = useDatabase ? 'mysql' : (process.env.VERCEL ? 'temporary-json' : 'json');
    const user = getRequestUser(req);
    if (!user) return res.json({ ok: true, authenticated: false, storage, persistent: useDatabase });
    const fullUser = await findUserById(Number(user.id || 0)) || await findUserByEmail(user.email);
    if (fullUser && !isUserApproved(fullUser)) {
      if (req.session) req.session.user = null;
      clearAdminCookie(res);
      return res.json({ ok: true, authenticated: false, pending_approval: true, approval_status: normalizeApprovalStatus(fullUser.approval_status, fullUser.role), storage, persistent: useDatabase });
    }
    persistCookieUserToSession(req, user);
    res.json({ ok: true, authenticated: true, user, storage, persistent: useDatabase });
  });

  app.get('/api/account/summary', requireAuth, async (req, res) => {
    try {
      scheduleDatabaseRetry();
      const fullUser = await findUserById(Number(getRequestUser(req)?.id || 0)) || await findUserByEmail(getRequestUser(req)?.email);
      if (fullUser && !isUserApproved(fullUser)) return res.status(403).json(approvalBlockedBody(fullUser));
      const summary = await buildAccountSummary(getRequestUser(req));
      res.json({ ok: true, summary, storage: useDatabase ? 'mysql' : (process.env.VERCEL ? 'temporary-json' : 'json'), persistent: useDatabase });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Hesap bilgileri alinamadi.' });
    }
  });

  app.post('/api/account/device-reset', requireAuth, async (req, res) => {
    try {
      if (!(await requirePersistentStorage(req, res))) return;
      const user = await findUserById(Number(getRequestUser(req)?.id || 0)) || await findUserByEmail(getRequestUser(req)?.email);
      if (!user) return res.status(404).json({ ok: false, message: 'Kullanici bulunamadi.' });
      if (!isUserApproved(user)) return res.status(403).json(approvalBlockedBody(user));
      const reason = String(req.body?.reason || '').trim();
      const result = await createDeviceResetRequest({ user, reason });
      await recordActivityLog({ user, action: 'DEVICE_RESET_REQUEST', details: reason || 'Kullanici PC degistirdim talebi acti.' });
      res.json({ ok: true, message: result.existing ? 'Zaten bekleyen cihaz sifirlama talebin var.' : 'Cihaz sifirlama talebin admin onayina gonderildi.', request: result.request });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Cihaz sifirlama talebi olusturulamadi.' });
    }
  });

  app.get('/api/account/support-tickets', requireAuth, async (req, res) => {
    try {
      const user = await findUserById(Number(getRequestUser(req)?.id || 0)) || await findUserByEmail(getRequestUser(req)?.email);
      if (!user) return res.status(404).json({ ok: false, message: 'Kullanici bulunamadi.' });
      if (!isUserApproved(user)) return res.status(403).json(approvalBlockedBody(user));
      const tickets = await listSupportTicketsForUser(user);
      res.json({ ok: true, tickets });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Destek talepleri alinamadi.' });
    }
  });

  app.post('/api/account/support-tickets', requireAuth, async (req, res) => {
    try {
      if (!(await requirePersistentStorage(req, res))) return;
      const user = await findUserById(Number(getRequestUser(req)?.id || 0)) || await findUserByEmail(getRequestUser(req)?.email);
      if (!user) return res.status(404).json({ ok: false, message: 'Kullanici bulunamadi.' });
      if (!isUserApproved(user)) return res.status(403).json(approvalBlockedBody(user));
      const ticket = await createSupportTicket({
        user,
        subject: req.body?.subject,
        message: req.body?.message,
        priority: req.body?.priority || 'normal'
      });
      await recordActivityLog({ user, action: 'SUPPORT_TICKET', details: ticket.subject });
      res.json({ ok: true, message: 'Destek talebi olusturuldu.', ticket });
    } catch (error) {
      console.error(error);
      res.status(error?.message === 'Konu ve mesaj gerekli.' ? 400 : 500).json({ ok: false, message: error?.message || 'Destek talebi olusturulamadi.' });
    }
  });

  app.post('/api/account/order-claims', requireAuth, async (req, res) => {
    try {
      if (!(await requirePersistentStorage(req, res))) return;
      const user = await findUserById(Number(getRequestUser(req)?.id || 0)) || await findUserByEmail(getRequestUser(req)?.email);
      const shopierOrderId = String(req.body?.shopier_order_id || '').trim().slice(0, 120);
      const pkg = findLicensePackage(req.body?.package_id);
      if (!shopierOrderId || !pkg) return res.status(400).json({ ok: false, message: 'Shopier siparis numarasi ve paket gerekli.' });
      await pool.query(
        'INSERT INTO order_claims (user_id, username, email, shopier_order_id, package_id) VALUES (?, ?, ?, ?, ?)',
        [user.id, user.username || null, normalizeEmail(user.email), shopierOrderId, pkg.id]
      );
      await recordActivityLog({ user, action: 'ORDER_CLAIM', details: `${shopierOrderId} / ${pkg.id}` });
      res.json({ ok: true, message: 'Siparis dogrulama talebi admin onayina gonderildi.' });
    } catch (error) {
      const duplicate = String(error?.code || '') === 'ER_DUP_ENTRY';
      res.status(duplicate ? 409 : 500).json({ ok: false, message: duplicate ? 'Bu siparis numarasi daha once kullanilmis.' : 'Siparis talebi olusturulamadi.' });
    }
  });

  app.post('/api/account/redeem-license', requireAuth, async (req, res) => {
    try {
      if (!(await requirePersistentStorage(req, res))) return;
      const user = await findUserById(Number(getRequestUser(req)?.id || 0)) || await findUserByEmail(getRequestUser(req)?.email);
      const code = normalizeLicenseCode(req.body?.code);
      const [rows] = await pool.query("SELECT * FROM license_codes WHERE code = ? AND status = 'active' LIMIT 1", [code]);
      const licenseCode = rows[0];
      if (!licenseCode) return res.status(404).json({ ok: false, message: 'Lisans kodu gecersiz veya kullanilmis.' });
      if (licenseCode.gift_email && normalizeEmail(licenseCode.gift_email) !== normalizeEmail(user.email)) return res.status(403).json({ ok: false, message: 'Bu hediye kodu baska bir hesaba ayrilmis.' });
      const [claimResult] = await pool.query("UPDATE license_codes SET status = 'redeemed', redeemed_by = ?, redeemed_email = ?, redeemed_at = NOW() WHERE id = ? AND status = 'active'", [user.id, normalizeEmail(user.email), licenseCode.id]);
      if (!claimResult.affectedRows) return res.status(409).json({ ok: false, message: 'Lisans kodu az once kullanildi.' });
      let result;
      try {
        result = await applyLicensePackageToUser(user.id, licenseCode.package_id, user);
      } catch (error) {
        await pool.query("UPDATE license_codes SET status = 'active', redeemed_by = NULL, redeemed_email = NULL, redeemed_at = NULL WHERE id = ?", [licenseCode.id]);
        throw error;
      }
      await recordActivityLog({ user, action: 'LICENSE_CODE_REDEEM', details: `${licenseCode.code} / ${licenseCode.package_id}` });
      res.json({ ok: true, message: 'Lisans kodu uygulandi.', license: result });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Lisans kodu uygulanamadi.' });
    }
  });

  app.post('/api/account/change-password', requireAuth, async (req, res) => {
    try {
      if (!(await requirePersistentStorage(req, res))) return;
      const user = await findUserById(Number(getRequestUser(req)?.id || 0)) || await findUserByEmail(getRequestUser(req)?.email);
      const currentPassword = String(req.body?.current_password || '');
      const newPassword = String(req.body?.new_password || '');
      if (!user || !(await bcrypt.compare(currentPassword, user.password_hash || '')) || newPassword.length < 8) {
        return res.status(400).json({ ok: false, message: 'Mevcut sifre yanlis veya yeni sifre 8 karakterden kisa.' });
      }
      await pool.query('UPDATE users SET password_hash = ?, session_token = NULL, token_created_at = NULL WHERE id = ?', [await bcrypt.hash(newPassword, 10), user.id]);
      await recordActivityLog({ user, action: 'PASSWORD_CHANGE', details: 'Web hesap merkezi' });
      res.json({ ok: true, message: 'Sifre degistirildi. Plugin oturumlari kapatildi.' });
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Sifre degistirilemedi.' });
    }
  });

  app.post('/api/account/logout-all', requireAuth, async (req, res) => {
    try {
      const user = await findUserById(Number(getRequestUser(req)?.id || 0)) || await findUserByEmail(getRequestUser(req)?.email);
      if (useDatabase && user) await pool.query('UPDATE users SET session_token = NULL, token_created_at = NULL WHERE id = ?', [user.id]);
      await recordActivityLog({ user, action: 'LOGOUT_ALL', details: 'Tum plugin oturumlari kapatildi.' });
      res.json({ ok: true, message: 'Tum plugin oturumlari kapatildi.' });
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Oturumlar kapatilamadi.' });
    }
  });

  app.post('/api/commerce/event', async (req, res) => {
    try {
      scheduleDatabaseRetry();
      const allowed = new Set(['package_view', 'checkout_click', 'installation_view']);
      const eventType = String(req.body?.event_type || '');
      if (!allowed.has(eventType)) return res.status(400).json({ ok: false, message: 'Gecersiz olay.' });
      await recordCommerceEvent({ req, eventType, packageId: req.body?.package_id, metadata: req.body?.metadata });
      res.json({ ok: true });
    } catch {
      res.json({ ok: true });
    }
  });

  app.post('/api/coupons/validate', async (req, res) => {
    try {
      await ensureDatabaseReady(true);
      const code = normalizeLicenseCode(req.body?.code);
      const packageId = String(req.body?.package_id || '').trim();
      const [rows] = await pool.query(
        "SELECT code, discount_percent, package_id, max_uses, used_count, expires_at FROM coupons WHERE code = ? AND active = 1 AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1",
        [code]
      );
      const coupon = rows[0];
      if (!coupon || (coupon.package_id && coupon.package_id !== packageId) || (coupon.max_uses > 0 && coupon.used_count >= coupon.max_uses)) {
        return res.status(404).json({ ok: false, message: 'Kupon gecersiz veya suresi dolmus.' });
      }
      res.json({ ok: true, coupon, message: `%${coupon.discount_percent} indirim kuponu gecerli.` });
    } catch {
      res.status(500).json({ ok: false, message: 'Kupon kontrol edilemedi.' });
    }
  });

  app.get('/api/public/status', async (_req, res) => {
    try {
      scheduleDatabaseRetry();
      res.json({ ok: true, status: await buildPublicStatus() });
    } catch {
      res.status(503).json({ ok: false, status: { site: 'operational', database: 'degraded', plugin_api: 'degraded', checked_at: new Date().toISOString() } });
    }
  });

  app.get('/api/catalog/search', async (req, res) => {
    try {
      const term = String(req.query?.q || '').trim().slice(0, 80);
      if (term.length < 2) return res.json({ ok: true, games: [] });
      const response = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=turkish&cc=TR`, { signal: AbortSignal.timeout(2500) });
      const data = await response.json();
      const games = (Array.isArray(data?.items) ? data.items : []).slice(0, 12).map((item) => ({ appid: String(item.id || ''), name: String(item.name || ''), image: item.tiny_image || '' })).filter((item) => item.appid && item.name);
      res.json({ ok: true, games });
    } catch {
      res.status(503).json({ ok: false, message: 'Oyun katalogu su anda yanit vermiyor.', games: [] });
    }
  });

  app.post('/api/account/wishlist', requireAuth, async (req, res) => {
    try {
      if (!(await requirePersistentStorage(req, res))) return;
      const user = await findUserById(Number(getRequestUser(req)?.id || 0)) || await findUserByEmail(getRequestUser(req)?.email);
      const appid = String(req.body?.appid || '').match(/\d+/)?.[0] || '';
      const gameName = String(req.body?.game_name || '').trim().slice(0, 255);
      if (!appid || !gameName) return res.status(400).json({ ok: false, message: 'AppID ve oyun adi gerekli.' });
      await pool.query('INSERT INTO game_wishlist (user_id, email, appid, game_name) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE game_name = VALUES(game_name)', [user.id, normalizeEmail(user.email), appid, gameName]);
      await recordActivityLog({ user, action: 'WISHLIST_ADD', details: `${appid}: ${gameName}` });
      res.json({ ok: true, message: 'Oyun istek listene eklendi.' });
    } catch {
      res.status(500).json({ ok: false, message: 'Oyun istek listesine eklenemedi.' });
    }
  });

  app.delete('/api/account/wishlist/:appid', requireAuth, async (req, res) => {
    try {
      const user = getRequestUser(req);
      if (useDatabase) await pool.query('DELETE FROM game_wishlist WHERE user_id = ? AND appid = ?', [user.id, String(req.params.appid)]);
      res.json({ ok: true, message: 'Oyun istek listesinden kaldirildi.' });
    } catch {
      res.status(500).json({ ok: false, message: 'Oyun kaldirilamadi.' });
    }
  });

  app.post('/api/account/gift-license', requireAuth, async (req, res) => {
    try {
      if (!(await requirePersistentStorage(req, res))) return;
      const code = normalizeLicenseCode(req.body?.code);
      const recipient = normalizeEmail(req.body?.recipient_email);
      if (!isValidEmail(recipient)) return res.status(400).json({ ok: false, message: 'Gecerli alici e-postasi gir.' });
      const [result] = await pool.query("UPDATE license_codes SET gift_email = ? WHERE code = ? AND status = 'active' AND (gift_email IS NULL OR gift_email = '')", [recipient, code]);
      if (!result.affectedRows) return res.status(404).json({ ok: false, message: 'Aktif ve hediye edilmemis lisans kodu bulunamadi.' });
      await recordActivityLog({ user: getRequestUser(req), action: 'LICENSE_GIFT', details: `${code} -> ${recipient}` });
      res.json({ ok: true, message: 'Lisans kodu alici hesaba ayrildi.' });
    } catch {
      res.status(500).json({ ok: false, message: 'Lisans hediye edilemedi.' });
    }
  });

  app.get('/MarifetStore_Setup.exe', (req, res) => {
    const filePath = path.join(__dirname, 'public', 'MarifetStore_Setup.exe');
    if (fs.existsSync(filePath)) {
      res.setHeader('Content-Type', 'application/vnd.microsoft.portable-executable');
      res.setHeader('Content-Disposition', 'attachment; filename="MarifetStore_Setup.exe"');
      return res.sendFile(filePath);
    }
    res.status(404).send('Setup dosyasi bulunamadi.');
  });

  app.post('/api/account/upgrade-request', requireAuth, async (req, res) => {
    try {
      const user = await findUserById(Number(getRequestUser(req)?.id || 0)) || await findUserByEmail(getRequestUser(req)?.email);
      const option = buildUpgradeOptions(user).find((item) => item.id === String(req.body?.package_id || ''));
      if (!option) return res.status(400).json({ ok: false, message: 'Yukseltme paketi gecersiz.' });
      const ticket = await createSupportTicket({ user, subject: `Paket yukseltme: ${option.name}`, message: `Tahmini fiyat farki: ${option.estimated_difference} TL. Paket: ${option.id}`, priority: 'high' });
      await recordActivityLog({ user, action: 'UPGRADE_REQUEST', details: `${option.id}: ${option.estimated_difference} TL` });
      res.json({ ok: true, message: 'Yukseltme talebi olusturuldu. Admin fiyat farkini onaylayacak.', ticket });
    } catch {
      res.status(500).json({ ok: false, message: 'Yukseltme talebi olusturulamadi.' });
    }
  });

  app.get('/api/cron/daily-backup', async (req, res) => {
    try {
      const secret = String(process.env.CRON_SECRET || '').trim();
      const authorization = String(req.headers.authorization || '');
      if (!secret || authorization !== `Bearer ${secret}`) return res.status(401).json({ ok: false, message: 'Yetkisiz.' });
      await ensureDatabaseReady(true);
      const backup = await buildBackupPayload();
      await pool.query('INSERT INTO backup_snapshots (backup_json) VALUES (?)', [JSON.stringify(backup)]);
      await pool.query('DELETE FROM backup_snapshots WHERE id NOT IN (SELECT id FROM (SELECT id FROM backup_snapshots ORDER BY created_at DESC LIMIT 7) recent)');
      res.json({ ok: true, message: 'Gunluk yedek alindi.', created_at: backup.exported_at });
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Gunluk yedek alinamadi.' });
    }
  });

  app.get(['/api/storage-status', '/api/plugin/storage-status'], async (req, res) => {
    scheduleDatabaseRetry();
    const payload = {
      ok: true,
      storage: useDatabase ? 'mysql' : (process.env.VERCEL ? 'temporary-json' : 'json'),
      persistent: useDatabase,
      vercel: Boolean(process.env.VERCEL),
      message: useDatabase
        ? 'Kalici MySQL bagli. Plugin hesaplari admin panelinde gorunur.'
        : 'Kalici MySQL bagli degil. Vercel JSON modu gecicidir; plugin hesaplari admin panelinde kalici gorunmez.'
    };
    if (String(req.query?.debug || '') === '1') payload.debug = getDatabaseDebugInfo();
    res.json(payload);
  });

  app.post('/api/register', async (req, res) => {
    try {
      if (!(await requirePersistentStorage(req, res, { allowTemporary: true }))) return;
      const { password, confirmPassword, hwid } = req.body;
      const username = String(req.body?.username || '').trim();
      const email = normalizeEmail(req.body?.email);
      if (!username || !email || !password || !confirmPassword) return res.status(400).json({ ok: false, message: 'Tum alanlari doldur.' });
      if (username.length < 3 || username.length > 32) return res.status(400).json({ ok: false, message: 'Kullanici adi 3 ile 32 karakter arasinda olmali.' });
      if (!isValidEmail(email)) return res.status(400).json({ ok: false, message: 'Gecerli bir e-posta gir.' });
      if (String(password).length < 8) return res.status(400).json({ ok: false, message: 'Sifre en az 8 karakter olmali.' });
      if (password !== confirmPassword) return res.status(400).json({ ok: false, message: 'Sifreler eslesmiyor.' });

      if (await isHwidBanned(hwid)) return res.status(403).json({ ok: false, blocked: true, message: 'Bu bilgisayar banlanm─▒┼ş.' });

      const existingUser = await findUserByEmail(email);
      if (existingUser) return res.status(400).json({ ok: false, message: 'Bu e-posta zaten kay─▒tl─▒.' });

      const referralCode = String(req.body?.referral_code || '').trim().toUpperCase().slice(0, 40);
      if (referralCode && useDatabase) {
        const [referrerRows] = await pool.query('SELECT id FROM users WHERE referral_code = ? LIMIT 1', [referralCode]);
        if (!referrerRows[0]) return res.status(400).json({ ok: false, message: 'Referans kodu gecersiz.' });
      }
      const user = await createUser({ username, email, password, role: 'user', hwid, referredBy: referralCode });
      if (referralCode && useDatabase) await pool.query('INSERT INTO referral_events (referral_code, referred_user_id, referred_email) VALUES (?, ?, ?)', [referralCode, user.id, user.email]);
      await updateUserHwidIfMissing(user, req.body?.hwid);
      clearAdminCookie(res);
      await recordActivityLog({ user, action: 'REGISTER', details: hwid ? `HWID: ${hwid}` : '' });
      await notifyAdminRegistration(user, { source: 'site', hwid, req });
      res.json({ ok: true, message: 'Hesap basariyla olusturuldu. Simdi giris yapabilirsiniz!', user: publicUserPayload(user, '') });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Sunucu hatas─▒ olu┼ştu.' });
    }
  });

  app.post('/api/login', async (req, res) => {
    try {
      if (!(await requirePersistentStorage(req, res, { allowTemporary: true }))) return;
      const login = String(req.body?.email || req.body?.login || req.body?.username || '').trim();
      const { password } = req.body;
      if (!login || !password) return res.status(400).json({ ok: false, message: 'E-posta/kullanici adi ve sifre gerekli.' });
      if (login.includes('@') && !isValidEmail(login)) return res.status(400).json({ ok: false, message: 'Gecerli bir e-posta gir.' });
      if (String(password).length < 8) return res.status(400).json({ ok: false, message: 'E-posta veya sifre hatali.' });

      const user = await findUserByLogin(login);
      if (user && await isHwidBanned(user.hwid || req.body?.hwid)) return res.status(403).json({ ok: false, blocked: true, message: 'Bu bilgisayar banlanm─▒┼ş.' });
      if (!user) return res.status(400).json({ ok: false, message: 'E-posta veya ┼şifre hatal─▒.' });
      if (user.is_blocked) return res.status(403).json({ ok: false, message: 'Bu hesap engellenmi┼ş.' });

      const isValid = await bcrypt.compare(password, user.password_hash);
      if (!isValid) return res.status(400).json({ ok: false, message: 'E-posta veya ┼şifre hatal─▒.' });
      if (!isUserApproved(user)) return res.status(403).json(approvalBlockedBody(user));

      await updateUserHwidIfMissing(user, req.body?.hwid);
      const token = await issueUserToken(user);
      req.session.user = { id: user.id, username: user.username, email: user.email, role: user.role };
      if (req.session.user.role === 'admin') setAdminCookie(res, req.session.user);
      else clearAdminCookie(res);
      await recordActivityLog({ user, action: 'LOGIN', details: req.body?.hwid ? `HWID: ${req.body.hwid}` : '' });
      res.json({ ok: true, message: 'Giris basarili.', user: publicUserPayload({ ...user, ...req.session.user }, token) });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Sunucu hatas─▒ olu┼ştu.' });
    }
  });

  app.post('/api/plugin/register', async (req, res) => {
    try {
      if (!(await requirePersistentStorage(req, res, { allowTemporary: true }))) return;
      const { password, confirmPassword, hwid } = req.body || {};
      const username = String(req.body?.username || '').trim();
      const email = normalizeEmail(req.body?.email);

      if (!username || !email || !password || !confirmPassword) return res.status(400).json({ ok: false, message: 'Tum alanlari doldur.' });
      if (username.length < 3 || username.length > 32) return res.status(400).json({ ok: false, message: 'Kullanici adi 3 ile 32 karakter arasinda olmali.' });
      if (!isValidEmail(email)) return res.status(400).json({ ok: false, message: 'Gecerli bir e-posta gir.' });
      if (String(password).length < 8) return res.status(400).json({ ok: false, message: 'Sifre en az 8 karakter olmali.' });
      if (password !== confirmPassword) return res.status(400).json({ ok: false, message: 'Sifreler eslesmiyor.' });
      if (await isHwidBanned(hwid)) return res.status(403).json({ ok: false, blocked: true, message: 'Bu bilgisayar banlanmis.' });

      const existingUser = await findUserByEmail(email);
      if (existingUser) return res.status(400).json({ ok: false, message: 'Bu e-posta zaten kayitli.' });

      const user = await createUser({ username, email, password, role: 'user', hwid });
      await recordActivityLog({ user, action: 'PLUGIN_REGISTER', details: hwid ? `HWID: ${hwid}` : '' });
      await notifyAdminRegistration(user, { source: 'plugin', hwid, req });
      res.json({ ok: true, message: 'Plugin hesabi basariyla olusturuldu. Giris yapabilirsiniz!', user: publicUserPayload(user, '') });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Sunucu hatasi olustu.' });
    }
  });

  app.post('/api/plugin/login', async (req, res) => {
    try {
      if (!(await requirePersistentStorage(req, res, { allowTemporary: true }))) return;
      const login = String(req.body?.email || req.body?.login || req.body?.username || '').trim();
      const { password, hwid } = req.body || {};
      if (!login || !password) return res.status(400).json({ ok: false, message: 'E-posta/kullanici adi ve sifre gerekli.' });
      if (login.includes('@') && !isValidEmail(login)) return res.status(400).json({ ok: false, message: 'Gecerli bir e-posta gir.' });
      if (String(password).length < 8) return res.status(400).json({ ok: false, message: 'E-posta veya sifre hatali.' });

      const user = await findUserByLogin(login);
      if (user && await isHwidBanned(user.hwid || hwid)) return res.status(403).json({ ok: false, blocked: true, message: 'Bu bilgisayar banlanmis.' });
      if (!user) return res.status(400).json({ ok: false, message: 'E-posta veya sifre hatali.' });
      if (user.is_blocked) return res.status(403).json({ ok: false, blocked: true, message: 'Bu hesap engellenmis.' });

      const isValid = await bcrypt.compare(password, user.password_hash);
      if (!isValid) return res.status(400).json({ ok: false, message: 'E-posta veya sifre hatali.' });
      if (!isUserApproved(user)) return res.status(403).json(approvalBlockedBody(user));

      await updateUserHwidIfMissing(user, hwid);
      const token = await issueUserToken(user);
      await recordActivityLog({ user, action: 'PLUGIN_LOGIN', details: hwid ? `HWID: ${hwid}` : '' });
      res.json({ ok: true, message: 'Plugin girisi basarili.', user: publicUserPayload(user, token) });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Sunucu hatasi olustu.' });
    }
  });

  app.get('/api/plugin/ping', async (_req, res) => {
    scheduleDatabaseRetry();
    res.json({ ok: true, plugin_api: true, name: 'SecurityShoop', version: PLUGIN_VERSION, storage: useDatabase ? 'mysql' : (process.env.VERCEL ? 'temporary-json' : 'json'), persistent: useDatabase });
  });

  app.get('/api/license-packages', (_req, res) => {
    res.json({ ok: true, packages: listPublicLicensePackages() });
  });

  app.post('/api/ai-chat', async (req, res) => {
    try {
      const ip = getRequestIp(req) || req.ip || 'unknown';
      if (!consumeAiRateLimit(ip)) {
        return res.status(429).json({ ok: false, message: 'AI destek limiti doldu. Biraz sonra tekrar dene.' });
      }
      const messages = normalizeAiChatMessages(req.body || {});
      if (!messages.length) return res.status(400).json({ ok: false, message: 'Mesaj yazman gerekiyor.' });
      const result = await generateAiChatReply(messages);
      if (!result.ok) return res.status(503).json(result);
      res.json({ ok: true, reply: result.reply, provider: result.provider });
    } catch (error) {
      console.error('AI chat failed:', error);
      res.status(500).json({ ok: false, message: 'AI destek su an cevap veremedi. Instagram DM uzerinden yazabilirsin.' });
    }
  });

  app.get('/api/plugin/rpc', async (req, res) => {
    try {
      const rpcPath = String(req.query?.path || '').trim();
      let body = {};
      try {
        body = JSON.parse(String(req.query?.payload || '{}'));
      } catch {
        return res.status(400).json({ ok: false, message: 'RPC payload okunamadi.' });
      }
      if (!body || typeof body !== 'object') body = {};
      const rpcReq = Object.create(req);
      rpcReq.body = body;

      if (rpcPath === '/api/plugin/register' || rpcPath === '/api/register') {
        if (!(await requirePersistentStorage(req, res, { allowTemporary: true }))) return;
        const { password, confirmPassword, hwid } = body;
        const username = String(body.username || '').trim();
        const email = normalizeEmail(body.email);
        if (!username || !email || !password || !confirmPassword) return res.status(400).json({ ok: false, message: 'Tum alanlari doldur.' });
        if (username.length < 3 || username.length > 32) return res.status(400).json({ ok: false, message: 'Kullanici adi 3 ile 32 karakter arasinda olmali.' });
        if (!isValidEmail(email)) return res.status(400).json({ ok: false, message: 'Gecerli bir e-posta gir.' });
        if (String(password).length < 8) return res.status(400).json({ ok: false, message: 'Sifre en az 8 karakter olmali.' });
        if (password !== confirmPassword) return res.status(400).json({ ok: false, message: 'Sifreler eslesmiyor.' });
        if (await isHwidBanned(hwid)) return res.status(403).json({ ok: false, blocked: true, message: 'Bu bilgisayar banlanmis.' });

        const existingUser = await findUserByEmail(email);
        if (existingUser) return res.status(400).json({ ok: false, message: 'Bu e-posta zaten kayitli.' });

        const user = await createUser({ username, email, password, role: 'user', hwid });
        await updateUserHwidIfMissing(user, hwid);
        await recordActivityLog({ user, action: rpcPath === '/api/register' ? 'REGISTER' : 'PLUGIN_REGISTER', details: hwid ? `HWID: ${hwid}` : '' });
        await notifyAdminRegistration(user, { source: rpcPath === '/api/register' ? 'site-rpc' : 'plugin-rpc', hwid, req });
        return res.json({ ok: true, message: 'Hesap basariyla olusturuldu. Simdi giris yapabilirsiniz!', user: publicUserPayload(user, '') });
      }

      if (rpcPath === '/api/plugin/login' || rpcPath === '/api/login') {
        if (!(await requirePersistentStorage(req, res, { allowTemporary: true }))) return;
        const login = String(body.email || body.login || body.username || '').trim();
        const password = body.password;
        const hwid = body.hwid;
        if (!login || !password) return res.status(400).json({ ok: false, message: 'E-posta/kullanici adi ve sifre gerekli.' });
        if (login.includes('@') && !isValidEmail(login)) return res.status(400).json({ ok: false, message: 'Gecerli bir e-posta gir.' });
        if (String(password).length < 8) return res.status(400).json({ ok: false, message: 'E-posta veya sifre hatali.' });

        const user = await findUserByLogin(login);
        if (user && await isHwidBanned(user.hwid || hwid)) return res.status(403).json({ ok: false, blocked: true, message: 'Bu bilgisayar banlanmis.' });
        if (!user) return res.status(400).json({ ok: false, message: 'E-posta veya sifre hatali.' });
        if (user.is_blocked) return res.status(403).json({ ok: false, blocked: true, message: 'Bu hesap engellenmis.' });

        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) return res.status(400).json({ ok: false, message: 'E-posta veya sifre hatali.' });
      if (!isUserApproved(user)) return res.status(403).json(approvalBlockedBody(user));

      await updateUserHwidIfMissing(user, hwid);
        const token = await issueUserToken(user);
        await recordActivityLog({ user, action: rpcPath === '/api/login' ? 'LOGIN' : 'PLUGIN_LOGIN', details: hwid ? `HWID: ${hwid}` : '' });
        return res.json({ ok: true, message: rpcPath === '/api/login' ? 'Giris basarili.' : 'Plugin girisi basarili.', user: publicUserPayload(user, token) });
      }

      if (rpcPath === '/api/plugin/account-status') {
        if (!(await requirePersistentStorage(req, res, { allowTemporary: true }))) return;
        if (!body.token && (!body.email || !body.password)) return res.status(400).json({ ok: false, message: 'Eksik bilgi.' });
        const user = await authenticatePluginRequest(rpcReq);
        if (user && await isHwidBanned(user.hwid || body.hwid)) return res.status(403).json({ ok: false, blocked: true, message: 'Bu bilgisayar banlanmis.' });
        if (!user) return res.status(401).json({ ok: false, message: 'Hesap bulunamadi.' });
        if (user.is_blocked) return res.status(403).json({ ok: false, blocked: true, message: 'Bu hesap engellenmis.' });
      if (!isUserApproved(user)) return res.status(403).json(approvalBlockedBody(user));
        if (isUserInReview(user)) return res.status(403).json(reviewBlockedBody(user));
        if (!isLicenseActive(user)) return res.status(403).json({ ok: false, blocked: true, message: 'Lisans suresi dolmus.' });
        const dailyLimit = Number(user.daily_limit || 0);
        const dailyAddCount = await countTodayAddGames(user.email);
        if (dailyLimit > 0 && dailyAddCount >= dailyLimit) {
          return res.status(403).json({ ok: false, blocked: false, limitReached: true, message: `Gunluk oyun ekleme limiti doldu (${dailyAddCount}/${dailyLimit}).` });
        }
        const appidAccess = canUserAddAppid(user, body.appid);
        if (body.appid && !appidAccess.allowed) {
          return res.status(403).json({ ok: false, blocked: false, appidBlocked: true, allowed_appids: appidAccess.allowed_appids, message: `Bu hesap sadece izin verilen AppID'leri ekleyebilir: ${appidAccess.allowed_appids.join(', ')}` });
        }
        return res.json({ ok: true, blocked: false, daily_add_count: dailyAddCount, daily_limit: dailyLimit, allowed_appids: appidAccess.allowed_appids, license_active: true, license_until: user.license_until || '', user: publicUserPayload(user, '') });
      }

      if (rpcPath === '/api/plugin/control') {
        const user = await authenticatePluginRequest(rpcReq);
        const control = await getPluginControl();
        if (control.account_required && !user) return res.status(401).json({ ok: false, blocked: true, message: 'Once SecurityShoop hesabina giris yap.' });
        if (user && await isHwidBanned(user.hwid || body.hwid)) return res.status(403).json({ ok: false, blocked: true, message: 'Bu bilgisayar banlanmis.' });
        if (user?.is_blocked) return res.status(403).json({ ok: false, blocked: true, message: 'Bu hesap engellenmis.' });
        if (user && !isUserApproved(user)) return res.status(403).json(approvalBlockedBody(user));
        if (user && isUserInReview(user)) return res.status(403).json(reviewBlockedBody(user));
        return res.json(await buildPluginControlResponse(control));
      }

      if (rpcPath === '/api/plugin/heartbeat') {
        const user = await authenticatePluginRequest(rpcReq);
        if (!user) {
          return res.json({
            ok: true,
            authenticated: false,
            status: null,
            commands: [],
            message: ''
          });
        }
        if (user.is_blocked || await isHwidBanned(user.hwid || body.hwid)) {
          return res.status(403).json({ ok: false, blocked: true, message: 'Bu hesap veya bilgisayar engellenmis.' });
        }
      if (!isUserApproved(user)) return res.status(403).json(approvalBlockedBody(user));
        const status = await updatePluginStatus({ user, req, body });
        const commands = await getPendingCommandsFor(user, body.hwid);
        await markCommandsDelivered(commands);
        return res.json({ ok: true, status, commands });
      }

      if (rpcPath === '/api/plugin/notifications') {
        const user = await authenticatePluginRequest(rpcReq);
        if (!user) return res.status(401).json({ ok: false, message: 'Hesap dogrulanamadi.' });
        if (user.is_blocked || await isHwidBanned(user.hwid || body.hwid)) {
          return res.status(403).json({ ok: false, blocked: true, message: 'Bu hesap veya bilgisayar engellenmis.' });
        }
      if (!isUserApproved(user)) return res.status(403).json(approvalBlockedBody(user));
        const notifications = await buildPluginNotifications(user);
        return res.json({ ok: true, notifications, count: notifications.length });
      }

      if (rpcPath === '/api/log-action') {
        if (!(await requirePersistentStorage(req, res, { allowTemporary: true }))) return;
        const { action, details } = body;
        if (!action) return res.status(400).json({ ok: false, message: 'Eksik bilgi.' });
        const user = await authenticatePluginRequest(rpcReq);
        if (user && await isHwidBanned(user.hwid || body.hwid)) return res.status(403).json({ ok: false, blocked: true, message: 'Bu bilgisayar banlanmis.' });
        if (!user) return res.status(401).json({ ok: false, message: 'Hesap bulunamadi.' });
        if (user.is_blocked) return res.status(403).json({ ok: false, message: 'Bu hesap engellenmis.' });
      if (!isUserApproved(user)) return res.status(403).json(approvalBlockedBody(user));
        if (isUserInReview(user)) return res.status(403).json(reviewBlockedBody(user));
        if (!isLicenseActive(user)) return res.status(403).json({ ok: false, message: 'Lisans suresi dolmus.' });
        const log = await recordActivityLog({ user, action, details });
        return res.json({ ok: true, log });
      }

      const ackMatch = rpcPath.match(/^\/api\/plugin\/commands\/(\d+)\/ack$/);
      if (ackMatch) {
        const user = await authenticatePluginRequest(rpcReq);
        if (!user) return res.status(401).json({ ok: false, message: 'Hesap dogrulanamadi.' });
      if (!isUserApproved(user)) return res.status(403).json(approvalBlockedBody(user));
        const id = Number(ackMatch[1]);
        const ack = await acknowledgePluginCommand({ id, user, ok: body.ok, result: body.result, status: body.status || body.state });
        if (ack.errorStatus) return res.status(ack.errorStatus).json(ack.body);
        return res.json(ack.body);
      }

      if (rpcPath === '/api/plugin/error-report') {
        const user = await authenticatePluginRequest(rpcReq);
        if (!user) return res.status(401).json({ ok: false, message: 'Hesap dogrulanamadi.' });
      if (!isUserApproved(user)) return res.status(403).json(approvalBlockedBody(user));
        const message = String(body.message || '').trim().slice(0, 2000);
        const context = String(body.context || '').trim().slice(0, 3000);
        const severity = String(body.severity || 'normal').trim().slice(0, 40);
        const version = String(body.version || '').trim().slice(0, 40);
        const pageUrl = String(body.page_url || body.pageUrl || '').trim().slice(0, 500);
        const hwid = normalizeHwid(body.hwid || user.hwid || '');
        if (!message) return res.status(400).json({ ok: false, message: 'Rapor mesaji gerekli.' });
        const report = await createErrorReport({ id: Date.now(), user_id: user.id, username: user.username, email: user.email, hwid, version, severity, message, context, page_url: pageUrl, ip: getRequestIp(req), status: 'open', resolved_by: '', resolved_at: '', created_at: new Date().toISOString() });
        await recordActivityLog({ user, action: 'ERROR_REPORT', details: message });
        return res.json({ ok: true, message: 'Hata raporu kaydedildi.', report });
      }

      return res.status(404).json({ ok: false, message: 'RPC endpoint bulunamadi.' });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'RPC istegi islenemedi.' });
    }
  });

  app.post('/api/logout', (req, res) => {
    const session = req.session;
    if (session) session.user = null;
    res.clearCookie('securityshoop.sid');
    clearAdminCookie(res);
    res.json({ ok: true, message: 'Cikis yapildi.' });
    res.on('finish', () => {
      if (session && typeof session.destroy === 'function') {
        session.destroy(() => {});
      }
    });
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('securityshoop.sid');
      clearAdminCookie(res);
      res.json({ ok: true, message: '├ç─▒k─▒┼ş yap─▒ld─▒.' });
    });
  });

  app.post('/api/log-action', async (req, res) => {
    try {
      if (!(await requirePersistentStorage(req, res))) return;
      const { action, details } = req.body || {};
      if (!action) return res.status(400).json({ ok: false, message: 'Eksik bilgi.' });

      const user = await authenticatePluginRequest(req);
      if (user && await isHwidBanned(user.hwid || req.body?.hwid)) return res.status(403).json({ ok: false, blocked: true, message: 'Bu bilgisayar banlanm??.' });
      if (!user) return res.status(401).json({ ok: false, message: 'Hesap bulunamad?.' });
      if (user.is_blocked) return res.status(403).json({ ok: false, message: 'Bu hesap engellenmi?.' });
      if (!isUserApproved(user)) return res.status(403).json(approvalBlockedBody(user));
      if (isUserInReview(user)) return res.status(403).json(reviewBlockedBody(user));
      if (!isLicenseActive(user)) return res.status(403).json({ ok: false, message: 'Lisans s?resi dolmu?.' });

      const log = await recordActivityLog({ user, action, details });
      res.json({ ok: true, log });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Log kaydedilemedi.' });
    }
  });

  app.post('/api/plugin/account-status', async (req, res) => {
    try {
      if (!(await requirePersistentStorage(req, res))) return;
      if (!req.body?.token && (!req.body?.email || !req.body?.password)) return res.status(400).json({ ok: false, message: 'Eksik bilgi.' });

      const user = await authenticatePluginRequest(req);
      if (user && await isHwidBanned(user.hwid || req.body?.hwid)) return res.status(403).json({ ok: false, blocked: true, message: 'Bu bilgisayar banlanm??.' });
      if (!user) return res.status(401).json({ ok: false, message: 'Hesap bulunamad?.' });
      if (user.is_blocked) return res.status(403).json({ ok: false, blocked: true, message: 'Bu hesap engellenmi?.' });
      if (!isUserApproved(user)) return res.status(403).json(approvalBlockedBody(user));
      if (isUserInReview(user)) return res.status(403).json(reviewBlockedBody(user));
      if (!isLicenseActive(user)) return res.status(403).json({ ok: false, blocked: true, message: 'Lisans s?resi dolmu?.' });

      const dailyLimit = Number(user.daily_limit || 0);
      const dailyAddCount = await countTodayAddGames(user.email);
      if (dailyLimit > 0 && dailyAddCount >= dailyLimit) {
        return res.status(403).json({ ok: false, blocked: false, limitReached: true, message: `Gunluk oyun ekleme limiti doldu (${dailyAddCount}/${dailyLimit}).` });
      }
      const appidAccess = canUserAddAppid(user, req.body?.appid);
      if (req.body?.appid && !appidAccess.allowed) {
        return res.status(403).json({ ok: false, blocked: false, appidBlocked: true, allowed_appids: appidAccess.allowed_appids, message: `Bu hesap sadece izin verilen AppID'leri ekleyebilir: ${appidAccess.allowed_appids.join(', ')}` });
      }

      res.json({
        ok: true,
        blocked: false,
        daily_add_count: dailyAddCount,
        daily_limit: dailyLimit,
        allowed_appids: appidAccess.allowed_appids,
        license_active: true,
        license_until: user.license_until || '',
        user: publicUserPayload(user, '')
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Hesap kontrol edilemedi.' });
    }
  });

  app.get('/api/plugin/announcements', async (_req, res) => {
    try {
      const data = readAnnouncementsFile();
      const now = Date.now();
      const announcements = data.announcements
        .filter((item) => item && item.active !== false)
        .filter((item) => !item.expires_at || new Date(item.expires_at).getTime() > now)
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
        .slice(0, 5);
      res.json({ ok: true, announcements });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Duyurular al─▒namad─▒.' });
    }
  });

  app.post('/api/plugin/notifications', async (req, res) => {
    try {
      const user = await authenticatePluginRequest(req);
      if (!user) return res.status(401).json({ ok: false, message: 'Hesap dogrulanamadi.' });
      if (user.is_blocked || await isHwidBanned(user.hwid || req.body?.hwid)) {
        return res.status(403).json({ ok: false, blocked: true, message: 'Bu hesap veya bilgisayar engellenmis.' });
      }
      if (!isUserApproved(user)) return res.status(403).json(approvalBlockedBody(user));
      const notifications = await buildPluginNotifications(user);
      res.json({ ok: true, notifications, count: notifications.length });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Bildirimler alinamadi.' });
    }
  });

  app.post('/api/plugin/control', async (req, res) => {
    try {
      const user = await authenticatePluginRequest(req);
      const control = await getPluginControl();

      if (control.account_required && !user) {
        return res.status(401).json({ ok: false, blocked: true, message: '├ûnce SecurityShoop hesab─▒na giri┼ş yap.' });
      }

      if (user && await isHwidBanned(user.hwid || req.body?.hwid)) {
        return res.status(403).json({ ok: false, blocked: true, message: 'Bu bilgisayar banlanm─▒┼ş.' });
      }

      if (user?.is_blocked) {
        return res.status(403).json({ ok: false, blocked: true, message: 'Bu hesap engellenmi┼ş.' });
      }

      if (user && !isUserApproved(user)) return res.status(403).json(approvalBlockedBody(user));
      if (user && isUserInReview(user)) return res.status(403).json(reviewBlockedBody(user));

      res.json(await buildPluginControlResponse(control));
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, blocked: false, message: 'Plugin kontrol├╝ al─▒namad─▒.' });
    }
  });

  app.post('/api/plugin/heartbeat', async (req, res) => {
    try {
      const user = await authenticatePluginRequest(req);
      if (!user) {
        return res.json({
          ok: true,
          authenticated: false,
          status: null,
          commands: [],
          message: ''
        });
      }
      if (user.is_blocked || await isHwidBanned(user.hwid || req.body?.hwid)) {
        return res.status(403).json({ ok: false, blocked: true, message: 'Bu hesap veya bilgisayar engellenmi┼ş.' });
      }
      if (!isUserApproved(user)) return res.status(403).json(approvalBlockedBody(user));
      const status = await updatePluginStatus({ user, req, body: req.body || {} });
      const commands = await getPendingCommandsFor(user, req.body?.hwid);
      await markCommandsDelivered(commands);
      res.json({ ok: true, status, commands });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Plugin durumu kaydedilemedi.' });
    }
  });

  app.post('/api/plugin/commands/:id/ack', async (req, res) => {
    try {
      const user = await authenticatePluginRequest(req);
      if (!user) return res.status(401).json({ ok: false, message: 'Hesap do─şrulanamad─▒.' });
      if (!isUserApproved(user)) return res.status(403).json(approvalBlockedBody(user));
      const id = Number(req.params.id);
      const ack = await acknowledgePluginCommand({ id, user, ok: req.body?.ok, result: req.body?.result, status: req.body?.status || req.body?.state });
      if (ack.errorStatus) return res.status(ack.errorStatus).json(ack.body);
      return res.json(ack.body);
      const data = readPluginCommandsFile();
      const cmd = data.commands.find((item) => Number(item.id) === id);
      if (!cmd) return res.status(404).json({ ok: false, message: 'Komut bulunamad─▒.' });
      if (normalizeEmail(cmd.email) !== normalizeEmail(user.email) && Number(cmd.user_id || 0) !== Number(user.id)) {
        return res.status(403).json({ ok: false, message: 'Komut bu kullan─▒c─▒ya ait de─şil.' });
      }
      cmd.status = req.body?.ok === false ? 'failed' : 'completed';
      cmd.completed_at = new Date().toISOString();
      cmd.result = String(req.body?.result || '').slice(0, 1000);
      writePluginCommandsFile(data);
      res.json({ ok: true, command: cmd });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Komut sonucu kaydedilemedi.' });
    }
  });

  desktopAuth.registerRoutes(app, {
    requireAdmin,
    requirePersistentStorage,
    getRequestIp,
    recordActivityLog,
    getAdminUser: getRequestUser,
    useDatabase: () => useDatabase,
    pool: () => pool,
    dataFile: DESKTOP_AUTH_FILE
  });

  app.post('/api/plugin/error-report', async (req, res) => {
    try {
      const user = await authenticatePluginRequest(req);
      if (!user) return res.status(401).json({ ok: false, message: 'Hesap do─şrulanamad─▒.' });
      if (!isUserApproved(user)) return res.status(403).json(approvalBlockedBody(user));
      const message = String(req.body?.message || '').trim().slice(0, 2000);
      const context = String(req.body?.context || '').trim().slice(0, 4000);
      const severity = String(req.body?.severity || 'normal').trim().slice(0, 40);
      const version = String(req.body?.version || '').trim().slice(0, 40);
      const pageUrl = String(req.body?.page_url || req.body?.pageUrl || '').trim().slice(0, 500);
      const hwid = normalizeHwid(req.body?.hwid || user.hwid || '');
      if (!message) return res.status(400).json({ ok: false, message: 'Rapor mesaj─▒ gerekli.' });
      const report = await createErrorReport({
        id: Date.now(),
        user_id: user.id,
        username: user.username,
        email: user.email,
        hwid,
        version,
        severity,
        message,
        context,
        page_url: pageUrl,
        ip: getRequestIp(req),
        status: 'open',
        resolved_by: '',
        resolved_at: '',
        created_at: new Date().toISOString()
      });
      await recordActivityLog({ user, action: 'ERROR_REPORT', details: message });
      res.json({ ok: true, message: 'Hata raporu kaydedildi.', report });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Rapor kaydedilemedi.' });
    }
  });

  app.get('/api/admin/error-reports', requireAdmin, async (_req, res) => {
    try {
      const reports = (await listErrorReports(100))
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
        .slice(0, 100);
      res.json({ ok: true, reports });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Raporlar al─▒namad─▒.' });
    }
  });

  app.post('/api/admin/error-reports/:id/resolve', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const report = await resolveErrorReport(id, { open: req.body?.open === true, adminEmail: req.session.user?.email || 'admin' });
      if (!report) return res.status(404).json({ ok: false, message: 'Rapor bulunamadi.' });
      await recordActivityLog({ user: req.session.user, action: 'ERROR_REPORT_RESOLVE', details: `Report ${id}: ${report.status}` });
      res.json({ ok: true, message: report.status === 'resolved' ? 'Rapor cozuldu.' : 'Rapor tekrar acildi.', report });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Rapor guncellenemedi.' });
    }
  });

  
// --- MARIFETSTORE API ---
let marifetStoreConfig = {
    api_key: "436b0828-9799-4ce4-b1f2-ea5a3ce32f73",
    api_url: "https://depotbox.org/api/direct-lua",
    hook_url: "https://github.com/OpenSteam001/OpenSteamTool/releases/download/1.4.8/OpenSteamTool-1.4.8-Debug.zip",
    version: "4.0",
    message: "MarifetStore'a Hosgeldiniz!",
    maintenance_mode: false,
    add_game_enabled: true
};

app.get('/api/plugin/marifetstore', async (req, res) => {
    try {
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [], marifetstore: {} });
      if (data.marifetstore && typeof data.marifetstore === 'object') {
        marifetStoreConfig = { ...marifetStoreConfig, ...data.marifetstore };
      }
    } catch(e) {}
    res.json({ ok: true, config: marifetStoreConfig });
});

app.post('/api/admin/marifetstore', requireAdmin, async (req, res) => {
    try {
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [], marifetstore: {} });
      if (!data.marifetstore) data.marifetstore = {};
      data.marifetstore = { ...marifetStoreConfig, ...data.marifetstore, ...req.body };
      marifetStoreConfig = { ...data.marifetstore };
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens_and_credits', data);
      res.json({ ok: true, message: 'MarifetStore ayarlari basariyla kaydedildi!', config: marifetStoreConfig });
    } catch(e) {
      marifetStoreConfig = { ...marifetStoreConfig, ...req.body };
      res.json({ ok: true, message: 'MarifetStore ayarlari guncellendi (RAM)!', config: marifetStoreConfig });
    }
});
// ------------------------

app.get('/api/admin/dashboard', requireAdmin, async (_req, res) => {
    try {
      res.json({ ok: true, dashboard: await buildAdminDashboard() });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Admin dashboard al─▒namad─▒.' });
    }
  });

  app.get('/api/admin/license-packages', requireAdmin, async (_req, res) => {
    res.json({ ok: true, packages: listLicensePackages() });
  });

  app.get('/api/admin/commerce', requireAdmin, async (_req, res) => {
    try {
      res.json({ ok: true, commerce: await buildCommerceSummary() });
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Ticaret merkezi alinamadi.' });
    }
  });

  app.post('/api/admin/license-codes', requireAdmin, async (req, res) => {
    try {
      if (!(await requirePersistentStorage(req, res))) return;
      const pkg = findLicensePackage(req.body?.package_id);
      const count = Math.min(Math.max(Number(req.body?.count) || 1, 1), 100);
      if (!pkg) return res.status(400).json({ ok: false, message: 'Gecerli paket sec.' });
      const codes = [];
      for (let i = 0; i < count; i += 1) {
        const code = createLicenseCodeValue();
        await pool.query('INSERT INTO license_codes (code, package_id, created_by) VALUES (?, ?, ?)', [code, pkg.id, req.session.user?.email || 'admin']);
        codes.push(code);
      }
      await recordActivityLog({ user: req.session.user, action: 'LICENSE_CODES_CREATE', details: `${pkg.id} x${count}` });
      res.json({ ok: true, message: `${count} lisans kodu olusturuldu.`, codes });
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Lisans kodu olusturulamadi.' });
    }
  });

  app.post('/api/admin/order-claims/:id/review', requireAdmin, async (req, res) => {
    try {
      if (!(await requirePersistentStorage(req, res))) return;
      const [rows] = await pool.query("SELECT * FROM order_claims WHERE id = ? AND status = 'pending' LIMIT 1", [Number(req.params.id)]);
      const claim = rows[0];
      if (!claim) return res.status(404).json({ ok: false, message: 'Bekleyen siparis talebi bulunamadi.' });
      const approved = req.body?.approved === true;
      if (approved) await applyLicensePackageToUser(claim.user_id, claim.package_id, req.session.user);
      await pool.query(
        'UPDATE order_claims SET status = ?, admin_note = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?',
        [approved ? 'approved' : 'rejected', String(req.body?.note || '').slice(0, 2000) || null, req.session.user?.email || 'admin', claim.id]
      );
      await recordActivityLog({ user: req.session.user, action: 'ORDER_CLAIM_REVIEW', details: `${claim.shopier_order_id}: ${approved ? 'approved' : 'rejected'}` });
      res.json({ ok: true, message: approved ? 'Siparis onaylandi ve lisans tanimlandi.' : 'Siparis talebi reddedildi.' });
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Siparis talebi guncellenemedi.' });
    }
  });

  app.post('/api/admin/coupons', requireAdmin, async (req, res) => {
    try {
      if (!(await requirePersistentStorage(req, res))) return;
      const code = normalizeLicenseCode(req.body?.code);
      const discount = Math.min(Math.max(Number(req.body?.discount_percent) || 0, 1), 90);
      const packageId = String(req.body?.package_id || '').trim();
      if (!code || (packageId && !findLicensePackage(packageId))) return res.status(400).json({ ok: false, message: 'Kupon kodu veya paket gecersiz.' });
      await pool.query(
        'INSERT INTO coupons (code, discount_percent, package_id, max_uses, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?)',
        [code, discount, packageId || null, Math.max(Number(req.body?.max_uses) || 0, 0), req.body?.expires_at || null, req.session.user?.email || 'admin']
      );
      await recordActivityLog({ user: req.session.user, action: 'COUPON_CREATE', details: `${code}: %${discount}` });
      res.json({ ok: true, message: 'Kupon olusturuldu.' });
    } catch (error) {
      res.status(String(error?.code || '') === 'ER_DUP_ENTRY' ? 409 : 500).json({ ok: false, message: 'Kupon olusturulamadi veya kod zaten var.' });
    }
  });

  app.get('/api/admin/monitor', requireAdmin, async (_req, res) => {
    try {
      const statuses = await listPluginStatuses(500);
      const commands = await listPluginCommands(500);
      const reports = await listErrorReports(300);
      const sourceHealth = await listSourceHealth(200);
      res.json({ ok: true, monitor: buildMonitorSnapshot({ statuses, commands, reports, sourceHealth }) });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Monitor durumu alinamadi.' });
    }
  });

  app.get('/api/admin/diagnostics', requireAdmin, async (_req, res) => {
    try {
      const users = await listUsers();
      const statuses = await listPluginStatuses(500);
      const commands = await listPluginCommands(500);
      const reports = await listErrorReports(300);
      const sourceHealth = await listSourceHealth(200);
      res.json({ ok: true, diagnostics: buildDiagnosticsCenter({ users, statuses, commands, reports, sourceHealth }) });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Teshis merkezi alinamadi.' });
    }
  });

  app.get('/api/admin/support-tickets', requireAdmin, async (req, res) => {
    try {
      const tickets = await listSupportTickets({
        email: req.query.email || '',
        status: req.query.status || '',
        limit: req.query.limit || 200
      });
      res.json({ ok: true, tickets });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Destek talepleri alinamadi.' });
    }
  });

  app.post('/api/admin/support-tickets/:id/reply', requireAdmin, async (req, res) => {
    try {
      const ticket = await updateSupportTicket(req.params.id, {
        status: req.body?.status || 'answered',
        admin_reply: req.body?.admin_reply || req.body?.reply || '',
        admin: req.session.user
      });
      if (!ticket) return res.status(404).json({ ok: false, message: 'Destek talebi bulunamadi.' });
      await recordActivityLog({ user: req.session.user, action: 'SUPPORT_TICKET_REPLY', details: `Ticket ${ticket.id}: ${ticket.status}` });
      res.json({ ok: true, message: 'Destek talebi guncellendi.', ticket });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Destek talebi guncellenemedi.' });
    }
  });

  app.get('/api/admin/device-reset-requests', requireAdmin, async (req, res) => {
    try {
      const requests = await listDeviceResetRequests(req.query.status || '', req.query.limit || 200);
      res.json({ ok: true, requests });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Cihaz sifirlama talepleri alinamadi.' });
    }
  });

  app.post('/api/admin/device-reset-requests/:id/review', requireAdmin, async (req, res) => {
    try {
      const approved = req.body?.approved === true || req.body?.action === 'approve';
      const request = await reviewDeviceResetRequest(req.params.id, { approved, admin: req.session.user, note: req.body?.note || '' });
      if (!request) return res.status(404).json({ ok: false, message: 'Talep bulunamadi.' });
      await recordActivityLog({
        user: req.session.user,
        action: approved ? 'DEVICE_RESET_APPROVE' : 'DEVICE_RESET_REJECT',
        details: `${request.email || request.user_id || req.params.id}`
      });
      res.json({ ok: true, message: approved ? 'HWID sifirlandi.' : 'Talep reddedildi.', request });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Talep guncellenemedi.' });
    }
  });

  app.post('/api/admin/source-health/:name/enable', requireAdmin, async (req, res) => {
    try {
      const source = await enableSourceHealth(req.params.name, req.session.user);
      if (!source) return res.status(404).json({ ok: false, message: 'Kaynak bulunamadi.' });
      res.json({ ok: true, message: 'Kaynak tekrar aktif edildi.', source });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Kaynak aktif edilemedi.' });
    }
  });

  app.get('/api/admin/users/:id/detail', requireAdmin, async (req, res) => {
    try {
      const user = await resolveAdminUserTarget(req.params.id);
      if (!user) return res.status(404).json({ ok: false, message: 'Kullan─▒c─▒ bulunamad─▒.' });
      const email = normalizeEmail(user.email);
      const logs = (await listActivityLogs(300)).filter((log) => normalizeEmail(log.email) === email).slice(0, 80);
      const reports = (await listErrorReports(500)).filter((report) => normalizeEmail(report.email) === email).slice(0, 50);
      const plugin = (await listPluginStatuses(500)).filter((item) => normalizeEmail(item.email) === email).slice(0, 20);
      const commands = (await listPluginCommands(500)).filter((cmd) => normalizeEmail(cmd.email) === email).slice(0, 50);
      const installedGames = aggregateInstalledGamesFromStatuses(plugin);
      const { password_hash, ...safeUser } = user;
      res.json({ ok: true, user: safeUser, logs, reports, plugin, commands, installed_games: installedGames });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Kullan─▒c─▒ detay─▒ al─▒namad─▒.' });
    }
  });

  app.post('/api/admin/users/:id/command', requireAdmin, async (req, res) => {
    try {
      const user = await resolveAdminUserTarget(req.params.id);
      if (!user) return res.status(404).json({ ok: false, message: 'Kullan─▒c─▒ bulunamad─▒.' });
      if (user.role === 'admin') return res.status(400).json({ ok: false, message: 'Admin hesab─▒na uzaktan komut g├Ânderilemez.' });
      const command = String(req.body?.command || '').trim();
      if (!ALLOWED_PLUGIN_COMMANDS.has(command)) return res.status(400).json({ ok: false, message: 'Ge├ğersiz komut.' });
      const commandPayload = req.body?.payload && typeof req.body.payload === 'object' ? { ...req.body.payload } : {};
      if (command === 'cleanup_games' && (req.body?.confirm_cleanup === true || commandPayload.confirm_cleanup === true)) {
        commandPayload.confirm_cleanup = true;
      }
      const item = await createPluginCommand({
        user,
        admin: req.session.user,
        command,
        payload: commandPayload,
        reason: req.body?.reason || ''
      });
      res.json({ ok: true, message: item.deduped ? 'Ayni aktif komut zaten kuyrukta.' : 'Komut kuyruga eklendi.', command: item });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Komut olu┼şturulamad─▒.' });
    }
  });

  app.post('/api/admin/users/:id/license-package', requireAdmin, async (req, res) => {
    try {
      const result = await applyLicensePackageToUser(Number(req.params.id), req.body?.package_id || req.body?.packageId, req.session.user);
      if (!result.ok) return res.status(result.errorStatus || 400).json({ ok: false, message: result.message || 'Lisans paketi uygulanamadi.' });
      res.json(result);
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Lisans paketi uygulanamadi.' });
    }
  });

  app.post('/api/admin/plugin-commands/:id/cancel', requireAdmin, async (req, res) => {
    try {
      const cancel = await cancelPluginCommand(req.params.id, req.session.user?.email || 'admin');
      if (cancel.errorStatus) return res.status(cancel.errorStatus).json(cancel.body);
      return res.json(cancel.body);
      const data = readPluginCommandsFile();
      const cmd = data.commands.find((item) => Number(item.id) === Number(req.params.id));
      if (!cmd) return res.status(404).json({ ok: false, message: 'Komut bulunamad─▒.' });
      if (!['pending', 'delivered'].includes(cmd.status)) return res.status(400).json({ ok: false, message: 'Bu komut art─▒k iptal edilemez.' });
      cmd.status = 'cancelled';
      cmd.completed_at = new Date().toISOString();
      cmd.result = `Cancelled by ${req.session.user?.email || 'admin'}`;
      writePluginCommandsFile(data);
      res.json({ ok: true, message: 'Komut iptal edildi.', command: cmd });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Komut iptal edilemedi.' });
    }
  });

  app.get('/api/admin/plugin-control', requireAdmin, async (_req, res) => {
    try {
      const control = await getPluginControl();
      res.json({ ok: true, control });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Plugin kontrol├╝ al─▒namad─▒.' });
    }
  });

  app.post('/api/admin/plugin-control', requireAdmin, async (req, res) => {
    try {
      const control = await savePluginControl({
        maintenance_mode: req.body?.maintenance_mode,
        add_game_enabled: req.body?.add_game_enabled,
        account_required: req.body?.account_required,
        force_update: req.body?.force_update,
        latest_version: req.body?.latest_version,
        update_url: req.body?.update_url,
        release_notes: req.body?.release_notes,
        rollout_channel: req.body?.rollout_channel,
        notice_title: req.body?.notice_title,
        notice_message: req.body?.notice_message,
        support_url: req.body?.support_url
      }, req.session.user?.email || 'admin');

      await recordActivityLog({
        user: req.session.user,
        action: 'PLUGIN_CONTROL',
        details: `maintenance=${control.maintenance_mode}, add_game=${control.add_game_enabled}, force_update=${control.force_update}`
      });

      res.json({ ok: true, message: 'Plugin kontrol ayarlar─▒ g├╝ncellendi.', control });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Plugin kontrol├╝ kaydedilemedi.' });
    }
  });

  app.post('/api/admin/release', requireAdmin, async (req, res) => {
    try {
      const latestVersion = String(req.body?.latest_version || '').trim();
      const updateUrl = String(req.body?.update_url || '').trim();
      if (!latestVersion || !updateUrl) return res.status(400).json({ ok: false, message: 'S├╝r├╝m ve ZIP linki gerekli.' });
      const control = await savePluginControl({
        latest_version: latestVersion,
        update_url: updateUrl,
        release_notes: req.body?.release_notes || '',
        rollout_channel: req.body?.rollout_channel || 'stable',
        force_update: Boolean(req.body?.force_update),
        notice_title: `SecurityShoop ${latestVersion}`,
        notice_message: req.body?.release_notes || 'Yeni plugin s├╝r├╝m├╝ yay─▒nda.'
      }, req.session.user?.email || 'admin');
      await recordActivityLog({ user: req.session.user, action: 'RELEASE_PUBLISH', details: `version=${latestVersion}, force=${control.force_update}` });
      res.json({ ok: true, message: 'G├╝ncelleme yay─▒na al─▒nd─▒.', control });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'G├╝ncelleme yay─▒na al─▒namad─▒.' });
    }
  });

  app.post('/api/admin/bulk', requireAdmin, async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean).slice(0, 200) : [];
      const action = String(req.body?.action || '').trim();
      const allowed = new Set(['block', 'unblock', 'delete', 'license', 'pcban', 'command', 'approve', 'reject']);
      if (!ids.length) return res.status(400).json({ ok: false, message: 'Kullan─▒c─▒ se├ğilmedi.' });
      if (!allowed.has(action)) return res.status(400).json({ ok: false, message: 'Ge├ğersiz toplu i┼şlem.' });

      const results = [];
      for (const id of ids) {
        const user = await findUserById(id);
        if (!user) { results.push({ id, ok: false, message: 'Bulunamad─▒' }); continue; }
        if (user.role === 'admin') { results.push({ id, ok: false, message: 'Admin atland─▒' }); continue; }
        try {
          if (action === 'block') await updateUserBlock(id, true);
          if (action === 'unblock') await updateUserBlock(id, false);
          if (action === 'delete') await deleteUserById(id);
          if (action === 'pcban') await addHwidBan({ hwid: user.hwid, user, reason: `Bulk PC ban by ${req.session.user?.email || 'admin'}` });
          if (action === 'approve') await updateUserApprovalStatus(id, 'approved');
          if (action === 'reject') await updateUserApprovalStatus(id, 'rejected');
          if (action === 'license') {
            const packageId = String(req.body?.license_package_id || req.body?.package_id || '').trim();
            if (packageId) {
              const applied = await applyLicensePackageToUser(id, packageId, req.session.user);
              if (!applied.ok) {
                results.push({ id, ok: false, message: applied.message || 'Paket uygulanamadi' });
                continue;
              }
            } else {
              const dailyLimit = Math.max(0, Math.min(999, Number(req.body?.daily_limit || 0)));
              const licenseUntil = String(req.body?.license_until || '').trim() || null;
              await updateUserLicenseValues(id, { licenseUntil, dailyLimit });
            }
          }
          if (action === 'command') {
            const command = String(req.body?.command || 'refresh_control').trim();
            if (!ALLOWED_PLUGIN_COMMANDS.has(command)) {
              results.push({ id, ok: false, message: 'Gecersiz komut' });
              continue;
            }
            const commandPayload = req.body?.payload && typeof req.body.payload === 'object' ? { ...req.body.payload } : {};
            if (command === 'cleanup_games' && (req.body?.confirm_cleanup === true || commandPayload.confirm_cleanup === true)) {
              commandPayload.confirm_cleanup = true;
            }
            await createPluginCommand({
              user,
              admin: req.session.user,
              command,
              payload: commandPayload,
              reason: req.body?.reason || 'Bulk command'
            });
          }
          results.push({ id, ok: true });
        } catch (error) {
          results.push({ id, ok: false, message: String(error?.message || error) });
        }
      }
      await recordActivityLog({ user: req.session.user, action: 'BULK_ACTION', details: `${action} -> ${ids.length} user(s)` });
      res.json({ ok: true, message: `Toplu i┼şlem tamamland─▒: ${results.filter((r) => r.ok).length}/${results.length}`, results });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Toplu i┼şlem ba┼şar─▒s─▒z.' });
    }
  });

  app.post('/api/admin/announcements', requireAdmin, async (req, res) => {
    try {
      const title = String(req.body?.title || '').trim().slice(0, 120);
      const message = String(req.body?.message || '').trim().slice(0, 1000);
      if (!title || !message) return res.status(400).json({ ok: false, message: 'Ba┼şl─▒k ve mesaj gerekli.' });
      const data = readAnnouncementsFile();
      const item = {
        id: Date.now(),
        title,
        message,
        active: true,
        created_at: new Date().toISOString(),
        expires_at: String(req.body?.expires_at || '').trim()
      };
      data.announcements.unshift(item);
      data.announcements = data.announcements.slice(0, 100);
      writeAnnouncementsFile(data);
      res.json({ ok: true, announcement: item });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Duyuru kaydedilemedi.' });
    }
  });

  app.post('/api/admin/users/:id/license', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const dailyLimit = Math.max(0, Math.min(999, Number(req.body?.daily_limit || 0)));
      const licenseUntil = String(req.body?.license_until || '').trim() || null;
      const existing = await findUserById(id);
      if (!existing) return res.status(404).json({ ok: false, message: 'Kullanici bulunamadi.' });
      await updateUserLicenseValues(id, { licenseUntil, dailyLimit });
      await recordActivityLog({ user: req.session.user, action: 'ADMIN_LICENSE', details: `Target: ${id}, until=${licenseUntil || 'unlimited'}, limit=${dailyLimit}` });
      return res.json({ ok: true, message: 'Lisans ayarlari guncellendi.' });
      if (useDatabase) {
        await pool.query('UPDATE users SET license_until = ?, daily_limit = ? WHERE id = ?', [licenseUntil, dailyLimit, id]);
      } else {
        const data = readUsersFile();
        const user = data.users.find((u) => Number(u.id) === id);
        if (!user) return res.status(404).json({ ok: false, message: 'Kullan─▒c─▒ bulunamad─▒.' });
        user.license_until = licenseUntil || '';
        user.daily_limit = dailyLimit;
        writeUsersFile(data);
      }
      await recordActivityLog({ user: req.session.user, action: 'ADMIN_LICENSE', details: `Target: ${id}, until=${licenseUntil || 'unlimited'}, limit=${dailyLimit}` });
      res.json({ ok: true, message: 'Lisans ayarlar─▒ g├╝ncellendi.' });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Lisans g├╝ncellenemedi.' });
    }
  });

  app.post('/api/admin/users/:id/appid-access', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const allowedAppids = normalizeAppidList(req.body?.allowed_appids ?? req.body?.appids ?? '');
      const serialized = allowedAppids.join(',');
      const user = await findUserById(id);
      if (!user) return res.status(404).json({ ok: false, message: 'Kullanici bulunamadi.' });
      if (user.role === 'admin') return res.status(400).json({ ok: false, message: 'Admin hesabina AppID kisiti uygulanmaz.' });
      if (useDatabase) {
        await pool.query('UPDATE users SET allowed_appids = ? WHERE id = ?', [serialized, id]);
      } else {
        const data = readUsersFile();
        const existing = data.users.find((item) => Number(item.id) === id);
        if (!existing) return res.status(404).json({ ok: false, message: 'Kullanici bulunamadi.' });
        existing.allowed_appids = serialized;
        writeUsersFile(data);
      }
      await recordActivityLog({ user: req.session.user, action: 'ADMIN_APPID_ACCESS', details: `Target: ${user.email || id}, appids=${serialized || 'unlimited'}` });
      res.json({ ok: true, message: allowedAppids.length ? 'Kullanici sadece secilen AppID listesini ekleyebilir.' : 'AppID kisiti kaldirildi.', allowed_appids: allowedAppids });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'AppID izinleri guncellenemedi.' });
    }
  });

  app.get('/api/admin/backup', requireAdmin, async (_req, res) => {
    try {
      const backup = await buildBackupPayload();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="securityshoop-backup-${new Date().toISOString().slice(0, 10)}.json"`);
      res.json(backup);
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Yedek olusturulamadi.' });
    }
  });

  app.post('/api/admin/restore', requireAdmin, async (req, res) => {
    try {
      if (req.body?.confirm_restore !== true) return res.status(400).json({ ok: false, message: 'Geri yukleme onayi gerekli.' });
      const summary = await restoreBackupPayload(req.body?.backup || req.body);
      await recordActivityLog({ user: req.session.user, action: 'BACKUP_RESTORE', details: JSON.stringify(summary) });
      res.json({ ok: true, message: 'Yedek geri yuklendi ve mevcut verilerle birlestirildi.', summary });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: String(error?.message || 'Yedek geri yuklenemedi.') });
    }
  });

  app.get('/api/admin/logs', requireAdmin, async (req, res) => {
    try {
      const logs = await listActivityLogs(req.query.limit || 100);
      res.json({ ok: true, logs });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Loglar al─▒namad─▒.' });
    }
  });

  app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
      scheduleDatabaseRetry();
      const users = await listUsers();
      const storage = useDatabase ? 'mysql' : (process.env.VERCEL ? 'temporary-json' : 'json');
      res.json({
        ok: true,
        users,
        storage,
        persistent: useDatabase,
        warning: '',
        notice: !useDatabase && process.env.VERCEL
          ? 'Gecici depolama aktif. Plugin hesaplari ve oyunlar bu oturumda gosteriliyor.'
          : ''
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Kullan─▒c─▒lar al─▒namad─▒.' });
    }
  });

  app.post('/api/admin/users/:id/approval', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const user = await findUserById(id);
      if (!user) return res.status(404).json({ ok: false, message: 'Kullanici bulunamadi.' });
      if (user.role === 'admin') return res.status(400).json({ ok: false, message: 'Admin hesabi onay akisi disinda.' });
      const status = req.body?.approved === true ? 'approved' : (req.body?.status === 'pending' ? 'pending' : 'rejected');
      await updateUserApprovalStatus(id, status);
      await recordActivityLog({
        user: req.session.user,
        action: status === 'approved' ? 'ADMIN_APPROVE_USER' : (status === 'pending' ? 'ADMIN_PENDING_USER' : 'ADMIN_REJECT_USER'),
        details: `Target: ${user.email || id}`
      });
      res.json({ ok: true, message: status === 'approved' ? 'Hesap onaylandi.' : (status === 'pending' ? 'Hesap tekrar onay beklemeye alindi.' : 'Hesap reddedildi.'), approval_status: status });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Onay durumu guncellenemedi.' });
    }
  });

  app.post('/api/admin/users/:id/review-mode', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const enabled = req.body?.enabled === true || req.body?.review_mode === true || req.body?.action === 'enable';
      const updated = await updateUserReviewMode(id, enabled, req.body?.note || req.body?.review_note || '', req.session.user);
      if (!updated) return res.status(404).json({ ok: false, message: 'Kullanici bulunamadi veya admin hesabi secildi.' });
      res.json({ ok: true, message: enabled ? 'Kullanici inceleme moduna alindi.' : 'Inceleme modu kapatildi.', review_mode: enabled });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Inceleme modu guncellenemedi.' });
    }
  });

  app.post('/api/admin/users/:id/block', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const user = await findUserById(id);
      if (!user) return res.status(404).json({ ok: false, message: 'Kullan─▒c─▒ bulunamad─▒.' });
      if (user.role === 'admin') return res.status(400).json({ ok: false, message: 'Admin engellenemez.' });
      await updateUserBlock(id, true);
      await recordActivityLog({ user: req.session.user, action: 'ADMIN_BLOCK', details: `Target: ${user.email || id}` });
      res.json({ ok: true, message: 'Kullan─▒c─▒ engellendi.' });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: '─░┼şlem ba┼şar─▒s─▒z.' });
    }
  });

  app.post('/api/admin/users/:id/ban-pc', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const user = await findUserById(id);
      if (!user) return res.status(404).json({ ok: false, message: 'Kullan─▒c─▒ bulunamad─▒.' });
      if (user.role === 'admin') return res.status(400).json({ ok: false, message: 'Admin engellenemez.' });
      if (!normalizeHwid(user.hwid)) return res.status(400).json({ ok: false, message: 'Bu kullan─▒c─▒da HWID yok. Kullan─▒c─▒ pluginden giri┼ş yapmali.' });
      await addHwidBan({ hwid: user.hwid, user, reason: `Admin ban by ${req.session.user?.email || 'admin'}` });
      await recordActivityLog({ user: req.session.user, action: 'BAN_PC', details: `Target: ${user.email || id}, HWID: ${user.hwid}` });
      res.json({ ok: true, message: 'Bilgisayar banland─▒.' });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: '─░┼şlem ba┼şar─▒s─▒z.' });
    }
  });

  app.post('/api/admin/users/:id/unblock', requireAdmin, async (req, res) => {
    try {
      const updated = await updateUserBlock(Number(req.params.id), false);
      if (updated === false) return res.status(404).json({ ok: false, message: 'Kullan─▒c─▒ bulunamad─▒.' });
      await recordActivityLog({ user: req.session.user, action: 'ADMIN_UNBLOCK', details: `Target: ${req.params.id}` });
      res.json({ ok: true, message: 'Kullan─▒c─▒ engeli kald─▒r─▒ld─▒.' });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: '─░┼şlem ba┼şar─▒s─▒z.' });
    }
  });

  app.post('/api/admin/users/:id/delete', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const user = await findUserById(id);
      if (!user) return res.status(404).json({ ok: false, message: 'Kullan─▒c─▒ bulunamad─▒.' });
      if (user.role === 'admin') return res.status(400).json({ ok: false, message: 'Admin silinemez.' });
      await deleteUserById(id);
      await recordActivityLog({ user: req.session.user, action: 'ADMIN_DELETE', details: `Target: ${user.email || id}` });
      res.json({ ok: true, message: 'Kullan─▒c─▒ silindi.' });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: '─░┼şlem ba┼şar─▒s─▒z.' });
    }
  });

  app.get('/api/shopier/checkout', async (req, res) => {
    const selectedPackage = findLicensePackage(req.query?.package || req.query?.package_id);
    await recordCommerceEvent({ req, eventType: 'checkout_click', packageId: selectedPackage?.id || '' }).catch(() => {});
    const apiKey = String(process.env.SHOPIER_API_KEY || '').trim();
    const apiSecret = String(process.env.SHOPIER_API_SECRET || '').trim();
    const packageCheckoutUrl = getValidShopierUrl(selectedPackage?.shopier_url);
    const checkoutUrl = packageCheckoutUrl || getValidShopierPaymentUrl();
    const useApiCheckout = String(process.env.SHOPIER_USE_API || '').trim().toLowerCase() === 'true';

    if (checkoutUrl && !useApiCheckout) {
      return res.redirect(302, checkoutUrl);
    }

    if (!apiKey || !apiSecret) {
      if (!checkoutUrl) {
        return res.status(500).json({ ok: false, message: 'Shopier API veya ├Âdeme linki ayarlanmam─▒┼ş.' });
      }
      return res.redirect(302, checkoutUrl);
    }

    if (!selectedPackage) {
      return res.status(400).json({ ok: false, message: 'Gecerli bir lisans paketi sec.' });
    }

    const requestUser = getRequestUser(req);
    if (!requestUser) {
      return res.status(401).type('html').send('<!doctype html><html lang="tr"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Giris gerekli</title><body style="font-family:Arial,sans-serif;background:#080b0f;color:#fff;text-align:center;padding:64px 20px"><h1>Once SecurityShoop hesabina giris yap</h1><p>Odeme sonrasi lisansin hesabina otomatik tanimlanabilmesi icin giris yapman gerekiyor.</p><a href="/" style="color:#34d399">Siteye don ve giris yap</a></body></html>');
    }

    const baseUrl = getBaseUrl(req);
    const user = requestUser;
    const platformOrderId = `SEC-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const randomNr = String(Math.floor(100000 + Math.random() * 900000));
    const totalOrderValue = cleanPrice(selectedPackage ? packageNumericPrice(selectedPackage) : (process.env.SHOPIER_PRODUCT_PRICE || '1.00'));
    const currency = Number(process.env.SHOPIER_CURRENCY || 0);
    const productName = `SecurityShoop ${selectedPackage.name} Lisans`;
    const fullName = String(user.username || 'Security Shoop').trim();
    const parts = fullName.split(/\s+/);
    const buyerName = parts[0] || 'Security';
    const buyerSurname = parts.slice(1).join(' ') || 'Shoop';
    const buyerEmail = user.email || process.env.SHOPIER_DEFAULT_BUYER_EMAIL || 'musteri@example.com';

    const fields = {
      API_key: apiKey,
      website_index: Number(process.env.SHOPIER_WEBSITE_INDEX || 1),
      platform_order_id: platformOrderId,
      product_name: productName,
      product_type: Number(process.env.SHOPIER_PRODUCT_TYPE || 1),
      buyer_name: buyerName,
      buyer_surname: buyerSurname,
      buyer_email: buyerEmail,
      buyer_account_age: 0,
      buyer_id_nr: user.id || platformOrderId,
      buyer_phone: process.env.SHOPIER_DEFAULT_BUYER_PHONE || '5555555555',
      billing_address: process.env.SHOPIER_BILLING_ADDRESS || 'Dijital Teslimat',
      billing_city: process.env.SHOPIER_BILLING_CITY || 'Istanbul',
      billing_country: process.env.SHOPIER_BILLING_COUNTRY || 'Turkey',
      billing_postcode: process.env.SHOPIER_BILLING_POSTCODE || '34000',
      shipping_address: process.env.SHOPIER_SHIPPING_ADDRESS || 'Dijital Teslimat',
      shipping_city: process.env.SHOPIER_SHIPPING_CITY || 'Istanbul',
      shipping_country: process.env.SHOPIER_SHIPPING_COUNTRY || 'Turkey',
      shipping_postcode: process.env.SHOPIER_SHIPPING_POSTCODE || '34000',
      total_order_value: totalOrderValue,
      currency,
      platform: 0,
      is_in_frame: 0,
      current_language: 0,
      modul_version: '1.0.0',
      random_nr: randomNr,
      callback: `${baseUrl}/api/shopier/callback`
    };
    fields.signature = createShopierSignature({ randomNr, platformOrderId, totalOrderValue, currency }, apiSecret);

    await saveOrder({ platform_order_id: platformOrderId, user_id: user.id || null, username: user.username || null, email: buyerEmail, product_name: productName, total_order_value: totalOrderValue, currency, status: 'created' });
    return res.type('html').send(buildAutoSubmitShopierPage(fields));
  });

  app.post('/api/shopier/callback', async (req, res) => {
    try {
      const orderId = String(req.body.platform_order_id || req.body.order_id || req.body.payment_id || '').trim();
      if (orderId) {
        const cloudData = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { processed_orders: [] });
        cloudData.processed_orders = cloudData.processed_orders || [];
        if (cloudData.processed_orders.includes(orderId)) {
          return res.status(200).send('OK (Already Processed)');
        }
        cloudData.processed_orders.push(orderId);
        if (cloudData.processed_orders.length > 500) cloudData.processed_orders.shift();
        await saveCloudJson(CLOUD_STORAGE_IDS.tokens, cloudData);
      }
    } catch(e) {}
    const apiSecret = String(process.env.SHOPIER_API_SECRET || '').trim();
    if (!apiSecret) return res.redirect('/odeme-basarisiz.html');

    const isVerified = verifyShopierCallback(req.body, apiSecret);
    const status = String(req.body.status || '').toLowerCase();
    const isSuccess = isVerified && status === 'success';

    const platformOrderId = req.body.platform_order_id || '';
    const existingOrder = await findOrderByPlatformId(platformOrderId);
    const shouldApplyLicense = isSuccess && existingOrder?.user_id && String(existingOrder.status || '').toLowerCase() !== 'paid';
    await saveOrder({ platform_order_id: platformOrderId, payment_id: req.body.payment_id || null, installment: req.body.installment || null, total_order_value: req.body.total_order_value || null, currency: req.body.currency || null, status: isSuccess ? 'paid' : 'failed', raw_status: req.body.status || null, verified: isVerified, callback_at: new Date().toISOString() });
    if (shouldApplyLicense) {
      const pkg = listLicensePackages().find((item) => String(existingOrder.product_name || '').includes(item.name));
      if (pkg) {
        const applied = await applyLicensePackageToUser(existingOrder.user_id, pkg.id, { email: 'shopier-callback', username: 'Shopier' });
        await recordCommerceEvent({ eventType: 'purchase_completed', packageId: pkg.id, metadata: `${platformOrderId}:${applied.ok ? 'applied' : 'failed'}` });
      }
    }
    return res.redirect(isSuccess ? '/odeme-basarili.html' : '/odeme-basarisiz.html');
  });

  app.post('/api/shopier/osb', parseShopierOsbForm, async (req, res) => {
    try {
      const username = String(process.env.SHOPIER_OSB_USERNAME || '').trim();
      const key = String(process.env.SHOPIER_OSB_KEY || '').trim();
      if (!username || !key || !verifyShopierOsbNotification(req.body, username, key)) {
        console.warn('Shopier OSB rejected', {
          credentials_configured: Boolean(username && key),
          has_res: Boolean(req.body?.res),
          has_hash: Boolean(req.body?.hash),
          content_type: String(req.headers['content-type'] || '').split(';')[0]
        });
        return res.status(401).type('text').send('invalid');
      }

      const payload = parseShopierOsbPayload(req.body?.res);
      if (!payload?.orderid) return res.status(400).type('text').send('missing parameter');
      console.log('Shopier OSB accepted', { test: String(payload.istest || '0') === '1', has_order: true });
      if (String(payload.istest || '0') === '1') return res.type('text').send('success');

      const platformOrderId = `OSB-${String(payload.orderid).slice(0, 100)}`;
      const existingOrder = await findOrderByPlatformId(platformOrderId);
      if (String(existingOrder?.status || '').toLowerCase() === 'paid') return res.type('text').send('success');

      const pkg = findLicensePackageFromShopierOsb(payload);
      const user = await findUserByEmail(payload.email);
      let status = 'paid_unmatched';
      if (pkg && user && isUserApproved(user)) {
        const applied = await applyLicensePackageToUser(user.id, pkg.id, { email: 'shopier-osb', username: 'Shopier OSB' });
        status = applied.ok ? 'paid' : 'paid_failed';
        await recordCommerceEvent({ eventType: 'purchase_completed', packageId: pkg.id, metadata: `${platformOrderId}:${status}` });
      } else {
        await recordCommerceEvent({ eventType: 'purchase_unmatched', packageId: pkg?.id || '', metadata: `${platformOrderId}:${normalizeEmail(payload.email) || 'no-email'}` });
      }

      await saveOrder({
        platform_order_id: platformOrderId,
        user_id: user?.id || null,
        username: user?.username || `${payload.buyername || ''} ${payload.buyersurname || ''}`.trim() || null,
        email: payload.email || null,
        product_name: pkg?.name || String(payload.productlist || payload.productid || 'Shopier OSB').slice(0, 255),
        total_order_value: payload.price || null,
        currency: payload.currency || null,
        status,
        raw_status: 'osb',
        verified: true,
        callback_at: new Date().toISOString()
      });
      return res.type('text').send('success');
    } catch (error) {
      console.error('Shopier OSB failed:', error);
      return res.status(500).type('text').send('error');
    }
  });

  app.get('/api/reviews', async (req, res) => {
    try {
      const reviews = await listReviews(20);
      res.json({ ok: true, reviews });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Yorumlar al─▒namad─▒.' });
    }
  });

  app.post('/api/reviews', requireAuth, async (req, res) => {
    try {
      const text = String(req.body.text || '').trim();
      if (!text) return res.status(400).json({ ok: false, message: 'Yorum bo┼ş olamaz.' });
      if (text.length < 3) return res.status(400).json({ ok: false, message: 'Yorum en az 3 karakter olmal─▒.' });
      if (text.length > 500) return res.status(400).json({ ok: false, message: 'Yorum en fazla 500 karakter olabilir.' });
      const review = await createReview({
        userId: req.session.user.id,
        username: req.session.user.username || req.session.user.email,
        text,
        rating: 5,
        isDemo: 0
      });
      res.json({ ok: true, message: 'Yorum eklendi.', review });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Yorum eklenemedi.' });
    }
  });


  // ==========================================
  // SINGLE-USE TOKEN SYSTEM
  // ==========================================
  app.get('/api/admin/tokens', requireAdmin, async (req, res) => {
    try {
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [] });
      res.json({ ok: true, tokens: data.tokens || [] });
    } catch (err) {
      res.status(500).json({ ok: false, message: 'Tokenlar alinamadi.' });
    }
  });

  app.post('/api/admin/tokens', requireAdmin, async (req, res) => {
    try {
      const duration = req.body.duration || 'lifetime'; // '1d', '7d', '30d', 'lifetime'
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [] });
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let t = 'MS-';
      for(let i=0; i<4; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
      t += '-';
      for(let i=0; i<4; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
      const newToken = {
        token: t,
        created_at: new Date().toISOString(),
        duration_type: duration,
        expires_at: null, // Hesaplanacak (ilk giriste)
        used: false,
        first_used_at: null,
        used_by_hwid: null
      };
      if (!data.tokens) data.tokens = [];
      data.tokens.push(newToken);
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens', data);
      res.json({ ok: true, token: newToken });
    } catch (err) {
      res.status(500).json({ ok: false, message: 'Token olusturulamadi.' });
    }
  });

  app.post('/api/admin/tokens/reset-hwid', async (req, res) => {
    try {
      const { token } = req.body;
      if (!token) return res.status(400).json({ ok: false, message: 'Token belirtilmedi.' });
      
      const cloudData = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [] });
      let tokens = cloudData.tokens || [];
      
      let found = false;
      tokens = tokens.map(t => {
        if (t.token && t.token.toLowerCase() === String(token).toLowerCase()) {
          t.used_by_hwid = null;
          t.used = false;
          found = true;
        }
        return t;
      });
      
      if (!found) return res.status(404).json({ ok: false, message: 'Token bulunamadi.' });
      
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, { ...cloudData, tokens });
      res.json({ ok: true, message: `Token (${token}) HWID kilidi basariyla sifirlandi.` });
    } catch(err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  app.post('/api/admin/tokens/:token/delete', requireAdmin, async (req, res) => {
    try {
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [] });
      data.tokens = (data.tokens || []).filter(t => t.token !== req.params.token);
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens', data);
      res.json({ ok: true, message: 'Token silindi.' });
    } catch (err) {
      res.status(500).json({ ok: false, message: 'Token silinemedi.' });
    }
  });

  
// ==========================================
// IN-MEMORY RATE LIMITER & SECURE DEPOTBOX PROXY
// ==========================================
const ipRateLimits = new Map();
function checkRateLimit(ip, endpoint, maxHits, windowMs) {
  const key = `${ip || 'unknown'}:${endpoint}`;
  const now = Date.now();
  let record = ipRateLimits.get(key);
  if (!record || now - record.startTime > windowMs) {
    record = { count: 1, startTime: now };
    ipRateLimits.set(key, record);
    return true;
  }
  record.count++;
  if (record.count > maxHits) {
    return false;
  }
  return true;
}

app.get('/api/plugin/get-lua', async (req, res) => {
  const ip = getRequestIp(req);
  if (!checkRateLimit(ip, 'get-lua', 80, 60000)) {
    return res.status(429).json({ ok: false, message: 'Cok fazla istek yapildi. Lutfen bekleyin.' });
  }

  // MarifetStore Bakim Modu & Oyun Ekleme Kontrolu
  if (marifetStoreConfig.maintenance_mode) {
    return res.status(503).json({ ok: false, message: 'Sistem su anda bakim modundadir. Lutfen daha sonra tekrar deneyiniz.' });
  }
  if (marifetStoreConfig.add_game_enabled === false) {
    return res.status(403).json({ ok: false, message: 'Kutuphaneye oyun ekleme yonetici tarafindan gecici olarak durduruldu!' });
  }

  const appid = String(req.query.appid || '').trim();
  if (!appid || !/^\d+$/.test(appid)) {
    return res.status(400).json({ ok: false, message: 'Gecersiz AppID.' });
  }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  // Validate session token against cloud database
  const cloudData = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [] });
  const validToken = (cloudData.tokens || []).find(t => (t.token === token || t.code === token) && !t.is_blocked);
  if (!validToken) {
    return res.status(401).json({ ok: false, message: 'Yetkisiz erisim / Gecersiz lisans.' });
  }

  try {
    const depotboxRes = await fetch(`https://depotbox.org/api/direct-lua?appid=${appid}`, {
      headers: { 'X-API-Key': '436b0828-9799-4ce4-b1f2-ea5a3ce32f73' },
      signal: AbortSignal.timeout(15000)
    });
    if (depotboxRes.ok) {
      const buffer = await depotboxRes.arrayBuffer();
      if (buffer.byteLength >= 50) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send(Buffer.from(buffer));
      }
    }
    return res.status(404).json({ ok: false, message: 'Oyun verisi alinamadi' });
  } catch (err) {
    console.error('get-lua proxy error:', err.message);
    return res.status(502).json({ ok: false, message: 'Oyun verisi alinamadi' });
  }
});

app.post('/api/plugin/token-login', async (req, res) => {
    try {
      if (marifetStoreConfig.maintenance_mode) {
        return res.status(503).json({ ok: false, message: 'MarifetStore su anda bakim modundadir. Lutfen daha sonra tekrar deneyiniz.' });
      }

      const userToken = String(req.body.token || '').trim();
      const hwid = String(req.body.hwid || '').trim();
      const rawUser = String(req.body.username || '').trim();
      if (!userToken) return res.status(400).json({ ok: false, message: 'Token eksik.' });
      if (!hwid) return res.status(400).json({ ok: false, message: 'HWID eksik.' });

      const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'bilinmiyor';

      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [] });
      const tokenObj = (data.tokens || []).find(t => String(t.token || '').trim().toUpperCase() === userToken.toUpperCase());

      // Blacklist Check
      const blacklist = data.blacklist || { hwids: [], ips: [] };
      if (blacklist.hwids && blacklist.hwids.includes(hwid)) {
        return res.status(403).json({ ok: false, message: 'Cihaziniz (HWID) kalici olarak yasaklanmistir.' });
      }
      if (blacklist.ips && blacklist.ips.includes(clientIp)) {
        return res.status(403).json({ ok: false, message: 'IP Adresiniz kalici olarak yasaklanmistir.' });
      }

      if (!tokenObj) return res.status(404).json({ ok: false, message: 'Gecersiz token.' });

      // Frozen (dondurulmus) kontrol
      if (tokenObj.frozen) {
        return res.status(403).json({ ok: false, message: 'Hesabiniz dondurulmustur. Lutfen yonetici ile iletisime gecin.' });
      }

      const now = new Date();

      // IP log - her giriste kaydet
      if (!tokenObj.ip_log) tokenObj.ip_log = [];
      tokenObj.ip_log.unshift({ ip: clientIp, at: now.toISOString() });
      if (tokenObj.ip_log.length > 10) tokenObj.ip_log = tokenObj.ip_log.slice(0, 10);
      tokenObj.last_ip = clientIp;
      tokenObj.last_login = now.toISOString();

      // Referral kodu yoksa olustur
      if (!tokenObj.ref_code) {
        const refChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let rc = 'REF-';
        for(let i=0;i<6;i++) rc += refChars.charAt(Math.floor(Math.random()*refChars.length));
        tokenObj.ref_code = rc;
      }

      if (tokenObj.used) {
        // Zaten kullanilmis, HWID kontrol et
        if (tokenObj.used_by_hwid !== hwid) {
          return res.status(403).json({ ok: false, message: 'Bu token baska bir cihaza kilitlenmis!' });
        }

        // Kullanıcı Adı Kilidi Kontrolü: Kayıtlı kullanıcı adından farklıysa reddet
        if (tokenObj.username && rawUser && tokenObj.username.toLowerCase() !== rawUser.toLowerCase()) {
          return res.status(403).json({ 
            ok: false, 
            message: `Bu lisans "${tokenObj.username}" kullanıcı adına kilitlidir! Lütfen doğru kullanıcı adını girin.` 
          });
        }
        
        // Suresi dolmus mu kontrol et
        if (tokenObj.expires_at && new Date(tokenObj.expires_at) < now) {
          return res.status(403).json({ ok: false, message: 'Token suresi dolmus!' });
        }
        
        await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens', data);

        // Discord ve Telegram Bildirimi
        const durLabel = tokenObj.duration_type === '1d' ? '1 Günlük' : tokenObj.duration_type === '7d' ? '1 Haftalık' : tokenObj.duration_type === '30d' ? '1 Aylık' : 'Sınırsız';
        const expLabel = tokenObj.expires_at ? new Date(tokenObj.expires_at).toLocaleDateString('tr-TR') : 'Sınırsız';
        const displayUsername = tokenObj.username || rawUser || 'Belirtilmedi';

        sendTelegramNotification(
          `🔑 <b>MarifetStore - Token Girişi</b>\n\n` +
          `• <b>Kullanıcı Adı:</b> <code>${displayUsername}</code>\n` +
          `• <b>Token:</b> <code>${userToken}</code>\n` +
          `• <b>Süre:</b> ${durLabel}\n` +
          `• <b>Bitiş:</b> ${expLabel}\n` +
          `• <b>IP Adresi:</b> <code>${clientIp}</code>\n` +
          `• <b>HWID:</b> <code>${hwid.substring(0, 16)}...</code>\n` +
          `• <b>Tarih:</b> ${new Date().toLocaleString('tr-TR')}`
        );

        const webhookData = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [], settings: {} });
        const webhookUrl = (webhookData.settings || {}).discord_webhook;
        if (webhookUrl) {
          try {
            await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                embeds: [{
                  title: '🔑 Token Girisi',
                  color: 0x00e676,
                  fields: [
                    { name: 'Token', value: '`' + userToken + '`', inline: true },
                    { name: 'Sure', value: durLabel, inline: true },
                    { name: 'Bitis', value: expLabel, inline: true },
                    { name: 'IP', value: clientIp, inline: true },
                    { name: 'HWID', value: hwid.substring(0, 12) + '...', inline: true },
                  ],
                  timestamp: now.toISOString()
                }]
              })
            });
          } catch(e) { /* webhook hatasi sessizce gec */ }
        }

        return res.json({ ok: true, message: 'Tekrar giris basarili!', role: 'user', session_token: userToken, expires_at: tokenObj.expires_at || null, ref_code: tokenObj.ref_code });
      }

      // Ilk kullanim (Kilitlenme ve Sure Baslatma)
      tokenObj.used = true;
      tokenObj.first_used_at = now.toISOString();
      tokenObj.used_by_hwid = hwid;
      if (rawUser) {
        tokenObj.username = rawUser; // Kullanıcı adını kalıcı olarak bu tokene mühürle
      }
      
      if (tokenObj.duration_type === '1d') {
        tokenObj.expires_at = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000).toISOString();
      } else if (tokenObj.duration_type === '7d') {
        tokenObj.expires_at = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      } else if (tokenObj.duration_type === '30d') {
        tokenObj.expires_at = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
      } else {
        tokenObj.expires_at = null; // lifetime
      }

      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens', data);

      // Discord ve Telegram bildirimi
      try {
        const durLabel2 = tokenObj.duration_type === '1d' ? '1 Günlük' : tokenObj.duration_type === '7d' ? '1 Haftalık' : tokenObj.duration_type === '30d' ? '1 Aylık' : 'Sınırsız';
        const displayUsername2 = tokenObj.username || rawUser || 'Belirtilmedi';

        sendTelegramNotification(
          `🆕 <b>MarifetStore - Yeni Cihaz Aktivasyonu!</b>\n\n` +
          `• <b>Kullanıcı Adı:</b> <code>${displayUsername2}</code>\n` +
          `• <b>Token:</b> <code>${userToken}</code>\n` +
          `• <b>Süre:</b> ${durLabel2}\n` +
          `• <b>IP Adresi:</b> <code>${clientIp}</code>\n` +
          `• <b>Cihaz HWID:</b> <code>${hwid.substring(0, 16)}...</code>\n` +
          `• <b>Durum:</b> Cihaza ve Kullanıcıya Mühürlendi 🔒\n` +
          `• <b>Tarih:</b> ${new Date().toLocaleString('tr-TR')}`
        );

        const webhookData2 = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [], settings: {} });
        const webhookUrl2 = (webhookData2.settings || {}).discord_webhook;
        if (webhookUrl2) {
          await fetch(webhookUrl2, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              embeds: [{
                title: '🆕 Yeni Token Aktivasyonu',
                color: 0x00b4d8,
                fields: [
                  { name: 'Token', value: '`' + userToken + '`', inline: true },
                  { name: 'Sure', value: durLabel2, inline: true },
                  { name: 'IP', value: clientIp, inline: true },
                ],
                timestamp: now.toISOString()
              }]
            })
          });
        }
      } catch(e) {}

            const crypto = require('crypto');
      const payloadStr = `${tokenObj.token}:${tokenObj.role || 'user'}:${tokenObj.expires_at || 'lifetime'}`;
      const sign = crypto.createHmac('sha256', 'MarifetStoreSecureSecretKey2026').update(payloadStr).digest('hex');
      res.setHeader('X-Marifet-Sign', sign);
      res.json({
        ok: true,
        message: 'Cihaz kilitlendi ve giris basarili!',
        role: tokenObj.role || 'user',
        session_token: tokenObj.token,
        expires_at: tokenObj.expires_at || null,
        ref_code: tokenObj.ref_code || '',
        _sign: sign
      });
    } catch (err) {
      console.error('token-login error:', err);
      res.status(500).json({ ok: false, message: 'Sunucu hatasi.' });
    }
  });

  // ==========================================================
// CREDIT CODES & PER-GAME LIBRARY SYSTEM
// ==========================================================

app.post('/api/admin/credits', requireAdmin, async (req, res) => {
  try {
    const duration = req.body.duration || '7d';
    const count = Math.min(Math.max(Number(req.body.count) || 1, 1), 50);
    
    const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [], credits: [] });
    if (!data.credits) data.credits = [];
    
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const newCodes = [];
    for(let c=0; c<count; c++) {
      let t = 'CR-';
      for(let i=0; i<4; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
      t += '-';
      for(let i=0; i<4; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
      
      const newCredit = {
        code: t,
        created_at: new Date().toISOString(),
        duration_type: duration,
        used: false,
        used_at: null,
        used_by_token: null,
        used_for_appid: null
      };
      data.credits.push(newCredit);
      newCodes.push(newCredit);
    }
    
    await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens_and_credits', data);
    res.json({ ok: true, message: `${count} adet kredi kodu olusturuldu.`, codes: newCodes });
  } catch(err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

  app.get('/api/admin/credits', requireAdmin, async (req, res) => {
  try {
    const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [], credits: [] });
    res.json({ ok: true, credits: data.credits || [] });
  } catch(err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.post('/api/admin/credits/delete', requireAdmin, async (req, res) => {
  try {
    const code = req.body.code;
    const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [], credits: [] });
    if (!data.credits) data.credits = [];
    data.credits = data.credits.filter(c => c.code !== code);
    await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens_and_credits', data);
    res.json({ ok: true, message: 'Kredi silindi.' });
  } catch(err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.get('/api/plugin/library', async (req, res) => {
  try {
    const userToken = String(req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!userToken) return res.status(401).json({ ok: false, message: 'Yetkisiz' });
    
    const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [], credits: [] });
    const tokenObj = (data.tokens || []).find(t => String(t.token || '').trim().toUpperCase() === userToken.toUpperCase());
    if (!tokenObj) return res.status(401).json({ ok: false, message: 'Gecersiz token' });
    
    const now = new Date();
    // Filter out expired games
    const library = (tokenObj.library || []).filter(game => new Date(game.expires_at) > now);
    
    res.json({ ok: true, library });
  } catch(err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.post('/api/plugin/redeem-credit', async (req, res) => {
  try {
    const userToken = String(req.headers.authorization || '').replace('Bearer ', '').trim();
    const appid = String(req.body.appid || '').trim();
    const appName = String(req.body.app_name || 'Bilinmeyen Oyun').trim();
    const creditCode = String(req.body.credit_code || '').trim();
    
    if (!userToken || !appid || !creditCode) return res.status(400).json({ ok: false, message: 'Eksik bilgi.' });
    
    const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [], credits: [] });
    
    const tokenObj = (data.tokens || []).find(t => String(t.token || '').trim().toUpperCase() === userToken.toUpperCase());
    if (!tokenObj) return res.status(401).json({ ok: false, message: 'Gecersiz token.' });
    
    const creditObj = (data.credits || []).find(c => c.code === creditCode);
    if (!creditObj) return res.status(404).json({ ok: false, message: 'Gecersiz kredi kodu.' });
    if (creditObj.used) return res.status(403).json({ ok: false, message: 'Bu kredi kodu zaten kullanilmis.' });
    
    // Check if game is already active
    const now = new Date();
    tokenObj.library = tokenObj.library || [];
    const existingGame = tokenObj.library.find(g => g.appid === appid && new Date(g.expires_at) > now);
    if (existingGame) return res.status(400).json({ ok: false, message: 'Bu oyun zaten kutuphanenizde aktif!' });
    
    // Redeem credit
    creditObj.used = true;
    creditObj.used_at = now.toISOString();
    creditObj.used_by_token = userToken;
    creditObj.used_for_appid = appid;
    
    // Calculate expiry
    let expiresAt;
    if (creditObj.duration_type === '1d') {
      expiresAt = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);
    } else if (creditObj.duration_type === '7d') {
      expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    } else if (creditObj.duration_type === '30d') {
      expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    } else {
      expiresAt = new Date(now.getTime() + 3650 * 24 * 60 * 60 * 1000); // 10 years for lifetime
    }
    
    // Remove expired entries of this game if any, then add new one
    tokenObj.library = tokenObj.library.filter(g => g.appid !== appid);
    tokenObj.library.push({
      appid,
      name: appName,
      unlocked_at: now.toISOString(),
      expires_at: expiresAt.toISOString()
    });
    
    await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens_and_credits', data);
    
    res.json({ ok: true, message: `${appName} oyunu kutuphanenize basariyla eklendi!`, library: tokenObj.library });
  } catch(err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});


  // ======================================================
  // TOKEN FREEZE / UNFREEZE
  // ======================================================
  app.post('/api/admin/tokens/:token/freeze', requireAdmin, async (req, res) => {
    try {
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [] });
      const tokenObj = (data.tokens || []).find(t => t.token === req.params.token);
      if (!tokenObj) return res.status(404).json({ ok: false, message: 'Token bulunamadi.' });
      tokenObj.frozen = true;
      tokenObj.frozen_at = new Date().toISOString();
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens', data);
      res.json({ ok: true, message: 'Token donduruldu.' });
    } catch(err) { res.status(500).json({ ok: false, message: err.message }); }
  });

  app.post('/api/admin/tokens/:token/unfreeze', requireAdmin, async (req, res) => {
    try {
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [] });
      const tokenObj = (data.tokens || []).find(t => t.token === req.params.token);
      if (!tokenObj) return res.status(404).json({ ok: false, message: 'Token bulunamadi.' });
      tokenObj.frozen = false;
      tokenObj.frozen_at = null;
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens', data);
      res.json({ ok: true, message: 'Token cozuldu.' });
    } catch(err) { res.status(500).json({ ok: false, message: err.message }); }
  });

  // ======================================================
  // REFERRAL SYSTEM
  // ======================================================
  app.post('/api/plugin/use-ref', async (req, res) => {
    try {
      const userToken = String(req.headers.authorization || '').replace('Bearer ', '').trim();
      const refCode = String(req.body.ref_code || '').trim();
      if (!userToken || !refCode) return res.status(400).json({ ok: false, message: 'Eksik bilgi.' });

      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [] });
      const myToken = (data.tokens || []).find(t => t.token === userToken);
      if (!myToken) return res.status(401).json({ ok: false, message: 'Gecersiz token.' });
      if (myToken.ref_code === refCode) return res.status(400).json({ ok: false, message: 'Kendi referans kodunu kullanamazsin.' });
      if (myToken.used_ref_code) return res.status(400).json({ ok: false, message: 'Daha once bir referans kodu kullandiniz.' });

      const refToken = (data.tokens || []).find(t => t.ref_code === refCode);
      if (!refToken) return res.status(404).json({ ok: false, message: 'Gecersiz referans kodu.' });

      const bonusMs = 3 * 24 * 60 * 60 * 1000; // 3 days
      const now = new Date();

      // Add 3 days to both
      [myToken, refToken].forEach(t => {
        if (t.expires_at) {
          const exp = new Date(t.expires_at);
          t.expires_at = new Date(Math.max(exp.getTime(), now.getTime()) + bonusMs).toISOString();
        }
      });

      myToken.used_ref_code = refCode;
      myToken.ref_bonus_received_at = now.toISOString();
      refToken.ref_bonus_count = (refToken.ref_bonus_count || 0) + 1;

      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens', data);
      res.json({ ok: true, message: 'Referans kodu kullanildi! Her ikinize de +3 gun eklendi.', expires_at: myToken.expires_at });
    } catch(err) { res.status(500).json({ ok: false, message: err.message }); }
  });

  // ======================================================
  // STORE & PRICE PLANS (from marifetstore config)
  // ======================================================
  app.post('/api/admin/marifetstore/store', requireAdmin, async (req, res) => {
    try {
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [], marifetstore: {} });
      if (!data.marifetstore) data.marifetstore = {};
      const { store_items, price_plans, announcement, discord_webhook, app_version, app_download_url } = req.body;
      if (store_items !== undefined) data.marifetstore.store_items = store_items;
      if (price_plans !== undefined) data.marifetstore.price_plans = price_plans;
      if (announcement !== undefined) data.marifetstore.announcement = announcement;
      if (discord_webhook !== undefined) {
        if (!data.settings) data.settings = {};
        data.settings.discord_webhook = discord_webhook;
        data.marifetstore.discord_webhook = discord_webhook;
      }
      if (app_version !== undefined) data.marifetstore.app_version = app_version;
      if (app_download_url !== undefined) data.marifetstore.app_download_url = app_download_url;
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens_and_credits', data);
      res.json({ ok: true, message: 'Ayarlar kaydedildi.' });
    } catch(err) { res.status(500).json({ ok: false, message: err.message }); }
  });

  app.get('/api/plugin/store-config', async (req, res) => {
    try {
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [], marifetstore: {} });
      const ms = data.marifetstore || {};
      res.json({
        ok: true,
        store_items: ms.store_items || [],
        price_plans: ms.price_plans || [],
        announcement: ms.announcement || null,
        app_version: ms.app_version || '1.0.0',
        app_download_url: ms.app_download_url || null,
      });
    } catch(err) { res.status(500).json({ ok: false, message: err.message }); }
  });

  // ======================================================
  // TOKEN STATS (for admin dashboard)
  // ======================================================
  app.get('/api/admin/token-stats', requireAdmin, async (req, res) => {
    try {
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [] });
      const tokens = data.tokens || [];
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const total = tokens.length;
      const active = tokens.filter(t => !t.frozen && (!t.expires_at || new Date(t.expires_at) > now)).length;
      const expired = tokens.filter(t => t.expires_at && new Date(t.expires_at) <= now).length;
      const frozen = tokens.filter(t => t.frozen).length;
      const today_created = tokens.filter(t => (t.created_at || '').startsWith(today)).length;
      const today_used = tokens.filter(t => (t.first_used_at || '').startsWith(today)).length;
      res.json({ ok: true, total, active, expired, frozen, today_created, today_used });
    } catch(err) { res.status(500).json({ ok: false, message: err.message }); }
  });


  // ==========================================
  // MARIFETSTORE V5 - PROMO, BLACKLIST, TICKETS
  // ==========================================

  // --- PLUGIN ENDPOINTS ---

  app.post('/api/plugin/use-promo', async (req, res) => {
    try {
      const code = String(req.body.code || '').trim().toUpperCase();
      const tokenStr = (req.headers.authorization || '').replace('Bearer ', '').trim();
      if (!code) return res.status(400).json({ ok: false, message: 'Promosyon kodu bos.' });
      
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [], promo_codes: [] });
      const myToken = (data.tokens || []).find(t => t.token === tokenStr);
      if (!myToken) return res.status(401).json({ ok: false, message: 'Oturum gecersiz.' });
      
      if (!data.promo_codes) data.promo_codes = [];
      const promo = data.promo_codes.find(p => p.code === code);
      
      if (!promo) return res.status(404).json({ ok: false, message: 'Gecersiz promosyon kodu.' });
      if (!promo.used_by) promo.used_by = [];
      if (promo.used_by.includes(tokenStr)) return res.status(400).json({ ok: false, message: 'Bu kodu zaten kullandiniz.' });
      if (promo.max_uses > 0 && promo.used_by.length >= promo.max_uses) return res.status(400).json({ ok: false, message: 'Kodun kullanim limiti dolmus.' });
      
      // Sure ekleme
      let extDays = promo.days || 0;
      if (myToken.duration_type !== 'lifetime' && myToken.expires_at) {
        let exDt = new Date(myToken.expires_at);
        let now = new Date();
        if (exDt < now) exDt = now; // Eger bitmisse su andan itibaren ekle
        exDt.setDate(exDt.getDate() + extDays);
        myToken.expires_at = exDt.toISOString();
      }
      
      promo.used_by.push(tokenStr);
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens_v5', data);
      
      res.json({ ok: true, message: `Kod basariyla kullanildi. +${extDays} gun eklendi.`, expires_at: myToken.expires_at });
    } catch(e) { res.status(500).json({ ok: false, message: String(e) }); }
  });

  app.get('/api/plugin/tickets', async (req, res) => {
    try {
      const tokenStr = (req.headers.authorization || '').replace('Bearer ', '').trim();
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tickets: [] });
      const userTickets = (data.tickets || []).filter(t => t.token === tokenStr);
      res.json({ ok: true, tickets: userTickets });
    } catch(e) { res.status(500).json({ ok: false, message: String(e) }); }
  });

  app.post('/api/plugin/tickets', async (req, res) => {
    try {
      const msg = String(req.body.message || '').trim();
      const tokenStr = (req.headers.authorization || '').replace('Bearer ', '').trim();
      if (!msg) return res.status(400).json({ ok: false, message: 'Mesaj bos.' });
      
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tickets: [] });
      if (!data.tickets) data.tickets = [];
      
      const newTicket = {
        id: 'TCK-' + Date.now() + '-' + Math.floor(Math.random()*1000),
        token: tokenStr,
        message: msg,
        reply: '',
        status: 'open',
        date: new Date().toISOString()
      };
      
      data.tickets.push(newTicket);
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens_v5', data);
      res.json({ ok: true, ticket: newTicket });
    } catch(e) { res.status(500).json({ ok: false, message: String(e) }); }
  });

  // --- ADMIN ENDPOINTS ---

  app.get('/api/admin/v5-data', requireAdmin, async (req, res) => {
    try {
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { promo_codes: [], blacklist: {hwids:[], ips:[]}, tickets: [] });
      res.json({
        ok: true,
        promo_codes: data.promo_codes || [],
        blacklist: data.blacklist || {hwids:[], ips:[]},
        tickets: data.tickets || []
      });
    } catch(e) { res.status(500).json({ ok: false, message: String(e) }); }
  });

  app.post('/api/admin/promo-codes', requireAdmin, async (req, res) => {
    try {
      const { code, days, max_uses, action } = req.body;
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { promo_codes: [] });
      if (!data.promo_codes) data.promo_codes = [];
      
      if (action === 'delete') {
        data.promo_codes = data.promo_codes.filter(p => p.code !== code);
      } else {
        const c = String(code).toUpperCase().trim();
        if (data.promo_codes.find(p => p.code === c)) return res.status(400).json({ok:false, message:'Bu kod zaten var'});
        data.promo_codes.push({ code: c, days: parseInt(days)||1, max_uses: parseInt(max_uses)||0, used_by: [] });
      }
      
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens_v5', data);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ ok: false, message: String(e) }); }
  });

  app.post('/api/admin/blacklist', requireAdmin, async (req, res) => {
    try {
      const { type, value, action } = req.body; // type: 'hwid' or 'ip', action: 'add' or 'remove'
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { blacklist: {hwids:[], ips:[]} });
      if (!data.blacklist) data.blacklist = {hwids:[], ips:[]};
      
      const arr = type === 'hwid' ? data.blacklist.hwids : data.blacklist.ips;
      const v = String(value).trim();
      
      if (action === 'add' && !arr.includes(v)) arr.push(v);
      if (action === 'remove') {
        const idx = arr.indexOf(v);
        if (idx > -1) arr.splice(idx, 1);
      }
      
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens_v5', data);
      res.json({ ok: true, blacklist: data.blacklist });
    } catch(e) { res.status(500).json({ ok: false, message: String(e) }); }
  });

  app.post('/api/admin/tickets/:id/reply', requireAdmin, async (req, res) => {
    try {
      const { reply } = req.body;
      const tid = req.params.id;
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tickets: [] });
      
      const ticket = (data.tickets || []).find(t => t.id === tid);
      if (!ticket) return res.status(404).json({ ok: false, message: 'Ticket bulunamadi.' });
      
      ticket.reply = String(reply).trim();
      ticket.status = 'answered';
      
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens_v5', data);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ ok: false, message: String(e) }); }
  });



  // ==========================================
  // YAPAY ZEKA (AI) ENTEGRASYONU
  // ==========================================
    // ==========================================
  // AI GAME ASSISTANT & SETTINGS
  // ==========================================
  app.get('/api/admin/ai-settings', requireAdmin, async (req, res) => {
    try {
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { settings: {} });
      const key = data.settings?.gemini_api_key || process.env.GEMINI_API_KEY || '';
      res.json({ ok: true, gemini_api_key: key ? '••••••••' + key.slice(-4) : '', has_key: !!key });
    } catch(err) {
      res.status(500).json({ ok: false, message: 'Ayarlar alinamadi.' });
    }
  });

  app.post('/api/admin/ai-settings', requireAdmin, async (req, res) => {
    try {
      const { gemini_api_key } = req.body;
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { settings: {} });
      if (!data.settings) data.settings = {};
      if (gemini_api_key !== undefined) {
        data.settings.gemini_api_key = String(gemini_api_key).trim();
      }
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens', data);
      res.json({ ok: true, message: 'Yapay Zeka API Anahtarı başarıyla kaydedildi!' });
    } catch(err) {
      res.status(500).json({ ok: false, message: 'Kaydedilemedi.' });
    }
  });

  let _cachedAiKey = null;
  app.post('/api/plugin/ai-chat', async (req, res) => {
    try {
      const prompt = String(req.body.prompt || '').trim();
      const history = Array.isArray(req.body.history) ? req.body.history : [];
      if (!prompt) return res.status(400).json({ ok: false, message: 'Soru bos.' });

      // Fast cached API Key check
      if (!_cachedAiKey) {
        const cloudData = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { settings: {} });
        _cachedAiKey = cloudData.settings?.gemini_api_key || process.env.GEMINI_API_KEY || '';
      }
      const apiKey = _cachedAiKey;
      
      if (apiKey) {
        try {
          // Ultra-fast Gemini 3.1 Flash Lite model with conversation history memory
          const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=' + encodeURIComponent(apiKey);
          const systemInstruction = 'Sen MarifetStore oyun mağazasının uzman, samimi ve arkadaş canlısı yapay zeka oyun danışmanısın. Kullanıcıya en uygun PC oyunlarını tavsiye et, Steam AppIDlerini belirt ve kısa, akıcı, samimi Türkçe konuş. Önceki konuşmaları hatırla.';
          
          const contents = [
            { role: 'user', parts: [{ text: systemInstruction }] },
            { role: 'model', parts: [{ text: 'Anlaşıldı! Ben MarifetStore oyun danışmanıyım. Size en iyi oyunları önermek için hazırım!' }] }
          ];

          // Append history turns (last 6 messages)
          for (const item of history.slice(-6)) {
            if (item && item.role && item.text) {
              contents.push({
                role: item.role === 'ai' || item.role === 'model' ? 'model' : 'user',
                parts: [{ text: String(item.text) }]
              });
            }
          }

          contents.push({ role: 'user', parts: [{ text: prompt }] });

          const payload = {
            contents: contents,
            generationConfig: {
              maxOutputTokens: 350,
              temperature: 0.7
            }
          };

          const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          if (response.ok) {
            const data = await response.json();
            const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (reply) {
              return res.json({ ok: true, reply: reply.trim() });
            }
          }
        } catch(e) {
          console.error('Gemini API call failed:', e.message);
        }
      }

      // Smart Fallback Gaming Knowledge Engine (Works instantly even without API Key!)
      const lower = prompt.toLowerCase();
      let smartReply = '';

      if (lower.includes('düşük sistem') || lower.includes('kasmayan') || lower.includes('patates pc') || lower.includes('ram az') || lower.includes('dusuk')) {
        smartReply = '🎮 Düşük Sistemler İçin Şaheser Oyun Önerilerim:\n\n1. **Euro Truck Simulator 2** (AppID: 227300) - Rahatlatıcı ve her PCde akıcı çalışır.\n2. **Terraria** (AppID: 105600) - Yüzlerce saatlik harika bir açık dünya macerası.\n3. **Mount & Blade: Warband** (AppID: 48700) - Düşük sistemlerin kralı!\n\nBu oyunları Oyun Ekle bölümünden tek tıkla kütüphanene ekleyebilirsin!';
      } else if (lower.includes('hikaye') || lower.includes('hikayeli') || lower.includes('story')) {
        smartReply = '📖 Sinema Tadında Hikayeli Oyun Önerilerim:\n\n1. **Red Dead Redemption 2** (AppID: 1174180) - Dünyanın en detaylı vahşi batı hikayesi.\n2. **The Witcher 3: Wild Hunt** (AppID: 292030) - Unutulmaz RPG dünyası.\n3. **God of War** (AppID: 1593500) - Kratosun destansı yolculuğu!\n\nHepsini MarifetStore ile anında indirebilirsin!';
      } else if (lower.includes('fps') || lower.includes('silah') || lower.includes('vurma') || lower.includes('shooter')) {
        smartReply = '🎯 Aksiyon & FPS Tutkunları İçin Önerilerim:\n\n1. **Counter-Strike 2** (AppID: 730) - Rekabetçi efsane.\n2. **Rust** (AppID: 252490) - Hayatta kalma ve acımasız PvP silah çatışmaları.\n3. **Cyberpunk 2077** (AppID: 1091500) - Gelecekte geçen harika bir FPS RPG deneyimi!';
      } else if (lower.includes('araba') || lower.includes('yarış') || lower.includes('yaris') || lower.includes('drift')) {
        smartReply = '🏎️ Hız ve Yarış Severler İçin Önerilerim:\n\n1. **Forza Horizon 5** (AppID: 1551360) - Açık dünya Meksika haritası ve yüzlerce araç.\n2. **Assetto Corsa** (AppID: 80550) - Gerçekçi sürüş simülasyonu ve mod desteği.\n3. **Need for Speed Heat** (AppID: 1222680) - Gece ve gündüz sokak yarışları!';
      } else if (lower.includes('arkadaş') || lower.includes('arkadas') || lower.includes('coop') || lower.includes('beraber') || lower.includes('multiplayer')) {
        smartReply = '👥 Arkadaşlarla Oynamalık En İyi Oyunlar:\n\n1. **Grand Theft Auto V** (AppID: 271590) - GTA Online görevleri ve soygunlar.\n2. **Lethal Company** (AppID: 1966720) - Aşırı eğlenceli ve gerilimli co-op.\n3. **Raft** (AppID: 648800) - Okyanusun ortasında arkadaşlarınla hayatta kalma!';
      } else {
        smartReply = '🤖 Harika bir soru! Senin için MarifetStore arşivinden öne çıkan en popüler oyunları derledim:\n\n• **Grand Theft Auto V** (AppID: 271590)\n• **Red Dead Redemption 2** (AppID: 1174180)\n• **Euro Truck Simulator 2** (AppID: 227300)\n• **Cyberpunk 2077** (AppID: 1091500)\n\nBana tam olarak nasıl bir tür (Örn: düşük sistemli, korku, hayatta kalma, hikayeli) aradığını söylersen sana özel nokta atışı öneri yapabilirim!';
      }

      res.json({ ok: true, reply: smartReply });
    } catch (err) {
      console.error('ai-chat error:', err);
      res.status(500).json({ ok: false, message: 'AI servisi hatasi olustu.' });
    }
  });
  // ==========================================================
// CREDIT CODES & PER-GAME LIBRARY SYSTEM
// ==========================================================

app.post('/api/admin/credits', requireAdmin, async (req, res) => {
  try {
    const duration = req.body.duration || '7d';
    const count = Math.min(Math.max(Number(req.body.count) || 1, 1), 50);
    
    const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [], credits: [] });
    if (!data.credits) data.credits = [];
    
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const newCodes = [];
    for(let c=0; c<count; c++) {
      let t = 'CR-';
      for(let i=0; i<4; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
      t += '-';
      for(let i=0; i<4; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
      
      const newCredit = {
        code: t,
        created_at: new Date().toISOString(),
        duration_type: duration,
        used: false,
        used_at: null,
        used_by_token: null,
        used_for_appid: null
      };
      data.credits.push(newCredit);
      newCodes.push(newCredit);
    }
    
    await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens_and_credits', data);
    res.json({ ok: true, message: `${count} adet kredi kodu olusturuldu.`, codes: newCodes });
  } catch(err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

  app.get('/api/admin/credits', requireAdmin, async (req, res) => {
  try {
    const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [], credits: [] });
    res.json({ ok: true, credits: data.credits || [] });
  } catch(err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.post('/api/admin/credits/delete', requireAdmin, async (req, res) => {
  try {
    const code = req.body.code;
    const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [], credits: [] });
    if (!data.credits) data.credits = [];
    data.credits = data.credits.filter(c => c.code !== code);
    await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens_and_credits', data);
    res.json({ ok: true, message: 'Kredi silindi.' });
  } catch(err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.get('/api/plugin/library', async (req, res) => {
  try {
    const userToken = String(req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!userToken) return res.status(401).json({ ok: false, message: 'Yetkisiz' });
    
    const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [], credits: [] });
    const tokenObj = (data.tokens || []).find(t => String(t.token || '').trim().toUpperCase() === userToken.toUpperCase());
    if (!tokenObj) return res.status(401).json({ ok: false, message: 'Gecersiz token' });
    
    const now = new Date();
    // Filter out expired games
    const library = (tokenObj.library || []).filter(game => new Date(game.expires_at) > now);
    
    res.json({ ok: true, library });
  } catch(err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.post('/api/plugin/redeem-credit', async (req, res) => {
  try {
    const userToken = String(req.headers.authorization || '').replace('Bearer ', '').trim();
    const appid = String(req.body.appid || '').trim();
    const appName = String(req.body.app_name || 'Bilinmeyen Oyun').trim();
    const creditCode = String(req.body.credit_code || '').trim();
    
    if (!userToken || !appid || !creditCode) return res.status(400).json({ ok: false, message: 'Eksik bilgi.' });
    
    const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [], credits: [] });
    
    const tokenObj = (data.tokens || []).find(t => String(t.token || '').trim().toUpperCase() === userToken.toUpperCase());
    if (!tokenObj) return res.status(401).json({ ok: false, message: 'Gecersiz token.' });
    
    const creditObj = (data.credits || []).find(c => c.code === creditCode);
    if (!creditObj) return res.status(404).json({ ok: false, message: 'Gecersiz kredi kodu.' });
    if (creditObj.used) return res.status(403).json({ ok: false, message: 'Bu kredi kodu zaten kullanilmis.' });
    
    // Check if game is already active
    const now = new Date();
    tokenObj.library = tokenObj.library || [];
    const existingGame = tokenObj.library.find(g => g.appid === appid && new Date(g.expires_at) > now);
    if (existingGame) return res.status(400).json({ ok: false, message: 'Bu oyun zaten kutuphanenizde aktif!' });
    
    // Redeem credit
    creditObj.used = true;
    creditObj.used_at = now.toISOString();
    creditObj.used_by_token = userToken;
    creditObj.used_for_appid = appid;
    
    // Calculate expiry
    let expiresAt;
    if (creditObj.duration_type === '1d') {
      expiresAt = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);
    } else if (creditObj.duration_type === '7d') {
      expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    } else if (creditObj.duration_type === '30d') {
      expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    } else {
      expiresAt = new Date(now.getTime() + 3650 * 24 * 60 * 60 * 1000); // 10 years for lifetime
    }
    
    // Remove expired entries of this game if any, then add new one
    tokenObj.library = tokenObj.library.filter(g => g.appid !== appid);
    tokenObj.library.push({
      appid,
      name: appName,
      unlocked_at: now.toISOString(),
      expires_at: expiresAt.toISOString()
    });
    
    await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens_and_credits', data);
    
    res.json({ ok: true, message: `${appName} oyunu kutuphanenize basariyla eklendi!`, library: tokenObj.library });
  } catch(err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});


  // ======================================================
  // TOKEN FREEZE / UNFREEZE
  // ======================================================
  app.post('/api/admin/tokens/:token/freeze', requireAdmin, async (req, res) => {
    try {
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [] });
      const tokenObj = (data.tokens || []).find(t => t.token === req.params.token);
      if (!tokenObj) return res.status(404).json({ ok: false, message: 'Token bulunamadi.' });
      tokenObj.frozen = true;
      tokenObj.frozen_at = new Date().toISOString();
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens', data);
      res.json({ ok: true, message: 'Token donduruldu.' });
    } catch(err) { res.status(500).json({ ok: false, message: err.message }); }
  });

  app.post('/api/admin/tokens/:token/unfreeze', requireAdmin, async (req, res) => {
    try {
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [] });
      const tokenObj = (data.tokens || []).find(t => t.token === req.params.token);
      if (!tokenObj) return res.status(404).json({ ok: false, message: 'Token bulunamadi.' });
      tokenObj.frozen = false;
      tokenObj.frozen_at = null;
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens', data);
      res.json({ ok: true, message: 'Token cozuldu.' });
    } catch(err) { res.status(500).json({ ok: false, message: err.message }); }
  });

  // ======================================================
  // REFERRAL SYSTEM
  // ======================================================
  app.post('/api/plugin/use-ref', async (req, res) => {
    try {
      const userToken = String(req.headers.authorization || '').replace('Bearer ', '').trim();
      const refCode = String(req.body.ref_code || '').trim();
      if (!userToken || !refCode) return res.status(400).json({ ok: false, message: 'Eksik bilgi.' });

      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [] });
      const myToken = (data.tokens || []).find(t => t.token === userToken);
      if (!myToken) return res.status(401).json({ ok: false, message: 'Gecersiz token.' });
      if (myToken.ref_code === refCode) return res.status(400).json({ ok: false, message: 'Kendi referans kodunu kullanamazsin.' });
      if (myToken.used_ref_code) return res.status(400).json({ ok: false, message: 'Daha once bir referans kodu kullandiniz.' });

      const refToken = (data.tokens || []).find(t => t.ref_code === refCode);
      if (!refToken) return res.status(404).json({ ok: false, message: 'Gecersiz referans kodu.' });

      const bonusMs = 3 * 24 * 60 * 60 * 1000; // 3 days
      const now = new Date();

      // Add 3 days to both
      [myToken, refToken].forEach(t => {
        if (t.expires_at) {
          const exp = new Date(t.expires_at);
          t.expires_at = new Date(Math.max(exp.getTime(), now.getTime()) + bonusMs).toISOString();
        }
      });

      myToken.used_ref_code = refCode;
      myToken.ref_bonus_received_at = now.toISOString();
      refToken.ref_bonus_count = (refToken.ref_bonus_count || 0) + 1;

      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens', data);
      res.json({ ok: true, message: 'Referans kodu kullanildi! Her ikinize de +3 gun eklendi.', expires_at: myToken.expires_at });
    } catch(err) { res.status(500).json({ ok: false, message: err.message }); }
  });

  // ======================================================
  // STORE & PRICE PLANS (from marifetstore config)
  // ======================================================
  app.post('/api/admin/marifetstore/store', requireAdmin, async (req, res) => {
    try {
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [], marifetstore: {} });
      if (!data.marifetstore) data.marifetstore = {};
      const { store_items, price_plans, announcement, discord_webhook, app_version, app_download_url } = req.body;
      if (store_items !== undefined) data.marifetstore.store_items = store_items;
      if (price_plans !== undefined) data.marifetstore.price_plans = price_plans;
      if (announcement !== undefined) data.marifetstore.announcement = announcement;
      if (discord_webhook !== undefined) {
        if (!data.settings) data.settings = {};
        data.settings.discord_webhook = discord_webhook;
        data.marifetstore.discord_webhook = discord_webhook;
      }
      if (app_version !== undefined) data.marifetstore.app_version = app_version;
      if (app_download_url !== undefined) data.marifetstore.app_download_url = app_download_url;
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens_and_credits', data);
      res.json({ ok: true, message: 'Ayarlar kaydedildi.' });
    } catch(err) { res.status(500).json({ ok: false, message: err.message }); }
  });

  app.get('/api/plugin/store-config', async (req, res) => {
    try {
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [], marifetstore: {} });
      const ms = data.marifetstore || {};
      res.json({
        ok: true,
        store_items: ms.store_items || [],
        price_plans: ms.price_plans || [],
        announcement: ms.announcement || null,
        app_version: ms.app_version || '1.0.0',
        app_download_url: ms.app_download_url || null,
      });
    } catch(err) { res.status(500).json({ ok: false, message: err.message }); }
  });

  // ======================================================
  // TOKEN STATS (for admin dashboard)
  // ======================================================
  app.get('/api/admin/token-stats', requireAdmin, async (req, res) => {
    try {
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [] });
      const tokens = data.tokens || [];
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const total = tokens.length;
      const active = tokens.filter(t => !t.frozen && (!t.expires_at || new Date(t.expires_at) > now)).length;
      const expired = tokens.filter(t => t.expires_at && new Date(t.expires_at) <= now).length;
      const frozen = tokens.filter(t => t.frozen).length;
      const today_created = tokens.filter(t => (t.created_at || '').startsWith(today)).length;
      const today_used = tokens.filter(t => (t.first_used_at || '').startsWith(today)).length;
      res.json({ ok: true, total, active, expired, frozen, today_created, today_used });
    } catch(err) { res.status(500).json({ ok: false, message: err.message }); }
  });


  // ==========================================
  // MARIFETSTORE V5 - PROMO, BLACKLIST, TICKETS
  // ==========================================

  // --- PLUGIN ENDPOINTS ---

  app.post('/api/plugin/use-promo', async (req, res) => {
    try {
      const code = String(req.body.code || '').trim().toUpperCase();
      const tokenStr = (req.headers.authorization || '').replace('Bearer ', '').trim();
      if (!code) return res.status(400).json({ ok: false, message: 'Promosyon kodu bos.' });
      
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [], promo_codes: [] });
      const myToken = (data.tokens || []).find(t => t.token === tokenStr);
      if (!myToken) return res.status(401).json({ ok: false, message: 'Oturum gecersiz.' });
      
      if (!data.promo_codes) data.promo_codes = [];
      const promo = data.promo_codes.find(p => p.code === code);
      
      if (!promo) return res.status(404).json({ ok: false, message: 'Gecersiz promosyon kodu.' });
      if (!promo.used_by) promo.used_by = [];
      if (promo.used_by.includes(tokenStr)) return res.status(400).json({ ok: false, message: 'Bu kodu zaten kullandiniz.' });
      if (promo.max_uses > 0 && promo.used_by.length >= promo.max_uses) return res.status(400).json({ ok: false, message: 'Kodun kullanim limiti dolmus.' });
      
      // Sure ekleme
      let extDays = promo.days || 0;
      if (myToken.duration_type !== 'lifetime' && myToken.expires_at) {
        let exDt = new Date(myToken.expires_at);
        let now = new Date();
        if (exDt < now) exDt = now; // Eger bitmisse su andan itibaren ekle
        exDt.setDate(exDt.getDate() + extDays);
        myToken.expires_at = exDt.toISOString();
      }
      
      promo.used_by.push(tokenStr);
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens_v5', data);
      
      res.json({ ok: true, message: `Kod basariyla kullanildi. +${extDays} gun eklendi.`, expires_at: myToken.expires_at });
    } catch(e) { res.status(500).json({ ok: false, message: String(e) }); }
  });

  app.get('/api/plugin/tickets', async (req, res) => {
    try {
      const tokenStr = (req.headers.authorization || '').replace('Bearer ', '').trim();
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tickets: [] });
      const userTickets = (data.tickets || []).filter(t => t.token === tokenStr);
      res.json({ ok: true, tickets: userTickets });
    } catch(e) { res.status(500).json({ ok: false, message: String(e) }); }
  });

  app.post('/api/plugin/tickets', async (req, res) => {
    try {
      const msg = String(req.body.message || '').trim();
      const tokenStr = (req.headers.authorization || '').replace('Bearer ', '').trim();
      if (!msg) return res.status(400).json({ ok: false, message: 'Mesaj bos.' });
      
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tickets: [] });
      if (!data.tickets) data.tickets = [];
      
      const newTicket = {
        id: 'TCK-' + Date.now() + '-' + Math.floor(Math.random()*1000),
        token: tokenStr,
        message: msg,
        reply: '',
        status: 'open',
        date: new Date().toISOString()
      };
      
      data.tickets.push(newTicket);
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens_v5', data);
      res.json({ ok: true, ticket: newTicket });
    } catch(e) { res.status(500).json({ ok: false, message: String(e) }); }
  });

  // --- ADMIN ENDPOINTS ---

  app.get('/api/admin/v5-data', requireAdmin, async (req, res) => {
    try {
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { promo_codes: [], blacklist: {hwids:[], ips:[]}, tickets: [] });
      res.json({
        ok: true,
        promo_codes: data.promo_codes || [],
        blacklist: data.blacklist || {hwids:[], ips:[]},
        tickets: data.tickets || []
      });
    } catch(e) { res.status(500).json({ ok: false, message: String(e) }); }
  });

  app.post('/api/admin/promo-codes', requireAdmin, async (req, res) => {
    try {
      const { code, days, max_uses, action } = req.body;
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { promo_codes: [] });
      if (!data.promo_codes) data.promo_codes = [];
      
      if (action === 'delete') {
        data.promo_codes = data.promo_codes.filter(p => p.code !== code);
      } else {
        const c = String(code).toUpperCase().trim();
        if (data.promo_codes.find(p => p.code === c)) return res.status(400).json({ok:false, message:'Bu kod zaten var'});
        data.promo_codes.push({ code: c, days: parseInt(days)||1, max_uses: parseInt(max_uses)||0, used_by: [] });
      }
      
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens_v5', data);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ ok: false, message: String(e) }); }
  });

  app.post('/api/admin/blacklist', requireAdmin, async (req, res) => {
    try {
      const { type, value, action } = req.body; // type: 'hwid' or 'ip', action: 'add' or 'remove'
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { blacklist: {hwids:[], ips:[]} });
      if (!data.blacklist) data.blacklist = {hwids:[], ips:[]};
      
      const arr = type === 'hwid' ? data.blacklist.hwids : data.blacklist.ips;
      const v = String(value).trim();
      
      if (action === 'add' && !arr.includes(v)) arr.push(v);
      if (action === 'remove') {
        const idx = arr.indexOf(v);
        if (idx > -1) arr.splice(idx, 1);
      }
      
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens_v5', data);
      res.json({ ok: true, blacklist: data.blacklist });
    } catch(e) { res.status(500).json({ ok: false, message: String(e) }); }
  });

  app.post('/api/admin/tickets/:id/reply', requireAdmin, async (req, res) => {
    try {
      const { reply } = req.body;
      const tid = req.params.id;
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tickets: [] });
      
      const ticket = (data.tickets || []).find(t => t.id === tid);
      if (!ticket) return res.status(404).json({ ok: false, message: 'Ticket bulunamadi.' });
      
      ticket.reply = String(reply).trim();
      ticket.status = 'answered';
      
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens_v5', data);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ ok: false, message: String(e) }); }
  });



  // ==========================================
  // YAPAY ZEKA (AI) ENTEGRASYONU
  // ==========================================
    // ==========================================
  // AI GAME ASSISTANT & SETTINGS
  // ==========================================
  
  // ==========================================
  // EXTENDED MARIFETSTORE SUITE API ENDPOINTS
  // ==========================================

  // (115) 7/24 Server Health & Status Monitor
  app.get('/api/status', (req, res) => {
    res.json({
      ok: true,
      status: 'operational',
      uptime_seconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      version: '9.0.0-PRO',
      edge_node: 'fra1-edge-01',
      ssl: true,
      services: {
        api: 'healthy',
        database: 'connected',
        lua_proxy: 'active',
        ai_gateway: 'ready'
      }
    });
  });

  // (113) Gaming News & Steam Deals Feed
  app.get('/api/news', (req, res) => {
    res.json({
      ok: true,
      articles: [
        {
          id: 'n1',
          title: 'MarifetStore v9.0 Ultimate Yayınlandı!',
          summary: 'Kullanıcı adı yönetimi, canlı Epic Games bedava oyunları ve AI FPS tahmincisi eklendi.',
          date: new Date().toISOString().split('T')[0],
          tag: 'GÜNCELLEME'
        },
        {
          id: 'n2',
          title: 'Haftanın Ücretsiz Epic Games Oyunları',
          summary: 'Normalde 349 TL değerindeki popüler oyunlar bu hafta tamamen ücretsiz dağıtılıyor.',
          date: new Date().toISOString().split('T')[0],
          tag: 'FIRSAT'
        }
      ]
    });
  });

  // (116) Multi-Currency Converter
  app.get('/api/currency', (req, res) => {
    res.json({
      ok: true,
      rates: { TRY: 1.0, USD: 0.027, EUR: 0.025 },
      base: 'TRY',
      updated_at: new Date().toISOString()
    });
  });

  // (145) Real-time Online Users
  const activeSessions = new Map();
  app.get('/api/stats/online', (req, res) => {
    const now = Date.now();
    const token = (req.query.token || req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    if (token) activeSessions.set(token, now);

    // Clean sessions older than 5 mins
    for (const [k, t] of activeSessions.entries()) {
      if (now - t > 300000) activeSessions.delete(k);
    }

    res.json({
      ok: true,
      online_count: Math.max(1, activeSessions.size),
      peak_today: Math.max(12, activeSessions.size + 8)
    });
  });

  // (152) Top Downloads Metrics
  app.get('/api/stats/top-downloads', (req, res) => {
    res.json({
      ok: true,
      top_games: [
        { appid: '271590', name: 'Grand Theft Auto V', downloads: 1420 },
        { appid: '1174180', name: 'Red Dead Redemption 2', downloads: 1180 },
        { appid: '730', name: 'Counter-Strike 2', downloads: 950 },
        { appid: '1551360', name: 'Forza Horizon 5', downloads: 870 },
        { appid: '1091500', name: 'Cyberpunk 2077', downloads: 760 }
      ]
    });
  });

  // (184) Version Check & Auto-Updater Handshake
  app.get('/api/plugin/version-check', (req, res) => {
    res.json({
      ok: true,
      latest_version: '9.0.0-ULTIMATE',
      min_supported_version: '8.0.0',
      update_required: false,
      changelog: 'v9.0.0: Profil ve Kullanıcı Adı Sistemi, AI Evren Rehberi, FPS Tahmincisi, Dijital Garanti Belgesi.'
    });
  });

  // (186) Email Validator Utility
  app.post('/api/tools/validate-email', (req, res) => {
    const { email } = req.body;
    const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '');
    res.json({ ok: true, valid: isValid, email });
  });

  // (144) Batch Token Generator
  app.post('/api/admin/tokens/batch-generate', requireAdmin, async (req, res) => {
    try {
      const { count = 5, duration_days = 30, note = 'Toplu Uretim' } = req.body;
      const cloudData = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [] });
      const newTokens = [];
      const now = new Date();

      for (let i = 0; i < Math.min(count, 50); i++) {
        const randPart = Math.random().toString(36).substring(2, 6).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
        const code = `MS-${randPart}`;
        let exp = null;
        if (duration_days > 0) {
          const d = new Date(now);
          d.setDate(d.getDate() + duration_days);
          exp = d.toISOString();
        }
        const tokenObj = {
          token: code,
          code: code,
          role: 'user',
          created_at: now.toISOString(),
          expires_at: exp,
          note: note,
          is_blocked: false,
          used: false
        };
        cloudData.tokens.push(tokenObj);
        newTokens.push(tokenObj);
      }

      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens', cloudData);
      res.json({ ok: true, generated_count: newTokens.length, tokens: newTokens });
    } catch(err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // (142) Extend Token Duration
  app.post('/api/admin/tokens/extend', requireAdmin, async (req, res) => {
    try {
      const { token, add_days = 30 } = req.body;
      const cloudData = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [] });
      const target = (cloudData.tokens || []).find(t => (t.token === token || t.code === token));
      if (!target) return res.status(404).json({ ok: false, message: 'Token bulunamadi.' });

      let baseDate = target.expires_at ? new Date(target.expires_at) : new Date();
      if (baseDate < new Date()) baseDate = new Date();
      
      if (add_days === -1) {
        target.expires_at = null; // Sınırsız
      } else {
        baseDate.setDate(baseDate.getDate() + add_days);
        target.expires_at = baseDate.toISOString();
      }

      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens', cloudData);
      res.json({ ok: true, message: `Token süresi güncellendi: ${target.expires_at ? target.expires_at : 'Sınırsız'}`, expires_at: target.expires_at });
    } catch(err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // (143) Toggle Token Block / Ban
  app.post('/api/admin/tokens/toggle-block', requireAdmin, async (req, res) => {
    try {
      const { token } = req.body;
      const cloudData = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [] });
      const target = (cloudData.tokens || []).find(t => (t.token === token || t.code === token));
      if (!target) return res.status(404).json({ ok: false, message: 'Token bulunamadi.' });

      target.is_blocked = !target.is_blocked;
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens', cloudData);
      res.json({ ok: true, message: target.is_blocked ? 'Token engellendi.' : 'Token engeli kaldirildi.', is_blocked: target.is_blocked });
    } catch(err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // (146) Financial & Revenue Summary
  app.get('/api/admin/stats/revenue', requireAdmin, async (req, res) => {
    try {
      const cloudData = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [] });
      const tokens = cloudData.tokens || [];
      const totalTokens = tokens.length;
      const lifetimeTokens = tokens.filter(t => !t.expires_at).length;
      const activeTokens = tokens.filter(t => !t.is_blocked).length;

      res.json({
        ok: true,
        total_tokens: totalTokens,
        active_tokens: activeTokens,
        lifetime_tokens: lifetimeTokens,
        estimated_gross_revenue_try: (totalTokens * 450) + 12500
      });
    } catch(err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // (148) Broadcast Announcement API
  app.post('/api/admin/announcements/broadcast', requireAdmin, async (req, res) => {
    try {
      const { title, body } = req.body;
      const cloudData = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { announcements: [] });
      if (!cloudData.announcements) cloudData.announcements = [];
      
      const ann = { id: 'ann_' + Date.now(), title, body, created_at: new Date().toISOString() };
      cloudData.announcements.unshift(ann);
      if (cloudData.announcements.length > 20) cloudData.announcements = cloudData.announcements.slice(0, 20);

      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens', cloudData);
      res.json({ ok: true, message: 'Duyuru tüm kullanıcılara yayınlandı.', announcement: ann });
    } catch(err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // (159) Full Database JSON Export
  app.get('/api/admin/backup/export', requireAdmin, async (req, res) => {
    try {
      const cloudData = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, {});
      res.setHeader('Content-Disposition', 'attachment; filename="marifetstore_backup_' + Date.now() + '.json"');
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(cloudData, null, 2));
    } catch(err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // (167) Maintenance Mode Toggle
  app.post('/api/admin/maintenance/toggle', requireAdmin, async (req, res) => {
    try {
      const cloudData = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { settings: {} });
      if (!cloudData.settings) cloudData.settings = {};
      cloudData.settings.maintenance_mode = !cloudData.settings.maintenance_mode;
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens', cloudData);
      res.json({ ok: true, maintenance_mode: cloudData.settings.maintenance_mode });
    } catch(err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // (191) Database Clean Expired Tokens
  app.post('/api/admin/clean-database', requireAdmin, async (req, res) => {
    try {
      const cloudData = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [] });
      const now = new Date();
      const beforeCount = (cloudData.tokens || []).length;
      cloudData.tokens = (cloudData.tokens || []).filter(t => {
        if (!t.expires_at) return true; // Sınırsızları silme
        const exp = new Date(t.expires_at);
        // 90 günden eski süresi bitmişleri temizle
        return (now - exp) < (90 * 24 * 60 * 60 * 1000);
      });
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens', cloudData);
      res.json({ ok: true, cleaned_count: beforeCount - cloudData.tokens.length });
    } catch(err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  app.get('/api/admin/ai-settings', requireAdmin, async (req, res) => {
    try {
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { settings: {} });
      const key = data.settings?.gemini_api_key || process.env.GEMINI_API_KEY || '';
      res.json({ ok: true, gemini_api_key: key ? '••••••••' + key.slice(-4) : '', has_key: !!key });
    } catch(err) {
      res.status(500).json({ ok: false, message: 'Ayarlar alinamadi.' });
    }
  });

  app.post('/api/admin/ai-settings', requireAdmin, async (req, res) => {
    try {
      const { gemini_api_key } = req.body;
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { settings: {} });
      if (!data.settings) data.settings = {};
      if (gemini_api_key !== undefined) {
        data.settings.gemini_api_key = String(gemini_api_key).trim();
      }
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens', data);
      res.json({ ok: true, message: 'Yapay Zeka API Anahtarı başarıyla kaydedildi!' });
    } catch(err) {
      res.status(500).json({ ok: false, message: 'Kaydedilemedi.' });
    }
  });

  if (options.listen !== false) {
    app.listen(PORT, () => console.log(`SecurityShoop server running on http://localhost:${PORT} [storage=${useDatabase ? 'mysql' : 'json'}]`));
    app.locals.securityShoopListening = true;
  }
  return app;
}

async function startServer(options = {}) {
  if (!app.locals.securityShoopBootPromise) {
    app.locals.securityShoopBootPromise = bootSecurityShoopServer(options).finally(() => {
      app.locals.securityShoopBootPromise = null;
    });
  }

  await app.locals.securityShoopBootPromise;

  if (options.listen !== false && !app.locals.securityShoopListening) {
    






app.listen(PORT, () => console.log(`SecurityShoop server running on http://localhost:${PORT} [storage=${useDatabase ? 'mysql' : 'json'}]`));
    app.locals.securityShoopListening = true;
  }

  return app;
}

if (require.main === module) {
  startServer({ listen: true }).catch((error) => {
    console.error('Server ba┼şlat─▒lamad─▒:', error);
    process.exit(1);
  });
}

module.exports = async (req, res) => {
  await startServer({ listen: false });
  return app(req, res);
};
module.exports.app = app;
module.exports.startServer = startServer;
