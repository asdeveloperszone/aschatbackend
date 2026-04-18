# ASChat Push Backend

Node.js server that delivers Web Push notifications to ASChat users even when the app is completely closed.

---

## ⚡ STEP 1 — Generate VAPID Keys (do this once, on your PC)

Install web-push globally:
```bash
npm install -g web-push
```

Generate keys:
```bash
npx web-push generate-vapid-keys
```

You'll get output like:
```
Public Key:
BExamplePublicKeyHere...

Private Key:
ExamplePrivateKeyHere...
```

**Save both keys — you'll need them in Step 3.**

---

## ⚡ STEP 2 — Deploy to Railway

1. Go to https://railway.app and sign up (free, no card needed)
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Push this `aschat-push-backend` folder to a GitHub repo first, then connect it
   — OR use Railway CLI:
   ```bash
   npm install -g @railway/cli
   railway login
   railway init
   railway up
   ```

---

## ⚡ STEP 3 — Set Environment Variables in Railway

In your Railway project dashboard → **Variables** tab, add:

| Variable           | Value                              |
|--------------------|------------------------------------|
| `VAPID_PUBLIC_KEY` | The public key from Step 1         |
| `VAPID_PRIVATE_KEY`| The private key from Step 1        |
| `VAPID_EMAIL`      | `mailto:your@email.com`            |
| `API_SECRET`       | Any random string (keep it secret) |

For `API_SECRET`, generate a good one:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## ⚡ STEP 4 — Get Your Railway URL

After deploy, Railway gives you a URL like:
```
https://aschat-push-backend-production-xxxx.up.railway.app
```

**Copy this URL** — you'll paste it into `notifications.js` in Step 5.

---

## ⚡ STEP 5 — Update notifications.js in your ASChat frontend

Open `js/notifications.js` and find these two lines near the top:

```javascript
const PUSH_SERVER_URL = 'YOUR_RAILWAY_URL_HERE';
const API_SECRET      = 'YOUR_API_SECRET_HERE';
```

Replace them:
```javascript
const PUSH_SERVER_URL = 'https://aschat-push-backend-production-xxxx.up.railway.app';
const API_SECRET      = 'the_same_secret_you_set_in_railway';
```

---

## ✅ That's it!

Re-deploy your ASChat frontend. Users who open the app will automatically subscribe to push notifications. From that point on:

- **App open** → notification shown immediately via SW postMessage
- **App backgrounded** → OS push notification delivered
- **App fully closed** → OS push notification delivered  
- **Phone locked** → OS push notification delivered
- **Browser not running** → OS push notification delivered (Android PWA)

---

## 🔍 Test it works

Visit your Railway URL in a browser:
```
https://your-railway-url.up.railway.app/
```

You should see:
```json
{ "service": "ASChat Push Backend", "status": "running", "users": 0, "subs": 0 }
```

After a user opens your app, `users` and `subs` will increase.
