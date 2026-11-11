'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const admin = require('firebase-admin');

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const ROOT = __dirname;

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

let db = null;
let firebaseInitError = null;

function initFirebase() {
  if (db) return db;
  if (firebaseInitError) throw firebaseInitError;

  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT environment variable is missing');
    const serviceAccount = JSON.parse(raw);
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL ||
          'https://splora-7abad-default-rtdb.asia-southeast1.firebasedatabase.app/'
      });
    }
    db = admin.database();
    return db;
  } catch (err) {
    firebaseInitError = err;
    throw err;
  }
}

function cleanUser(user) {
  const copy = { ...user };
  delete copy.password;
  delete copy.passwordHash;
  return copy;
}

function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('880')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return '0' + digits;
}

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, service: 'spl-user-app' });
});

app.post('/api/register', async (req, res) => {
  try {
    const database = initFirebase();
    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || '');
    const name = String(req.body.name || phone).trim();
    const invitedByCode = String(req.body.invitedByCode || '').trim().toUpperCase();
    const referralCode = String(req.body.referralCode || '').trim().toUpperCase();
    const deviceId = String(req.body.deviceId || '').trim();

    if (!/^01[3-9]\d{8}$/.test(phone)) {
      return res.status(400).json({ message: 'সঠিক ১১ ডিজিটের বাংলাদেশি মোবাইল নম্বর দিন।' });
    }
    if (password.length < 4 || password.length > 128) {
      return res.status(400).json({ message: 'পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে।' });
    }
    if (!/^SPL[A-Z0-9]{5,12}$/.test(referralCode)) {
      return res.status(400).json({ message: 'রেফারেল কোড তৈরি করা যায়নি। আবার চেষ্টা করুন।' });
    }

    const userRef = database.ref('users').child(phone);
    const existing = await userRef.once('value');
    if (existing.exists()) {
      return res.status(409).json({ message: 'এই মোবাইল নম্বরে ইতিমধ্যে অ্যাকাউন্ট রয়েছে।' });
    }

    let invitedByPhone = '';
    if (invitedByCode) {
      const refs = await database.ref('users').orderByChild('referralCode').equalTo(invitedByCode).limitToFirst(1).once('value');
      if (refs.exists()) {
        refs.forEach(snap => { invitedByPhone = snap.key; });
      } else {
        return res.status(400).json({ message: 'ইনভাইট কোডটি সঠিক নয়।' });
      }
    }

    const settingsSnap = await database.ref('site_settings').once('value');
    const settings = settingsSnap.val() || {};
    const bonusValue = Number(settings.registration_bonus ?? 50);
    const bonus = Number.isFinite(bonusValue) ? Math.max(0, Math.min(bonusValue, 100000)) : 0;
    const passwordHash = await bcrypt.hash(password, 12);

    const userData = {
      name,
      phone,
      passwordHash,
      balance: bonus,
      referralCode,
      invitedByCode: invitedByCode || '',
      invitedByPhone: invitedByPhone || '',
      isBanned: false,
      createdAt: admin.database.ServerValue.TIMESTAMP,
      deviceId
    };

    // Atomic create: prevents two requests from creating the same phone account.
    const result = await userRef.transaction(current => current === null ? userData : undefined);
    if (!result.committed) {
      return res.status(409).json({ message: 'এই মোবাইল নম্বরে ইতিমধ্যে অ্যাকাউন্ট রয়েছে।' });
    }

    if (deviceId) {
      const deviceRef = database.ref('devices').child(deviceId);
      await deviceRef.transaction(current => {
        const d = current || { count: 0, users: [] };
        const users = Array.isArray(d.users) ? d.users : [];
        if (!users.includes(phone)) users.push(phone);
        return { count: users.length, users, lastUpdated: Date.now() };
      }).catch(err => console.warn('Device history save failed:', err.message));
    }

    return res.status(201).json({ ok: true, bonus });
  } catch (err) {
    console.error('Registration error:', err);
    const missing = String(err.message || '').includes('FIREBASE_SERVICE_ACCOUNT');
    return res.status(missing ? 503 : 500).json({
      message: missing
        ? 'Firebase backend সেটআপ করা হয়নি। Render-এ FIREBASE_SERVICE_ACCOUNT যোগ করুন।'
        : 'নিবন্ধন সম্পন্ন করা যায়নি। Firebase configuration ও database সংযোগ পরীক্ষা করুন।'
    });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const database = initFirebase();
    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || '');
    if (!/^01[3-9]\d{8}$/.test(phone) || !password) {
      return res.status(400).json({ message: '১১ ডিজিটের মোবাইল নম্বর ও পাসওয়ার্ড দিন।' });
    }

    const snap = await database.ref('users').child(phone).once('value');
    if (!snap.exists()) return res.status(404).json({ message: 'অ্যাকাউন্ট পাওয়া যায়নি! আগে নিবন্ধন করুন।' });

    const user = snap.val() || {};
    if (user.isBanned) return res.status(403).json({ message: 'দুঃখিত, এই অ্যাকাউন্টটি ব্যান করা হয়েছে!' });

    let valid = false;
    if (user.passwordHash) {
      valid = await bcrypt.compare(password, user.passwordHash);
    } else if (typeof user.password === 'string') {
      // One-time compatibility for accounts created by the previous plaintext-password version.
      valid = user.password === password;
      if (valid) {
        const passwordHash = await bcrypt.hash(password, 12);
        await database.ref('users').child(phone).update({ passwordHash, password: null });
        user.passwordHash = passwordHash;
        delete user.password;
      }
    }

    if (!valid) return res.status(401).json({ message: 'ভুল পাসওয়ার্ড!' });
    return res.json({ ok: true, user: cleanUser(user) });
  } catch (err) {
    console.error('Login error:', err);
    const missing = String(err.message || '').includes('FIREBASE_SERVICE_ACCOUNT');
    return res.status(missing ? 503 : 500).json({
      message: missing
        ? 'Firebase backend সেটআপ করা হয়নি। Render-এ FIREBASE_SERVICE_ACCOUNT যোগ করুন।'
        : 'লগইন করা যায়নি। Firebase configuration ও database সংযোগ পরীক্ষা করুন।'
    });
  }
});

// Payment collection remains disabled until the merchant provides official API credentials.
app.post('/api/nekpay/collect', (_req, res) => {
  res.status(503).json({
    message: 'Payment gateway is not configured. Add the verified NEKpay server integration before accepting payments.'
  });
});

app.use(express.static(ROOT, {
  index: 'index.html',
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ message: 'API route not found' });
  const indexFile = path.join(ROOT, 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  next();
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`SPL server listening on ${PORT}`);
});
