const fs = require('fs');
const crypto = require('crypto');

const ONLINE_WINDOW_MS = 1000 * 90;

function normalizeKeyCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 100);
}

function normalizeHwid(value) {
  return String(value || '').trim().slice(0, 255);
}

function cleanText(value, max = 190) {
  return String(value || '').trim().slice(0, max);
}

function nowIso() {
  return new Date().toISOString();
}

function toSqlDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 19).replace('T', ' ');
}

function isExpired(value) {
  if (!value) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time <= Date.now();
}

function createAppKeyCode() {
  return `SSAPP-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function createSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function ensureJsonFile(file) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ keys: [], sessions: [] }, null, 2), 'utf8');
}

function readJsonStore(file) {
  ensureJsonFile(file);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
    return {
      keys: Array.isArray(parsed.keys) ? parsed.keys : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : []
    };
  } catch {
    return { keys: [], sessions: [] };
  }
}

function writeJsonStore(file, data) {
  fs.writeFileSync(file, JSON.stringify({
    keys: Array.isArray(data.keys) ? data.keys.slice(0, 5000) : [],
    sessions: Array.isArray(data.sessions) ? data.sessions.slice(-5000) : []
  }, null, 2), 'utf8');
}

function keyIsOnline(key, sessions = []) {
  const deadline = Date.now() - ONLINE_WINDOW_MS;
  return sessions.some((session) => {
    if (String(session.status || '').toLowerCase() === 'blocked') return false;
    if (Number(session.key_id || 0) !== Number(key.id || 0)) return false;
    return new Date(session.last_seen_at || 0).getTime() >= deadline;
  });
}

function publicKeyPayload(key, sessions = []) {
  const related = sessions.filter((session) => Number(session.key_id || 0) === Number(key.id || 0));
  const lastSession = related
    .slice()
    .sort((a, b) => new Date(b.last_seen_at || 0) - new Date(a.last_seen_at || 0))[0] || null;
  return {
    id: key.id,
    code: key.code,
    label: key.label || '',
    status: key.status || 'active',
    assigned_hwid: key.assigned_hwid || '',
    device_name: lastSession?.device_name || '',
    app_version: lastSession?.app_version || '',
    first_ip: key.first_ip || '',
    last_ip: key.last_ip || lastSession?.ip || '',
    first_used_at: key.first_used_at || '',
    last_seen_at: key.last_seen_at || lastSession?.last_seen_at || '',
    expires_at: key.expires_at || '',
    created_by: key.created_by || '',
    created_at: key.created_at || '',
    note: key.note || '',
    role: key.role || 'user',
    online: keyIsOnline(key, related),
    session_count: related.length
  };
}

function publicSessionPayload(session) {
  return {
    id: session.id,
    key_id: session.key_id,
    hwid: session.hwid || '',
    device_name: session.device_name || '',
    app_version: session.app_version || '',
    ip: session.ip || '',
    status: session.status || 'online',
    started_at: session.started_at || '',
    last_seen_at: session.last_seen_at || '',
    online: new Date(session.last_seen_at || 0).getTime() >= Date.now() - ONLINE_WINDOW_MS
  };
}

async function ensureDatabase(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_keys (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(100) NOT NULL UNIQUE,
      label VARCHAR(190) NULL,
      status ENUM('active','used','blocked') NOT NULL DEFAULT 'active',
      assigned_hwid VARCHAR(255) NULL,
      first_ip VARCHAR(80) NULL,
      last_ip VARCHAR(80) NULL,
      first_used_at DATETIME NULL,
      last_seen_at DATETIME NULL,
      expires_at DATETIME NULL,
      created_by VARCHAR(190) NULL,
      note TEXT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_app_keys_status (status),
      INDEX idx_app_keys_hwid (assigned_hwid),
      INDEX idx_app_keys_last_seen (last_seen_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_sessions (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      key_id BIGINT NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      hwid VARCHAR(255) NOT NULL,
      device_name VARCHAR(190) NULL,
      app_version VARCHAR(80) NULL,
      ip VARCHAR(80) NULL,
      status ENUM('online','offline','blocked') NOT NULL DEFAULT 'online',
      started_at DATETIME NOT NULL,
      last_seen_at DATETIME NOT NULL,
      INDEX idx_app_sessions_key (key_id),
      INDEX idx_app_sessions_last_seen (last_seen_at),
      INDEX idx_app_sessions_hwid (hwid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function createKeysDb(pool, { count, label, expiresAt, createdBy, note, role }) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    const code = createAppKeyCode();
    await pool.query(
      'INSERT INTO app_keys (code, label, expires_at, created_by, note, role) VALUES (?, ?, ?, ?, ?, ?)',
      [code, label || null, toSqlDate(expiresAt), createdBy || null, note || null, role || 'user']
    );
    codes.push(code);
  }
  return codes;
}

function createKeysJson(file, { count, label, expiresAt, createdBy, note, role }) {
  const data = readJsonStore(file);
  const maxId = data.keys.reduce((max, key) => Math.max(max, Number(key.id) || 0), 0);
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    const code = createAppKeyCode();
    data.keys.push({
      id: maxId + i + 1,
      code,
      label,
      status: 'active',
      assigned_hwid: '',
      first_ip: '',
      last_ip: '',
      first_used_at: '',
      last_seen_at: '',
      expires_at: expiresAt || '',
      created_by: createdBy || '',
      note: note || '',
      role: role || 'user',
      created_at: nowIso()
    });
    codes.push(code);
  }
  writeJsonStore(file, data);
  return codes;
}

async function activateDb(pool, { code, hwid, deviceName, appVersion, ip }) {
  const connection = await pool.getConnection();
  const token = createSessionToken();
  const tokenHash = hashToken(token);
  const now = toSqlDate(new Date());
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query('SELECT * FROM app_keys WHERE code = ? LIMIT 1 FOR UPDATE', [code]);
    const key = rows[0];
    if (!key) {
      await connection.rollback();
      return { status: 404, body: { ok: false, message: 'Key bulunamadi.' } };
    }
    if (key.status === 'blocked') {
      await connection.rollback();
      return { status: 403, body: { ok: false, blocked: true, message: 'Bu key banlanmis.' } };
    }
    if (isExpired(key.expires_at)) {
      await connection.rollback();
      return { status: 403, body: { ok: false, blocked: true, message: 'Bu keyin suresi dolmus.' } };
    }
    if (key.assigned_hwid && key.assigned_hwid !== hwid) {
      await connection.rollback();
      return { status: 403, body: { ok: false, blocked: true, message: 'Bu key baska bir cihaza bagli.' } };
    }

    await connection.query(
      `UPDATE app_keys
       SET status = 'used',
           assigned_hwid = COALESCE(assigned_hwid, ?),
           first_ip = COALESCE(first_ip, ?),
           last_ip = ?,
           first_used_at = COALESCE(first_used_at, ?),
           last_seen_at = ?
       WHERE id = ?`,
      [hwid, ip || null, ip || null, now, now, key.id]
    );
    await connection.query(
      'INSERT INTO app_sessions (key_id, token_hash, hwid, device_name, app_version, ip, status, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, "online", ?, ?)',
      [key.id, tokenHash, hwid, deviceName || null, appVersion || null, ip || null, now, now]
    );
    await connection.commit();
    return {
      status: 200,
      body: {
        ok: true,
        token,
        message: 'Giris basarili.',
        key: publicKeyPayload({ ...key, status: 'used', assigned_hwid: key.assigned_hwid || hwid, last_ip: ip, last_seen_at: now })
      }
    };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

function activateJson(file, { code, hwid, deviceName, appVersion, ip }) {
  const data = readJsonStore(file);
  const key = data.keys.find((item) => normalizeKeyCode(item.code) === code);
  if (!key) return { status: 404, body: { ok: false, message: 'Key bulunamadi.' } };
  if (key.status === 'blocked') return { status: 403, body: { ok: false, blocked: true, message: 'Bu key banlanmis.' } };
  if (isExpired(key.expires_at)) return { status: 403, body: { ok: false, blocked: true, message: 'Bu keyin suresi dolmus.' } };
  if (key.assigned_hwid && key.assigned_hwid !== hwid) {
    return { status: 403, body: { ok: false, blocked: true, message: 'Bu key baska bir cihaza bagli.' } };
  }

  const token = createSessionToken();
  const now = nowIso();
  key.status = 'used';
  key.assigned_hwid = key.assigned_hwid || hwid;
  key.first_ip = key.first_ip || ip;
  key.last_ip = ip;
  key.first_used_at = key.first_used_at || now;
  key.last_seen_at = now;
  const sessionId = data.sessions.reduce((max, session) => Math.max(max, Number(session.id) || 0), 0) + 1;
  data.sessions.push({
    id: sessionId,
    key_id: key.id,
    token_hash: hashToken(token),
    hwid,
    device_name: deviceName,
    app_version: appVersion,
    ip,
    status: 'online',
    started_at: now,
    last_seen_at: now
  });
  writeJsonStore(file, data);
  return { status: 200, body: { ok: true, token, role: key.role || 'user', message: 'Giris basarili.', key: publicKeyPayload(key, data.sessions) } };
}

async function heartbeatDb(pool, { token, hwid, appVersion, ip }) {
  const tokenHash = hashToken(token);
  const [rows] = await pool.query(
    `SELECT s.*, k.code, k.label, k.status AS key_status, k.assigned_hwid, k.expires_at
     FROM app_sessions s
     JOIN app_keys k ON k.id = s.key_id
     WHERE s.token_hash = ?
     LIMIT 1`,
    [tokenHash]
  );
  const session = rows[0];
  if (!session) return { status: 401, body: { ok: false, message: 'Oturum bulunamadi.' } };
  if (session.key_status === 'blocked' || session.status === 'blocked') {
    return { status: 403, body: { ok: false, blocked: true, message: 'Bu key banlanmis.' } };
  }
  if (isExpired(session.expires_at)) {
    return { status: 403, body: { ok: false, blocked: true, message: 'Bu keyin suresi dolmus.' } };
  }
  if (session.assigned_hwid && session.assigned_hwid !== hwid) {
    return { status: 403, body: { ok: false, blocked: true, message: 'Cihaz dogrulanamadi.' } };
  }
  const now = toSqlDate(new Date());
  await pool.query('UPDATE app_sessions SET status = "online", last_seen_at = ?, app_version = COALESCE(?, app_version), ip = ? WHERE id = ?', [now, appVersion || null, ip || null, session.id]);
  await pool.query('UPDATE app_keys SET last_seen_at = ?, last_ip = ? WHERE id = ?', [now, ip || null, session.key_id]);
  return { status: 200, body: { ok: true, blocked: false, message: 'Online.', key: publicKeyPayload({ ...session, id: session.key_id, status: session.key_status, last_seen_at: now, last_ip: ip }) } };
}

function heartbeatJson(file, { token, hwid, appVersion, ip }) {
  const data = readJsonStore(file);
  const session = data.sessions.find((item) => item.token_hash === hashToken(token));
  if (!session) return { status: 401, body: { ok: false, message: 'Oturum bulunamadi.' } };
  const key = data.keys.find((item) => Number(item.id || 0) === Number(session.key_id || 0));
  if (!key) return { status: 401, body: { ok: false, message: 'Key bulunamadi.' } };
  if (key.status === 'blocked' || session.status === 'blocked') return { status: 403, body: { ok: false, blocked: true, message: 'Bu key banlanmis.' } };
  if (isExpired(key.expires_at)) return { status: 403, body: { ok: false, blocked: true, message: 'Bu keyin suresi dolmus.' } };
  if (key.assigned_hwid && key.assigned_hwid !== hwid) return { status: 403, body: { ok: false, blocked: true, message: 'Cihaz dogrulanamadi.' } };
  const now = nowIso();
  session.status = 'online';
  session.last_seen_at = now;
  session.app_version = appVersion || session.app_version || '';
  session.ip = ip || '';
  key.last_seen_at = now;
  key.last_ip = ip || '';
  writeJsonStore(file, data);
  return { status: 200, body: { ok: true, blocked: false, message: 'Online.', key: publicKeyPayload(key, data.sessions) } };
}

async function listKeysDb(pool) {
  const [keys] = await pool.query('SELECT * FROM app_keys ORDER BY created_at DESC, id DESC LIMIT 1000');
  const [sessions] = await pool.query('SELECT * FROM app_sessions ORDER BY last_seen_at DESC LIMIT 1000');
  return {
    keys: keys.map((key) => publicKeyPayload(key, sessions)),
    sessions: sessions.map(publicSessionPayload)
  };
}

function listKeysJson(file) {
  const data = readJsonStore(file);
  return {
    keys: data.keys.slice().sort((a, b) => Number(b.id || 0) - Number(a.id || 0)).map((key) => publicKeyPayload(key, data.sessions)),
    sessions: data.sessions.slice().sort((a, b) => new Date(b.last_seen_at || 0) - new Date(a.last_seen_at || 0)).map(publicSessionPayload)
  };
}

async function updateKeyStatusDb(pool, id, status) {
  const [result] = await pool.query('UPDATE app_keys SET status = ? WHERE id = ?', [status, Number(id)]);
  if (!result.affectedRows) return false;
  if (status === 'blocked') await pool.query('UPDATE app_sessions SET status = "blocked" WHERE key_id = ?', [Number(id)]);
  return true;
}

function updateKeyStatusJson(file, id, status) {
  const data = readJsonStore(file);
  const key = data.keys.find((item) => Number(item.id || 0) === Number(id));
  if (!key) return false;
  key.status = status;
  if (status === 'blocked') {
    data.sessions.forEach((session) => {
      if (Number(session.key_id || 0) === Number(id)) session.status = 'blocked';
    });
  }
  writeJsonStore(file, data);
  return true;
}

async function deleteKeyDb(pool, id) {
  await pool.query('DELETE FROM app_sessions WHERE key_id = ?', [Number(id)]);
  const [result] = await pool.query('DELETE FROM app_keys WHERE id = ?', [Number(id)]);
  return Boolean(result.affectedRows);
}

function deleteKeyJson(file, id) {
  const data = readJsonStore(file);
  const before = data.keys.length;
  data.keys = data.keys.filter((item) => Number(item.id || 0) !== Number(id));
  data.sessions = data.sessions.filter((item) => Number(item.key_id || 0) !== Number(id));
  writeJsonStore(file, data);
  return data.keys.length !== before;
}

function registerRoutes(app, deps) {
  app.post('/api/desktop/activate', async (req, res) => {
    try {
      if (!(await deps.requirePersistentStorage(req, res))) return;
      const code = normalizeKeyCode(req.body?.key || req.body?.code);
      const hwid = normalizeHwid(req.body?.hwid);
      if (!code || !hwid) return res.status(400).json({ ok: false, message: 'Key ve cihaz bilgisi gerekli.' });
      const payload = {
        code,
        hwid,
        deviceName: cleanText(req.body?.device_name || req.body?.deviceName, 190),
        appVersion: cleanText(req.body?.app_version || req.body?.appVersion, 80),
        ip: deps.getRequestIp(req)
      };
      const result = deps.useDatabase()
        ? await activateDb(deps.pool(), payload)
        : activateJson(deps.dataFile, payload);
      if (result.body?.ok && deps.recordActivityLog) {
        await deps.recordActivityLog({
          user: { username: 'desktop-app', email: result.body.key?.code || code },
          action: 'DESKTOP_APP_LOGIN',
          details: `HWID: ${hwid}, device=${payload.deviceName || '-'}`
        }).catch(() => {});
      }
      res.status(result.status).json(result.body);
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Uygulama girisi dogrulanamadi.' });
    }
  });

  app.post('/api/desktop/heartbeat', async (req, res) => {
    try {
      if (!(await deps.requirePersistentStorage(req, res))) return;
      const token = cleanText(req.body?.token, 200);
      const hwid = normalizeHwid(req.body?.hwid);
      if (!token || !hwid) return res.status(400).json({ ok: false, message: 'Oturum ve cihaz bilgisi gerekli.' });
      const result = deps.useDatabase()
        ? await heartbeatDb(deps.pool(), { token, hwid, appVersion: cleanText(req.body?.app_version || req.body?.appVersion, 80), ip: deps.getRequestIp(req) })
        : heartbeatJson(deps.dataFile, { token, hwid, appVersion: cleanText(req.body?.app_version || req.body?.appVersion, 80), ip: deps.getRequestIp(req) });
      res.status(result.status).json(result.body);
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Uygulama oturumu kontrol edilemedi.' });
    }
  });

  app.get('/api/admin/app-keys', deps.requireAdmin, async (req, res) => {
    try {
      if (!(await deps.requirePersistentStorage(req, res))) return;
      const data = deps.useDatabase() ? await listKeysDb(deps.pool()) : listKeysJson(deps.dataFile);
      res.json({ ok: true, storage: deps.useDatabase() ? 'mysql' : 'json', ...data });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Uygulama keyleri alinamadi.' });
    }
  });

  app.post('/api/admin/app-keys', deps.requireAdmin, async (req, res) => {
    try {
      if (!(await deps.requirePersistentStorage(req, res))) return;
      const count = Math.min(Math.max(Number(req.body?.count) || 1, 1), 100);
      const payload = {
        count,
        label: cleanText(req.body?.label, 190),
        expiresAt: cleanText(req.body?.expires_at || req.body?.expiresAt, 40),
        createdBy: cleanText(deps.getAdminUser(req)?.email || 'admin', 190),
        note: cleanText(req.body?.note, 1000),
        role: req.body?.role === 'admin' ? 'admin' : 'user'
      };
      const codes = deps.useDatabase()
        ? await createKeysDb(deps.pool(), payload)
        : createKeysJson(deps.dataFile, payload);
      if (deps.recordActivityLog) {
        await deps.recordActivityLog({ user: deps.getAdminUser(req), action: 'APP_KEYS_CREATE', details: `${count} key` }).catch(() => {});
      }
      res.json({ ok: true, message: `${count} uygulama keyi olusturuldu.`, codes });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Uygulama keyi olusturulamadi.' });
    }
  });

  app.post('/api/admin/admin-app-key', deps.requireAdmin, async (req, res) => {
    try {
      if (!(await deps.requirePersistentStorage(req, res))) return;
      const payload = {
        count: 1,
        label: cleanText(req.body?.label || 'MarifetStore Desktop Admin', 190),
        expiresAt: cleanText(req.body?.expires_at || req.body?.expiresAt, 40),
        createdBy: cleanText(deps.getAdminUser(req)?.email || 'admin', 190),
        note: cleanText(req.body?.note || 'Desktop administrator key', 1000),
        role: 'admin'
      };
      const codes = deps.useDatabase()
        ? await createKeysDb(deps.pool(), payload)
        : createKeysJson(deps.dataFile, payload);
      if (deps.recordActivityLog) {
        await deps.recordActivityLog({
          user: deps.getAdminUser(req),
          action: 'DESKTOP_ADMIN_KEY_CREATE',
          details: 'Desktop admin key olusturuldu.'
        }).catch(() => {});
      }
      res.json({ ok: true, message: 'Desktop admin key olusturuldu.', code: codes[0] || '' });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Desktop admin key olusturulamadi.' });
    }
  });

  app.post('/api/admin/app-keys/:id/block', deps.requireAdmin, async (req, res) => {
    try {
      if (!(await deps.requirePersistentStorage(req, res))) return;
      const updated = deps.useDatabase()
        ? await updateKeyStatusDb(deps.pool(), req.params.id, 'blocked')
        : updateKeyStatusJson(deps.dataFile, req.params.id, 'blocked');
      if (!updated) return res.status(404).json({ ok: false, message: 'Key bulunamadi.' });
      if (deps.recordActivityLog) await deps.recordActivityLog({ user: deps.getAdminUser(req), action: 'APP_KEY_BLOCK', details: `ID: ${req.params.id}` }).catch(() => {});
      res.json({ ok: true, message: 'Key banlandi.' });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Key banlanamadi.' });
    }
  });

  app.post('/api/admin/app-keys/:id/unblock', deps.requireAdmin, async (req, res) => {
    try {
      if (!(await deps.requirePersistentStorage(req, res))) return;
      const updated = deps.useDatabase()
        ? await updateKeyStatusDb(deps.pool(), req.params.id, 'used')
        : updateKeyStatusJson(deps.dataFile, req.params.id, 'used');
      if (!updated) return res.status(404).json({ ok: false, message: 'Key bulunamadi.' });
      if (deps.recordActivityLog) await deps.recordActivityLog({ user: deps.getAdminUser(req), action: 'APP_KEY_UNBLOCK', details: `ID: ${req.params.id}` }).catch(() => {});
      res.json({ ok: true, message: 'Key bani kaldirildi.' });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Key bani kaldirilamadi.' });
    }
  });

  app.post('/api/admin/app-keys/:id/delete', deps.requireAdmin, async (req, res) => {
    try {
      if (!(await deps.requirePersistentStorage(req, res))) return;
      const deleted = deps.useDatabase()
        ? await deleteKeyDb(deps.pool(), req.params.id)
        : deleteKeyJson(deps.dataFile, req.params.id);
      if (!deleted) return res.status(404).json({ ok: false, message: 'Key bulunamadi.' });
      if (deps.recordActivityLog) await deps.recordActivityLog({ user: deps.getAdminUser(req), action: 'APP_KEY_DELETE', details: `ID: ${req.params.id}` }).catch(() => {});
      res.json({ ok: true, message: 'Key silindi.' });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'Key silinemedi.' });
    }
  });
}

module.exports = {
  ensureDatabase,
  registerRoutes
};
