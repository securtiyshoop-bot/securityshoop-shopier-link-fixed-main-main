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
const CLOUD_STORAGE_IDS = {
  users: 'ff8081819ff5b11001a043506c03360b',
  activity_logs: 'ff8081819ff5b11001a04350703c360c',
  plugin_control: 'ff8081819ff5b11001a0435075fb360d',
  marifetstore: 'ff8081819ff5b11001a043507d05360e',
  hwid_bans: 'ff8081819ff5b11001a043508572360f',
  orders: 'ff8081819ff5b11001a0435091743610',
  tokens: 'ff8081819ff5b11001a0435d7b2f3674'
};

const cloudCache = new Map();

async function fetchCloudJson(id, fallback) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`https://api.restful-api.dev/objects/${id}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller.signal
    });
    clearTimeout(timeout);
    
    if (res.ok) {
      const parsed = await res.json();
      if (parsed && parsed.data) {
        cloudCache.set(id, parsed.data);
        return parsed.data;
      }
    }
  } catch (err) {
    console.error("fetchCloudJson error:", err);
  }
  return cloudCache.get(id) || fallback;
}

async function saveCloudJson(id, name, data) {
  cloudCache.set(id, data);
  try {
    const payload = JSON.stringify({ name: `securityshoop_${name}`, data });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://api.restful-api.dev/objects/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: payload,
      signal: controller.signal
    });
    clearTimeout(timeout);
    return res.ok;
  } catch (err) {
    console.error("saveCloudJson error:", err);
    return false;
  }
}


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
      res.status(500).json({ ok: false, message: 'Loglar alınamadı.' });
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
      res.status(500).json({ ok: false, message: 'Kullanıcılar alınamadı.' });
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
      if (!user) return res.status(404).json({ ok: false, message: 'Kullanıcı bulunamadı.' });
      if (user.role === 'admin') return res.status(400).json({ ok: false, message: 'Admin engellenemez.' });
      await updateUserBlock(id, true);
      await recordActivityLog({ user: req.session.user, action: 'ADMIN_BLOCK', details: `Target: ${user.email || id}` });
      res.json({ ok: true, message: 'Kullanıcı engellendi.' });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'İşlem başarısız.' });
    }
  });

  app.post('/api/admin/users/:id/ban-pc', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const user = await findUserById(id);
      if (!user) return res.status(404).json({ ok: false, message: 'Kullanıcı bulunamadı.' });
      if (user.role === 'admin') return res.status(400).json({ ok: false, message: 'Admin engellenemez.' });
      if (!normalizeHwid(user.hwid)) return res.status(400).json({ ok: false, message: 'Bu kullanıcıda HWID yok. Kullanıcı pluginden giriş yapmali.' });
      await addHwidBan({ hwid: user.hwid, user, reason: `Admin ban by ${req.session.user?.email || 'admin'}` });
      await recordActivityLog({ user: req.session.user, action: 'BAN_PC', details: `Target: ${user.email || id}, HWID: ${user.hwid}` });
      res.json({ ok: true, message: 'Bilgisayar banlandı.' });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'İşlem başarısız.' });
    }
  });

  app.post('/api/admin/users/:id/unblock', requireAdmin, async (req, res) => {
    try {
      const updated = await updateUserBlock(Number(req.params.id), false);
      if (updated === false) return res.status(404).json({ ok: false, message: 'Kullanıcı bulunamadı.' });
      await recordActivityLog({ user: req.session.user, action: 'ADMIN_UNBLOCK', details: `Target: ${req.params.id}` });
      res.json({ ok: true, message: 'Kullanıcı engeli kaldırıldı.' });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'İşlem başarısız.' });
    }
  });

  app.post('/api/admin/users/:id/delete', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const user = await findUserById(id);
      if (!user) return res.status(404).json({ ok: false, message: 'Kullanıcı bulunamadı.' });
      if (user.role === 'admin') return res.status(400).json({ ok: false, message: 'Admin silinemez.' });
      await deleteUserById(id);
      await recordActivityLog({ user: req.session.user, action: 'ADMIN_DELETE', details: `Target: ${user.email || id}` });
      res.json({ ok: true, message: 'Kullanıcı silindi.' });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, message: 'İşlem başarısız.' });
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
        return res.status(500).json({ ok: false, message: 'Shopier API veya ödeme linki ayarlanmamış.' });
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
      res.status(500).json({ ok: false, message: 'Yorumlar alınamadı.' });
    }
  });

  app.post('/api/reviews', requireAuth, async (req, res) => {
    try {
      const text = String(req.body.text || '').trim();
      if (!text) return res.status(400).json({ ok: false, message: 'Yorum boş olamaz.' });
      if (text.length < 3) return res.status(400).json({ ok: false, message: 'Yorum en az 3 karakter olmalı.' });
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
      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [] });
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let t = 'MS-';
      for(let i=0; i<4; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
      t += '-';
      for(let i=0; i<4; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
      const newToken = {
        token: t,
        created_at: new Date().toISOString(),
        used: false,
        used_at: null,
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

  app.post('/api/plugin/token-login', async (req, res) => {
    try {
      const userToken = String(req.body.token || '').trim();
      const hwid = String(req.body.hwid || '').trim();
      if (!userToken) return res.status(400).json({ ok: false, message: 'Token eksik.' });

      const data = await fetchCloudJson(CLOUD_STORAGE_IDS.tokens, { tokens: [] });
      const tokens = data.tokens || [];
      const tokenObj = tokens.find(t => t.token === userToken);

      if (!tokenObj) return res.status(404).json({ ok: false, message: 'Gecersiz token.' });
      if (tokenObj.used) return res.status(403).json({ ok: false, message: 'Bu token daha once kullanilmis.' });

      tokenObj.used = true;
      tokenObj.used_at = new Date().toISOString();
      tokenObj.used_by_hwid = hwid;
      await saveCloudJson(CLOUD_STORAGE_IDS.tokens, 'tokens', data);

      res.json({ ok: true, message: 'Giris basarili!', role: 'user', session_token: userToken });
    } catch (err) {
      console.error('token-login error:', err);
      res.status(500).json({ ok: false, message: 'Sunucu hatasi.' });
    }
  });

  app.all('/api/plugin/*', (req, res) => {
    res.status(404).json({
      ok: false,
      plugin_api: true,
      message: `Plugin API bulunamadi: ${req.method} ${req.path}`
    });
  });

  app.all('/api/*', (req, res) => {
    res.status(404).json({ ok: false, message: `API bulunamadi: ${req.method} ${req.path}` });
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
    console.error('Server başlatılamadı:', error);
    process.exit(1);
  });
}

module.exports = async (req, res) => {
  await startServer({ listen: false });
  return app(req, res);
};
module.exports.app = app;
module.exports.startServer = startServer;
