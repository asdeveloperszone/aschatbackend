/**
 * ASChat Push Notification Backend
 * Deploy on Railway — handles Web Push subscriptions and sends push notifications.
 *
 * FLOW:
 *  1. User opens ASChat → frontend calls POST /api/subscribe → subscription saved in memory
 *  2. Message saved to Firebase → chat.js calls POST /api/send with message details
 *  3. This server calls webpush.sendNotification() → OS delivers it even if app is closed
 *
 * ENV VARS (set in Railway dashboard):
 *   VAPID_PUBLIC_KEY   — from `npx web-push generate-vapid-keys`
 *   VAPID_PRIVATE_KEY  — from `npx web-push generate-vapid-keys`
 *   VAPID_EMAIL        — mailto:you@example.com (your contact email)
 *   API_SECRET         — any random string, must match API_SECRET in notifications.js
 *   PORT               — set automatically by Railway
 *
 * NOTE: Subscriptions are stored in memory. They reset on Railway restart/redeploy.
 * Users will re-subscribe automatically next time they open the app (pwa.js handles this).
 */

'use strict';

const express = require('express');
const webpush = require('web-push');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── VALIDATE ENV ─────────────────────────────────────────────────────────────

const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL       = process.env.VAPID_EMAIL || 'mailto:admin@aschat.app';
const API_SECRET        = process.env.API_SECRET;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('[Boot] VAPID keys not set. Run: npx web-push generate-vapid-keys');
  process.exit(1);
}
if (!API_SECRET) {
  console.error('[Boot] API_SECRET not set. Set a random secret in Railway env vars.');
  process.exit(1);
}

// ─── WEB PUSH CONFIG ──────────────────────────────────────────────────────────

webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ─── IN-MEMORY SUBSCRIPTION STORE ────────────────────────────────────────────
// Map: userID → Set of subscription JSON strings
// Resets on restart — users re-subscribe automatically when they open the app

const store = new Map(); // userID → Map(subKey → subObject)

function subKey(sub) {
  return Buffer.from(sub.endpoint).toString('base64').slice(0, 40);
}

function addSubscription(userID, sub) {
  if (!store.has(userID)) store.set(userID, new Map());
  store.get(userID).set(subKey(sub), sub);
}

function removeSubscription(userID, sub) {
  if (store.has(userID)) store.get(userID).delete(subKey(sub));
}

function getSubscriptions(userID) {
  if (!store.has(userID)) return [];
  return Array.from(store.get(userID).values());
}

function totalSubs() {
  let n = 0;
  for (const m of store.values()) n += m.size;
  return n;
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-api-secret']
}));

app.use(express.json({ limit: '50kb' }));

function requireSecret(req, res, next) {
  if (req.headers['x-api-secret'] !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    service: 'ASChat Push Backend',
    status:  'running',
    users:   store.size,
    subs:    totalSubs()
  });
});

// ─── GET VAPID PUBLIC KEY ─────────────────────────────────────────────────────

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY });
});

// ─── SUBSCRIBE ────────────────────────────────────────────────────────────────

app.post('/api/subscribe', (req, res) => {
  const { userID, subscription } = req.body;

  if (!userID || !subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ error: 'Missing userID or subscription object' });
  }

  addSubscription(userID, subscription);
  console.log(`[Subscribe] User ${userID} — subs for user: ${getSubscriptions(userID).length}`);
  res.json({ ok: true });
});

// ─── UNSUBSCRIBE ──────────────────────────────────────────────────────────────

app.post('/api/unsubscribe', (req, res) => {
  const { userID, subscription } = req.body;
  if (userID && subscription) removeSubscription(userID, subscription);
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

  const subs = getSubscriptions(receiverID);
  if (subs.length === 0) {
    return res.json({ ok: true, sent: 0, reason: 'no_subscriptions' });
  }

  const payload = buildPayload({ type, senderName, senderID, text, callType, emoji, senderPhoto });

  let sent  = 0;
  let stale = 0;

  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
      sent++;
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        removeSubscription(receiverID, sub);
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

// ─── PAYLOAD BUILDER ─────────────────────────────────────────────────────────

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
      return { ...base, type: 'message', title: senderName, body: '📷 Photo' };

    case 'voice':
      return { ...base, type: 'message', title: senderName, body: '🎤 Voice message' };

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

// ─── ICE / TURN CREDENTIALS (proxied — keeps Metered key off client) ──────────
// Set METERED_API_KEY in Railway env vars — same key that was previously
// hardcoded in call.js (1fb7aac41a133ef1f772a26ea231b12b0825 or your own).

const METERED_API_KEY = process.env.METERED_API_KEY || '';
const METERED_APP     = process.env.METERED_APP     || 'aschat'; // subdomain

app.get('/api/ice-servers', async (req, res) => {
  if (!METERED_API_KEY) {
    // No key configured — return empty so call.js falls back to STUN only
    return res.json([]);
  }
  try {
    const url = `https://${METERED_APP}.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Metered API error: ' + response.status);
    const servers = await response.json();
    res.json(servers);
  } catch (err) {
    console.error('[ICE] Failed to fetch TURN credentials:', err.message);
    res.json([]); // Fallback to STUN only on client
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[ASChat Push] Server running on port ${PORT}`);
  console.log(`[ASChat Push] VAPID public key: ${VAPID_PUBLIC_KEY.slice(0, 20)}...`);
});
