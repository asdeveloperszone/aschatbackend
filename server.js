/**
 * ASChat Push Notification Backend
 * Deploy on Railway — handles Web Push subscriptions and sends push notifications.
 *
 * FLOW:
 *  1. User opens ASChat → frontend calls POST /api/subscribe → subscription saved to Firebase RTDB
 *  2. Message saved to Firebase → chat.js calls POST /api/send with message details
 *  3. This server reads receiver's subscriptions from RTDB → calls webpush.sendNotification()
 *  4. OS delivers notification even if app is fully closed
 *
 * ENV VARS (set in Railway dashboard):
 *   VAPID_PUBLIC_KEY        — from `npx web-push generate-vapid-keys`
 *   VAPID_PRIVATE_KEY       — from `npx web-push generate-vapid-keys`
 *   VAPID_EMAIL             — mailto:you@example.com
 *   API_SECRET              — random string, must match API_SECRET in notifications.js
 *   FIREBASE_DATABASE_URL   — e.g. https://your-project-default-rtdb.firebaseio.com
 *   FIREBASE_SERVICE_ACCOUNT — full JSON string of your Firebase service account key
 *   METERED_API_KEY         — (optional) for TURN server credentials
 *   METERED_APP             — (optional) your Metered subdomain, default: aschat
 *   PORT                    — set automatically by Railway
 *
 * Firebase RTDB schema:
 *   pushSubscriptions/
 *     $userID/
 *       $subKey/           ← base64 of endpoint (first 40 chars)
 *         endpoint: "..."
 *         keys: { p256dh: "...", auth: "..." }
 *         updatedAt: 1234567890
 */

'use strict';

const express  = require('express');
const webpush  = require('web-push');
const cors     = require('cors');
const admin    = require('firebase-admin');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── VALIDATE ENV ─────────────────────────────────────────────────────────────

const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL       = process.env.VAPID_EMAIL || 'mailto:admin@aschat.app';
const API_SECRET        = process.env.API_SECRET;
const DATABASE_URL      = process.env.FIREBASE_DATABASE_URL;
const SERVICE_ACCOUNT   = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('[Boot] VAPID keys not set. Run: npx web-push generate-vapid-keys');
  process.exit(1);
}
if (!API_SECRET) {
  console.error('[Boot] API_SECRET not set.');
  process.exit(1);
}
if (!DATABASE_URL || !SERVICE_ACCOUNT) {
  console.error('[Boot] FIREBASE_DATABASE_URL and FIREBASE_SERVICE_ACCOUNT must be set.');
  process.exit(1);
}

// ─── FIREBASE ADMIN INIT ──────────────────────────────────────────────────────

let serviceAccount;
try {
  serviceAccount = JSON.parse(SERVICE_ACCOUNT);
} catch (e) {
  console.error('[Boot] FIREBASE_SERVICE_ACCOUNT is not valid JSON:', e.message);
  process.exit(1);
}

admin.initializeApp({
  credential:  admin.credential.cert(serviceAccount),
  databaseURL: DATABASE_URL
});

const db = admin.database();

console.log('[Boot] Firebase Admin connected to:', DATABASE_URL);

// ─── WEB PUSH CONFIG ──────────────────────────────────────────────────────────

webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ─── FIREBASE RTDB SUBSCRIPTION STORE ────────────────────────────────────────
// Path: pushSubscriptions/$userID/$subKey → { endpoint, keys, updatedAt }
// Survives Railway restarts, redeployments, and crashes.

function subKey(sub) {
  return Buffer.from(sub.endpoint).toString('base64').replace(/[/+=]/g, '_').slice(0, 40);
}

async function addSubscription(userID, sub) {
  const key  = subKey(sub);
  const path = `pushSubscriptions/${userID}/${key}`;
  await db.ref(path).set({
    endpoint:  sub.endpoint,
    keys:      sub.keys,
    updatedAt: Date.now()
  });
}

async function removeSubscription(userID, sub) {
  const key = subKey(sub);
  await db.ref(`pushSubscriptions/${userID}/${key}`).remove().catch(() => {});
}

async function removeSubscriptionByKey(userID, key) {
  await db.ref(`pushSubscriptions/${userID}/${key}`).remove().catch(() => {});
}

async function getSubscriptions(userID) {
  const snap = await db.ref(`pushSubscriptions/${userID}`).once('value');
  if (!snap.exists()) return [];
  const entries = snap.val();
  return Object.entries(entries).map(([key, data]) => ({ key, sub: data }));
}

async function countAll() {
  const snap = await db.ref('pushSubscriptions').once('value');
  if (!snap.exists()) return { users: 0, subs: 0 };
  const val = snap.val();
  const users = Object.keys(val).length;
  const subs  = Object.values(val).reduce((n, m) => n + Object.keys(m).length, 0);
  return { users, subs };
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

app.use(cors({
  origin:       '*',
  methods:      ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-api-secret']
}));

// FIX: /api/subscribe uses a higher limit because the push subscription object
// can be large on some browsers. /api/send only needs small JSON payloads.
app.use('/api/subscribe', express.json({ limit: '512kb' }));
app.use('/api/send',      express.json({ limit: '50kb' }));
app.use(express.json({ limit: '100kb' }));

function requireSecret(req, res, next) {
  if (req.headers['x-api-secret'] !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

app.get('/', async (req, res) => {
  try {
    const { users, subs } = await countAll();
    res.json({ service: 'ASChat Push Backend', status: 'running', users, subs });
  } catch (e) {
    res.json({ service: 'ASChat Push Backend', status: 'running', error: e.message });
  }
});

// ─── GET VAPID PUBLIC KEY ─────────────────────────────────────────────────────

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY });
});

// ─── SUBSCRIBE ────────────────────────────────────────────────────────────────

app.post('/api/subscribe', async (req, res) => {
  const { userID, subscription } = req.body;

  if (!userID || !subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ error: 'Missing userID or subscription object' });
  }

  // FIX: only save the fields web-push actually needs — endpoint and keys.
  // Reject any extra fields (e.g. accidental base64 photo blobs) that would
  // bloat Firebase and cause PayloadTooLargeError on future requests.
  const cleanSub = {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.keys.p256dh,
      auth:   subscription.keys.auth
    }
  };

  if (!cleanSub.keys.p256dh || !cleanSub.keys.auth) {
    return res.status(400).json({ error: 'Subscription missing p256dh or auth key' });
  }

  try {
    await addSubscription(userID, cleanSub);
    const subs = await getSubscriptions(userID);
    console.log(`[Subscribe] User ${userID} — devices registered: ${subs.length}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Subscribe] Firebase write failed:', err.message);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

// ─── UNSUBSCRIBE ──────────────────────────────────────────────────────────────

app.post('/api/unsubscribe', async (req, res) => {
  const { userID, subscription } = req.body;
  if (userID && subscription) {
    await removeSubscription(userID, subscription).catch(() => {});
  }
  res.json({ ok: true });
});

// ─── SEND PUSH ────────────────────────────────────────────────────────────────

app.post('/api/send', requireSecret, async (req, res) => {
  const {
    receiverID, type, senderName, senderID,
    text, callType, emoji, senderPhoto
  } = req.body;

  if (!receiverID || !type || !senderName || !senderID) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  let entries;
  try {
    entries = await getSubscriptions(receiverID);
  } catch (err) {
    console.error('[Send] Failed to read subscriptions:', err.message);
    return res.status(500).json({ error: 'Failed to read subscriptions' });
  }

  if (entries.length === 0) {
    return res.json({ ok: true, sent: 0, reason: 'no_subscriptions' });
  }

  const payload = JSON.stringify(
    buildPayload({ type, senderName, senderID, text, callType, emoji, senderPhoto })
  );

  let sent  = 0;
  let stale = 0;

  await Promise.all(entries.map(async ({ key, sub }) => {
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expired — remove from RTDB permanently
        await removeSubscriptionByKey(receiverID, key);
        stale++;
        console.log(`[Send] Stale sub removed for user ${receiverID}`);
      } else {
        console.error(`[Send] Push failed for user ${receiverID}:`, err.message);
      }
    }
  }));

  console.log(`[Send] type=${type} to=${receiverID} sent=${sent} stale=${stale}`);
  res.json({ ok: true, sent, stale });
});

// ─── PAYLOAD BUILDER ──────────────────────────────────────────────────────────

function buildPayload({ type, senderName, senderID, text, callType, emoji, senderPhoto }) {
  const base = {
    senderName,
    senderID,
    senderPhoto: senderPhoto || null,
    timestamp:   Date.now()
  };

  switch (type) {
    case 'message':
      return { ...base, type: 'message', title: senderName, body: text || 'New message' };

    case 'photo':
      return { ...base, type: 'photo', title: senderName, body: '📷 Photo' };

    case 'voice':
      return { ...base, type: 'voice', title: senderName, body: '🎤 Voice message' };

    case 'call': {
      const icon = callType === 'video' ? '📹' : '📞';
      return {
        ...base, type: 'call', callType,
        title: `${icon} ${senderName} is calling...`,
        body:  callType === 'video' ? 'Incoming video call' : 'Incoming voice call'
      };
    }

    case 'missed_call': {
      const icon = callType === 'video' ? '📹' : '📞';
      return {
        ...base, type: 'missed_call', callType,
        title: `Missed call from ${senderName}`,
        body:  `${icon} You missed a ${callType || 'voice'} call`
      };
    }

    case 'reaction':
      return {
        ...base, type: 'reaction',
        title: `${senderName} reacted to your message`,
        body:  emoji || '❤️'
      };

    default:
      return { ...base, type: 'message', title: senderName, body: text || 'New message' };
  }
}

// ─── ICE / TURN CREDENTIALS ───────────────────────────────────────────────────

const METERED_API_KEY = process.env.METERED_API_KEY || '';
const METERED_APP     = process.env.METERED_APP     || 'aschat';

app.get('/api/ice-servers', async (req, res) => {
  if (!METERED_API_KEY) return res.json([]);
  try {
    const url      = `https://${METERED_APP}.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Metered API error: ' + response.status);
    res.json(await response.json());
  } catch (err) {
    console.error('[ICE] Failed to fetch TURN credentials:', err.message);
    res.json([]);
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[ASChat Push] Server running on port ${PORT}`);
  console.log(`[ASChat Push] VAPID public key: ${VAPID_PUBLIC_KEY.slice(0, 20)}...`);
});

// ─── GLOBAL ERROR HANDLER ─────────────────────────────────────────────────────
// Catches PayloadTooLargeError and other Express middleware errors cleanly
// instead of crashing the process or returning an unformatted 500.
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  console.error('[Server] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

