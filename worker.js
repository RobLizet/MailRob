// ══════════════════════════════════════════════════════
// MailRob – Cloudflare Worker
// Draait elke 5 minuten, stuurt push bij nieuwe e-mail
// ══════════════════════════════════════════════════════
//
// ENVIRONMENT VARIABLES (instellen in Cloudflare dashboard):
//   GMAIL_TOKEN        → Gmail OAuth token (zie stap 4 hieronder)
//   DB_URL             → https://siebes-wereld-default-rtdb.europe-west1.firebasedatabase.app
//
// SECRETS (instellen via: wrangler secret put NAAM):
//   SA_PRIVATE_KEY     → de private_key uit de service account JSON
//
// Vaste waarden staan hieronder ingebakken (project_id etc.)
// ══════════════════════════════════════════════════════

const PROJECT_ID    = 'siebes-wereld';
const CLIENT_EMAIL  = 'firebase-adminsdk-fbsvc@siebes-wereld.iam.gserviceaccount.com';
const DB_URL        = 'https://siebes-wereld-default-rtdb.europe-west1.firebasedatabase.app';
const LAST_ID_KEY   = 'mailrob_last_email_id';

export default {
  // Cron trigger: elke 5 minuten
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAndNotify(env));
  },

  // Ook testbaar via HTTP GET: https://jouw-worker.workers.dev/
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/test') {
      await checkAndNotify(env);
      return new Response('Check uitgevoerd — zie logs', { status: 200 });
    }
    return new Response('MailRob Worker actief ✓', { status: 200 });
  }
};

// ══════════════════════════════════
// HOOFD LOGICA
// ══════════════════════════════════
async function checkAndNotify(env) {
  try {
    const gmailToken = env.GMAIL_TOKEN;
    if (!gmailToken) { console.error('Geen GMAIL_TOKEN ingesteld'); return; }

    // 1. Haal FCM token op uit Firebase Realtime Database
    const fcmToken = await getFCMToken(env);
    if (!fcmToken) { console.error('Geen FCM token in database'); return; }

    // 2. Haal laatste ongelezen e-mails op via Gmail API
    const emails = await getNewEmails(gmailToken);
    if (!emails || emails.length === 0) { console.log('Geen nieuwe e-mails'); return; }

    // 3. Check welke echt nieuw zijn (niet al eerder gemeld)
    const lastId = await getLastId(env);
    const newEmails = lastId
      ? emails.filter(e => e.id > lastId)
      : emails.slice(0, 1); // eerste keer: alleen meest recente

    if (newEmails.length === 0) { console.log('Geen nieuwe e-mails sinds laatste check'); return; }

    // 4. Sla nieuwste ID op
    await saveLastId(env, emails[0].id);

    // 5. Stuur push melding voor elke nieuwe e-mail (max 3)
    const accessToken = await getFirebaseAccessToken(env);
    for (const email of newEmails.slice(0, 3)) {
      await sendPush(accessToken, fcmToken, email);
    }

    console.log(`${newEmails.length} melding(en) verstuurd`);
  } catch (e) {
    console.error('Worker fout:', e.message);
  }
}

// ══════════════════════════════════
// GMAIL
// ══════════════════════════════════
async function getNewEmails(token) {
  const r = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&labelIds=INBOX&q=is:unread',
    { headers: { Authorization: 'Bearer ' + token } }
  );
  if (!r.ok) { console.error('Gmail fout:', r.status); return []; }
  const data = await r.json();
  if (!data.messages) return [];

  const emails = await Promise.all(
    data.messages.slice(0, 3).map(m => getEmailDetail(token, m.id))
  );
  return emails.filter(Boolean);
}

async function getEmailDetail(token, id) {
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
    { headers: { Authorization: 'Bearer ' + token } }
  );
  if (!r.ok) return null;
  const m = await r.json();
  const h = {};
  (m.payload?.headers || []).forEach(x => { h[x.name] = x.value; });
  const match = (h.From || '').match(/^(.*?)\s*<(.+)>$/) || [];
  const from = match[1] ? match[1].replace(/"/g, '').trim() : (match[2] || h.From || 'Onbekend');
  return {
    id: m.internalDate || m.id,
    from,
    subject: h.Subject || '(geen onderwerp)',
    snippet: m.snippet || ''
  };
}

// ══════════════════════════════════
// FIREBASE REALTIME DB (token opslag)
// ══════════════════════════════════
async function getFCMToken(env) {
  const token = await getFirebaseAccessToken(env);
  const r = await fetch(`${DB_URL}/mailrob/fcm_token.json?access_token=${token}`);
  if (!r.ok) return null;
  const val = await r.json();
  return val || null;
}

async function getLastId(env) {
  const token = await getFirebaseAccessToken(env);
  const r = await fetch(`${DB_URL}/mailrob/${LAST_ID_KEY}.json?access_token=${token}`);
  if (!r.ok) return null;
  return await r.json();
}

async function saveLastId(env, id) {
  const token = await getFirebaseAccessToken(env);
  await fetch(`${DB_URL}/mailrob/${LAST_ID_KEY}.json?access_token=${token}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(id)
  });
}

// ══════════════════════════════════
// FCM PUSH VERSTUREN
// ══════════════════════════════════
async function sendPush(accessToken, fcmToken, email) {
  const body = {
    message: {
      token: fcmToken,
      notification: {
        title: '📧 ' + email.from,
        body: email.subject
      },
      data: {
        from: email.from,
        subject: email.subject
      },
      webpush: {
        notification: {
          icon: 'https://siebes-wereld.web.app/icon-192.png',
          badge: 'https://siebes-wereld.web.app/icon-192.png',
          vibrate: '200,100,200'
        },
        fcm_options: { link: '/' }
      }
    }
  };

  const r = await fetch(
    `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );

  if (!r.ok) {
    const err = await r.text();
    console.error('FCM fout:', err);
  } else {
    console.log('Push verstuurd naar:', email.from, '|', email.subject);
  }
}

// ══════════════════════════════════
// SERVICE ACCOUNT → ACCESS TOKEN
// JWT ondertekening zonder Node.js libs
// ══════════════════════════════════
async function getFirebaseAccessToken(env) {
  const privateKeyPem = env.SA_PRIVATE_KEY;
  if (!privateKeyPem) throw new Error('SA_PRIVATE_KEY niet ingesteld');

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/firebase https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const header = { alg: 'RS256', typ: 'JWT' };
  const enc = (obj) => btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const sigInput = enc(header) + '.' + enc(payload);

  // Import private key
  const keyData = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const keyBytes = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyBytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  // Sign
  const sigBytes = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(sigInput)
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const jwt = sigInput + '.' + sig;

  // Exchange JWT for access token
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });

  const data = await r.json();
  if (!data.access_token) throw new Error('Token ophalen mislukt: ' + JSON.stringify(data));
  return data.access_token;
}
