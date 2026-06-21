const express = require('express');
const cookieSession = require('cookie-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.SITE_PASSWORD || 'rolf1938';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'alto255';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/data', express.static(path.join(__dirname, 'data')));
app.use(express.urlencoded({ extended: true }));
app.use(cookieSession({
  name: 'ab_session',
  secret: process.env.SESSION_SECRET || 'amerikabreven-secret-2024',
  maxAge: 30 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax'
}));

// ── Auth ─────────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session.admin) return next();
  res.redirect('/admin/login');
}

function getLang(req) {
  return req.query.lang === 'en' ? 'en' : 'sv';
}

// ── Redis / Persistent storage ────────────────────────────────────────────────

let redis = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const { Redis } = require('@upstash/redis');
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

// In-memory fallback for local development
const minnesFallback = [];

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function sparaInlagg(entry) {
  if (redis) {
    await redis.hset(`gastbok:entry:${entry.id}`, {
      id: entry.id,
      namn: entry.namn,
      epost: entry.epost,
      meddelande: entry.meddelande,
      datum: entry.datum,
      godkand: 'true'
    });
    await redis.lpush('gastbok:ids', entry.id);
  } else {
    minnesFallback.unshift({ ...entry, godkand: true });
  }
}

async function hamtaInlagg(allesammans = false) {
  if (redis) {
    const ids = await redis.lrange('gastbok:ids', 0, -1);
    const inlagg = [];
    for (const id of ids) {
      const e = await redis.hgetall(`gastbok:entry:${id}`);
      if (e) {
        e.godkand = e.godkand === 'true';
        if (allesammans || e.godkand) inlagg.push(e);
      }
    }
    return inlagg;
  }
  return allesammans ? minnesFallback : minnesFallback.filter(e => e.godkand);
}

async function raderaInlagg(id) {
  if (redis) {
    await redis.lrem('gastbok:ids', 0, id);
    await redis.del(`gastbok:entry:${id}`);
  } else {
    const i = minnesFallback.findIndex(e => e.id === id);
    if (i >= 0) minnesFallback.splice(i, 1);
  }
}

async function vaxlaGodkand(id) {
  if (redis) {
    const aktuell = await redis.hget(`gastbok:entry:${id}`, 'godkand');
    await redis.hset(`gastbok:entry:${id}`, { godkand: aktuell === 'true' ? 'false' : 'true' });
  } else {
    const e = minnesFallback.find(e => e.id === id);
    if (e) e.godkand = !e.godkand;
  }
}

// Obfuscate email addresses in a text string (protects against spam scrapers)
function obfusceraMejl(text) {
  return text.replace(/[\w.+%-]+@[\w.-]+\.[a-z]{2,}/gi, (mejl) =>
    mejl.split('').map(c => `&#${c.charCodeAt(0)};`).join('')
  );
}
app.locals.obfusceraMejl = obfusceraMejl;

// ── Brev data ─────────────────────────────────────────────────────────────────

const brevData = [
  require('./letters/brev1'),
  require('./letters/brev2')
];

function getBrevIndex(lang) {
  return brevData.map(b => ({
    id: b.id,
    datum: lang === 'en' ? b.datumEn : b.datumSv,
    ort: b.ort,
    avsandare: b.avsandare,
    rubrik: lang === 'en' ? b.en.title : b.sv.rubrik,
    ingress: lang === 'en' ? b.en.intro : b.sv.ingress
  }));
}

// ── Site auth routes ───────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/');
  res.render('login', { fel: null });
});

app.post('/login', (req, res) => {
  if (req.body.losenord === PASSWORD) {
    req.session.authenticated = true;
    res.redirect('/');
  } else {
    res.render('login', { fel: 'Fel lösenord. Försök igen.' });
  }
});

app.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

// ── Letter routes ──────────────────────────────────────────────────────────────

app.get('/', requireAuth, (req, res) => {
  const lang = getLang(req);
  res.render('index', { brev: getBrevIndex(lang), lang });
});

app.get('/om', requireAuth, (req, res) => {
  res.render('om', { lang: getLang(req) });
});

app.get('/brev/:id', requireAuth, (req, res) => {
  const lang = getLang(req);
  const brevet = brevData.find(b => b.id === parseInt(req.params.id));
  if (!brevet) return res.redirect('/');
  res.render('brev', { brevet, lang });
});

// ── Guestbook routes ───────────────────────────────────────────────────────────

app.get('/gastbok', requireAuth, async (req, res) => {
  const lang = getLang(req);
  const inlagg = await hamtaInlagg(false);
  res.render('gastbok', { inlagg, lang, fel: null, ok: req.query.ok === '1' });
});

app.post('/gastbok', requireAuth, async (req, res) => {
  const lang = getLang(req);
  const namn = (req.body.namn || '').trim().slice(0, 100);
  const epost = (req.body.epost || '').trim().slice(0, 200);
  const meddelande = (req.body.meddelande || '').trim().slice(0, 400);

  if (!namn || !meddelande) {
    const inlagg = await hamtaInlagg(false);
    const felmeddelande = lang === 'en'
      ? 'Name and message are required.'
      : 'Namn och meddelande är obligatoriska.';
    return res.render('gastbok', { inlagg, lang, fel: felmeddelande, ok: false });
  }

  await sparaInlagg({ id: genId(), namn, epost, meddelande, datum: new Date().toISOString() });
  res.redirect(`/gastbok?lang=${lang}&ok=1`);
});

// ── Admin routes ───────────────────────────────────────────────────────────────

app.get('/admin/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin/gastbok');
  res.render('admin-login', { fel: null });
});

app.post('/admin/login', (req, res) => {
  if (req.body.losenord === ADMIN_PASSWORD) {
    req.session.admin = true;
    req.session.authenticated = true;
    res.redirect('/admin/gastbok');
  } else {
    res.render('admin-login', { fel: 'Fel lösenord.' });
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.admin = false;
  res.redirect('/');
});

app.get('/admin/gastbok', requireAdmin, async (req, res) => {
  const inlagg = await hamtaInlagg(true);
  res.render('admin-gastbok', { inlagg });
});

app.post('/admin/gastbok/delete/:id', requireAdmin, async (req, res) => {
  await raderaInlagg(req.params.id);
  res.redirect('/admin/gastbok');
});

app.post('/admin/gastbok/toggle/:id', requireAdmin, async (req, res) => {
  await vaxlaGodkand(req.params.id);
  res.redirect('/admin/gastbok');
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Amerikabreven körs på port ${PORT}`);
});

module.exports = app;
