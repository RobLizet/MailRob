// MailRob – Cloudflare Worker (Web Push)
// Draait elke 5 minuten, stuurt push bij nieuwe e-mail

const VAPID_PUBLIC    = 'BEtZX7FIeg8N3vnLSsCbrQN8Of2mJukKovMXzqqerfauRHjPQiau3B2i5f_rfoa2jf76i-RAhmPDQxUkxEu2ov8';
const VAPID_SUBJECT   = 'mailto:rhjborghouts@ziggo.nl';
const DB_URL          = 'https://siebes-wereld-default-rtdb.europe-west1.firebasedatabase.app';
const SA_CLIENT_EMAIL = 'firebase-adminsdk-fbsvc@siebes-wereld.iam.gserviceaccount.com';
const LAST_ID_KEY     = 'mailrob_last_email_id';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAndNotify(env));
  },
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/test') {
      await checkAndNotify(env);
      return new Response('Check uitgevoerd — zie logs', { status: 200 });
    }
    return new Response('MailRob Worker actief', { status: 200 });
  }
};

async function checkAndNotify(env) {
  try {
    if (!env.GMAIL_TOKEN) { console.error('Geen GMAIL_TOKEN'); return; }

    const sub = await getPushSub(env);
    if (!sub) { console.error('Geen push_sub in DB — open MailRob en tik Inschakelen'); return; }

    const emails = await getNewEmails(env.GMAIL_TOKEN);
    if (!emails.length) { console.log('Geen ongelezen e-mails'); return; }

    const lastId = await getLastId(env);
    const newEmails = lastId ? emails.filter(e => e.id > lastId) : emails.slice(0, 1);
    if (!newEmails.length) { console.log('Geen nieuwe sinds laatste check'); return; }

    await saveLastId(env, emails[0].id);

    for (const email of newEmails.slice(0, 3)) {
      await sendWebPush(env, sub, email);
    }
    console.log(`${newEmails.length} melding(en) verstuurd`);
  } catch(e) {
    console.error('Worker fout:', e.message, e.stack);
  }
}

async function getNewEmails(token) {
  const r = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&labelIds=INBOX&q=is:unread',
    { headers: { Authorization: 'Bearer ' + token } }
  );
  if (!r.ok) { console.error('Gmail fout:', r.status); return []; }
  const data = await r.json();
  if (!data.messages) return [];
  const emails = await Promise.all(data.messages.slice(0,3).map(m => getEmailDetail(token, m.id)));
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
  const match = (h.From||'').match(/^(.*?)\s*<(.+)>$/) || [];
  const from = match[1] ? match[1].replace(/"/g,'').trim() : (match[2]||h.From||'Onbekend');
  return { id: m.internalDate||m.id, from, subject: h.Subject||'(geen onderwerp)' };
}

async function getPushSub(env) {
  const token = await getFirebaseToken(env);
  const r = await fetch(`${DB_URL}/mailrob/push_sub.json?access_token=${token}`);
  if (!r.ok) return null;
  const val = await r.json();
  if (!val) return null;
  try { return typeof val === 'string' ? JSON.parse(val) : val; } catch(e) { return null; }
}

async function getLastId(env) {
  const token = await getFirebaseToken(env);
  const r = await fetch(`${DB_URL}/mailrob/${LAST_ID_KEY}.json?access_token=${token}`);
  if (!r.ok) return null;
  return await r.json();
}

async function saveLastId(env, id) {
  const token = await getFirebaseToken(env);
  await fetch(`${DB_URL}/mailrob/${LAST_ID_KEY}.json?access_token=${token}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(id)
  });
}

async function sendWebPush(env, subscription, email) {
  const payload = JSON.stringify({
    title: '📧 ' + email.from,
    body: email.subject,
    icon: 'https://roblizet.github.io/MailRob/icon-192.png'
  });

  const vapidToken = await makeVapidJwt(env, subscription.endpoint);

  const r = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${vapidToken}, k=${VAPID_PUBLIC}`,
      'Content-Type': 'application/json',
      'TTL': '86400'
    },
    body: payload
  });

  if (r.ok || r.status === 201) {
    console.log('Push verstuurd:', email.from);
  } else {
    console.error('Push fout:', r.status, await r.text());
  }
}

async function makeVapidJwt(env, endpoint) {
  const privateKeyB64 = env.VAPID_PRIVATE;
  if (!privateKeyB64) throw new Error('VAPID_PRIVATE niet ingesteld');

  const audience = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const enc = obj => btoa(JSON.stringify(obj)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const sigInput = enc({typ:'JWT',alg:'ES256'}) + '.' + enc({aud:audience,exp:now+43200,sub:VAPID_SUBJECT});

  const keyBytes = Uint8Array.from(atob(privateKeyB64), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', keyBytes.buffer, {name:'ECDSA',namedCurve:'P-256'}, false, ['sign']);
  const sigBytes = await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'}, key, new TextEncoder().encode(sigInput));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBytes))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');

  return sigInput + '.' + sig;
}

async function getFirebaseToken(env) {
  const pem = env.SA_PRIVATE_KEY;
  if (!pem) throw new Error('SA_PRIVATE_KEY niet ingesteld');
  const now = Math.floor(Date.now() / 1000);
  const enc = obj => btoa(JSON.stringify(obj)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const sigInput = enc({alg:'RS256',typ:'JWT'}) + '.' + enc({iss:SA_CLIENT_EMAIL,scope:'https://www.googleapis.com/auth/firebase https://www.googleapis.com/auth/datastore',aud:'https://oauth2.googleapis.com/token',exp:now+3600,iat:now});
  const keyData = pem.replace(/-----BEGIN PRIVATE KEY-----/,'').replace(/-----END PRIVATE KEY-----/,'').replace(/\s+/g,'');
  const keyBytes = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', keyBytes.buffer, {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'}, false, ['sign']);
  const sigBytes = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(sigInput));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBytes))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const jwt = sigInput + '.' + sig;
  const r = await fetch('https://oauth2.googleapis.com/token', {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`});
  const data = await r.json();
  if (!data.access_token) throw new Error('Firebase token mislukt: ' + JSON.stringify(data));
  return data.access_token;
}
