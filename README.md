# ASChat Push Backend

Node.js server that delivers Web Push notifications to ASChat users even when the app is completely closed. Subscriptions are stored in **Firebase Realtime Database** — they survive Railway restarts and redeployments.

---

## ⚡ STEP 1 — Generate VAPID Keys (once only)

```bash
npm install -g web-push
npx web-push generate-vapid-keys
```

Save both keys — you'll need them in Step 4.

---

## ⚡ STEP 2 — Get Firebase Service Account Key

1. Go to [Firebase Console](https://console.firebase.google.com) → your project
2. **Project Settings** → **Service Accounts** tab
3. Click **"Generate new private key"** → downloads a `.json` file
4. Open the file — you'll paste its full contents into Railway in Step 4

---

## ⚡ STEP 3 — Add Firebase RTDB Rules

In Firebase Console → **Realtime Database** → **Rules**, add this rule so only your backend (authenticated via Admin SDK) can read/write push subscriptions — the frontend cannot:

```json
{
  "rules": {
    "pushSubscriptions": {
      ".read":  false,
      ".write": false
    }
  }
}
```

The `false` rules are correct — Firebase Admin SDK bypasses all rules. Frontend users cannot see each other's push subscriptions.

---

## ⚡ STEP 4 — Set Railway Environment Variables

In Railway dashboard → your project → **Variables** tab:

| Variable | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | Public key from Step 1 |
| `VAPID_PRIVATE_KEY` | Private key from Step 1 |
| `VAPID_EMAIL` | `mailto:your@email.com` |
| `API_SECRET` | Any random string — must match `API_SECRET` in `js/notifications.js` |
| `FIREBASE_DATABASE_URL` | e.g. `https://your-project-default-rtdb.firebaseio.com` |
| `FIREBASE_SERVICE_ACCOUNT` | Paste the **entire JSON contents** of the service account file as one line |
| `METERED_API_KEY` | (optional) Your Metered.ca API key for TURN servers |

To paste the service account JSON on one line:
```bash
# On your PC, compact it:
node -e "console.log(JSON.stringify(require('./your-service-account.json')))"
# Paste that output as the FIREBASE_SERVICE_ACCOUNT value
```

---

## ⚡ STEP 5 — Deploy to Railway

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

Or push to GitHub and connect the repo in Railway dashboard.

---

## ✅ Verify It's Working

Visit your Railway URL:
```
https://your-url.up.railway.app/
```

You should see:
```json
{ "service": "ASChat Push Backend", "status": "running", "users": 2, "subs": 2 }
```

After a Railway restart, `users` and `subs` will still show the correct counts — subscriptions are in Firebase now.

---

## Firebase RTDB Schema

```
pushSubscriptions/
  $userID/
    $subKey/
      endpoint:  "https://fcm.googleapis.com/..."
      keys:
        p256dh:  "..."
        auth:    "..."
      updatedAt: 1234567890
```

- Each user can have multiple subscriptions (multiple devices)
- Stale subscriptions (410/404 from web-push) are automatically deleted
- Frontend cannot read this path (rules set to false)
- Admin SDK has full access

---

## How Notifications Flow

```
User A sends message
      ↓
chat.js → POST /api/send (with receiverID, type, text...)
      ↓
Backend reads pushSubscriptions/receiverID from Firebase RTDB
      ↓
webpush.sendNotification() for each device
      ↓
OS wakes sw.js on User B's device
      ↓
OS notification shown — even if browser/PWA is fully closed
```
