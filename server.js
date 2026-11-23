// Barber booking app - zero dependencies. Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const TZ = process.env.SHOP_TZ || 'Europe/Sarajevo';
const SLOT_MIN = 30;
const DATA = path.join(__dirname, 'data.json');
const DAYS_AHEAD = 21;

const defaultHours = { 0: null, 1: ['09:00','17:00'], 2: ['09:00','17:00'], 3: ['09:00','17:00'], 4: ['09:00','17:00'], 5: ['09:00','17:00'], 6: null };
function load() {
  if (!fs.existsSync(DATA)) {
    const seed = {
      barbers: [
        { id: 'b1', name: 'Frki', pin: '1111', hours: defaultHours, daysOff: [] },
      ],
      bookings: [],
    };
    fs.writeFileSync(DATA, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(fs.readFileSync(DATA, 'utf8'));
}
let db = load();
const save = () => fs.writeFileSync(DATA, JSON.stringify(db, null, 2));

const sessions = new Map(); // token -> barberId

function nowInShop() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const toMin = t => +t.slice(0, 2) * 60 + +t.slice(3);
const fromMin = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const weekday = d => new Date(d + 'T12:00:00Z').getUTCDay();
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d + 'T12:00:00Z'));
const validTime = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

function slotsFor(barber, date) {
  const now = nowInShop();
  if (!validDate(date) || date < now.date || barber.daysOff.includes(date)) return [];
  const h = barber.hours[weekday(date)];
  if (!h) return [];
  const taken = new Set(db.bookings.filter(b => b.barberId === barber.id && b.date === date).map(b => b.time));
  const out = [];
  for (let m = toMin(h[0]); m + SLOT_MIN <= toMin(h[1]); m += SLOT_MIN) {
    const t = fromMin(m);
    if (date === now.date && t <= now.time) continue;
    if (!taken.has(t)) out.push(t);
  }
  return out;
}

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise(r => { let s = ''; req.on('data', c => { s += c; if (s.length > 1e5) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r({}); } }); });
const clean = (s, n) => String(s || '').replace(/[<>]/g, '').trim().slice(0, n);
const auth = req => sessions.get((req.headers.authorization || '').replace('Bearer ', ''));

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/manifest+json', '.png': 'image/png' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // ---- public API ----
    if (p === '/api/barbers' && req.method === 'GET')
      return send(res, 200, { tz: TZ, today: nowInShop().date, daysAhead: DAYS_AHEAD, slotMinutes: SLOT_MIN,
        barbers: db.barbers.map(b => ({ id: b.id, name: b.name })) });

    if (p === '/api/slots' && req.method === 'GET') {
      const b = db.barbers.find(x => x.id === url.searchParams.get('barber'));
      if (!b) return send(res, 404, { error: 'Frizer nije pronađen' });
      return send(res, 200, { slots: slotsFor(b, url.searchParams.get('date')) });
    }

    if (p === '/api/book' && req.method === 'POST') {
      const d = await body(req);
      const b = db.barbers.find(x => x.id === d.barberId);
      const name = clean(d.name, 60), phone = clean(d.phone, 30);
      if (!b || !name || !phone) return send(res, 400, { error: 'Unesite ime i broj telefona.' });
      if (!slotsFor(b, d.date).includes(d.time)) return send(res, 409, { error: 'Termin je upravo zauzet. Izaberite drugi.' });
      const booking = { id: crypto.randomUUID(), barberId: b.id, date: d.date, time: d.time, name, phone, createdAt: new Date().toISOString() };
      db.bookings.push(booking); save();
      return send(res, 200, { ok: true, booking: { ...booking, barber: b.name } });
    }

    // ---- admin API ----
    if (p === '/api/admin/login' && req.method === 'POST') {
      const d = await body(req);
      const b = db.barbers.find(x => x.id === d.barberId);
      if (!b || String(d.pin) !== b.pin) return send(res, 401, { error: 'Pogrešan PIN' });
      const token = crypto.randomBytes(24).toString('hex');
      sessions.set(token, b.id);
      return send(res, 200, { token });
    }
    if (p.startsWith('/api/admin/')) {
      const id = auth(req);
      const me = db.barbers.find(x => x.id === id);
      if (!me) return send(res, 401, { error: 'Niste prijavljeni' });

      if (p === '/api/admin/me' && req.method === 'GET') {
        const today = nowInShop().date;
        const bookings = db.bookings.filter(b => b.barberId === me.id && b.date >= today)
          .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
        return send(res, 200, { name: me.name, hours: me.hours, daysOff: me.daysOff.filter(d => d >= today), bookings, today });
      }
      if (p === '/api/admin/hours' && req.method === 'POST') {
        const d = await body(req), hours = {};
        for (let i = 0; i < 7; i++) {
          const h = d.hours && d.hours[i];
          if (!h) { hours[i] = null; continue; }
          if (!validTime(h[0]) || !validTime(h[1]) || toMin(h[0]) >= toMin(h[1])) return send(res, 400, { error: 'Neispravno radno vrijeme: početak mora biti prije kraja.' });
          hours[i] = [h[0], h[1]];
        }
        me.hours = hours; save(); return send(res, 200, { ok: true });
      }
      if (p === '/api/admin/dayoff' && req.method === 'POST') {
        const d = await body(req);
        if (!validDate(d.date)) return send(res, 400, { error: 'Invalid date' });
        if (d.off && !me.daysOff.includes(d.date)) me.daysOff.push(d.date);
        if (!d.off) me.daysOff = me.daysOff.filter(x => x !== d.date);
        save(); return send(res, 200, { ok: true });
      }
      if (p === '/api/admin/cancel' && req.method === 'POST') {
        const d = await body(req);
        db.bookings = db.bookings.filter(b => !(b.id === d.id && b.barberId === me.id));
        save(); return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'Not found' });
    }

    // ---- static ----
    let f = p === '/' ? '/index.html' : p === '/admin' ? '/admin.html' : p;
    const file = path.join(__dirname, 'public', path.normalize(f));
    if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) { console.error(e); send(res, 500, { error: 'Server error' }); }
}).listen(PORT, () => console.log(`Barber booking running on http://localhost:${PORT}  (admin: /admin)`));
