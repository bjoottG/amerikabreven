const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.SITE_PASSWORD || 'rolf1938';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/data', express.static(path.join(__dirname, 'data')));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'amerikabreven-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.redirect('/login');
}

function getLang(req) {
  return req.query.lang === 'en' ? 'en' : 'sv';
}

const brevData = [
  require('./letters/brev1')
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
  req.session.destroy();
  res.redirect('/login');
});

app.get('/', requireAuth, (req, res) => {
  const lang = getLang(req);
  res.render('index', { brev: getBrevIndex(lang), lang });
});

app.get('/brev/:id', requireAuth, (req, res) => {
  const lang = getLang(req);
  const brevet = brevData.find(b => b.id === parseInt(req.params.id));
  if (!brevet) return res.redirect('/');
  res.render('brev', { brevet, lang });
});

app.listen(PORT, () => {
  console.log(`Amerikabreven körs på port ${PORT}`);
});

module.exports = app;
