// Spielstand-Test: Bleibt der Spielstand bei einem Update erhalten?
//
// Ablauf pro Spiel:
//  1. Die bisherige Version (OLD_DIR) wird unter derselben Adresse ausgeliefert wie später die neue.
//  2. Ein Spielstand wird angelegt und mit Testwerten versehen, dann wird die Seite verlassen (dabei wird gespeichert).
//  3. Die neue Version (Repository) ersetzt die Dateien, die Seite wird neu geöffnet.
//  4. Geprüft wird: kein Fehler, alle bisherigen Werte sind unverändert vorhanden (neue Felder dürfen dazukommen).
//
// Aufruf: node tests/spielstand-test.cjs <OLD_DIR>
//   OLD_DIR enthält die bisherige Version (z. B. von der veröffentlichten Seite geladen).
//   Fehlt dort ein Spiel (ganz neues Spiel), wird nur der Neustart mit der neuen Version geprüft.
const fs = require('fs'), path = require('path'), http = require('http');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OLD = path.resolve(process.argv[2] || '');
const SITE = fs.mkdtempSync(path.join(require('os').tmpdir(), 'spielstand-'));

// Werte, die sich beim Laden legitim ändern (Zeitstempel, Spielzeit, Figur-Position)
const VOLATILE = new Set(['savedAt', 'time', 'play', 'px', 'py']);

const GAMES = [
  { name: 'Zahlcraft', dir: '', hook: '__zc',
    seed: async pg => { await pg.fill('#playerName', 'Testkind'); await pg.click('#nameForm button[type=submit]'); },
    mark: 'S.xp=(S.xp||0)+4321;S.inv=S.inv||{};S.inv.diamond=(S.inv.diamond||0)+7;S.streak=5' },
  { name: 'Zahlongus', dir: 'zahlongus/', hook: '__zl',
    seed: async pg => { await pg.fill('#pn', 'Testkind'); await pg.click('#nf button'); },
    mark: "S.stars=77;S.owned['🍀']=1;S.hat='🍀';S.color=7;S.wins=3" },
  { name: 'Zahlimon', dir: 'zahlimon/', hook: '__zahlimon',
    seed: async pg => { await pg.evaluate(() => { const z = window.__zahlimon; const S = z.fresh('Testkind'); S.team = [{ id: 'flammi', lvl: 5, xp: 0, uid: S.uid++, hp: 20 }]; S.starterUid = S.team[0].uid; z.S = S; }); },
    mark: 'S.coins=(S.coins||0)+99;S.testMarker=42' },
];

function serve(dir) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.txt': 'text/plain', '.json': 'application/json', '.png': 'image/png' };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(dir, p);
    if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nicht gefunden'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

// Prüft, ob alles aus "alt" unverändert in "neu" steckt. Neue Felder sind erlaubt.
function missing(oldV, newV, p, out) {
  if (VOLATILE.has(p.split('.').pop())) return out;
  if (oldV && typeof oldV === 'object' && !Array.isArray(oldV)) {
    if (!newV || typeof newV !== 'object') { out.push(`${p}: fehlt`); return out; }
    for (const k of Object.keys(oldV)) missing(oldV[k], newV[k], p ? `${p}.${k}` : k, out);
  } else if (JSON.stringify(oldV) !== JSON.stringify(newV)) {
    out.push(`${p}: vorher ${JSON.stringify(oldV)?.slice(0, 60)}, nachher ${JSON.stringify(newV)?.slice(0, 60)}`);
  }
  return out;
}

const put = (from, dir) => { const t = path.join(SITE, dir); fs.mkdirSync(t, { recursive: true }); fs.copyFileSync(from, path.join(t, 'index.html')); };

(async () => {
  const srv = await serve(SITE), base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  let failed = 0;
  for (const g of GAMES) {
    const oldFile = path.join(OLD, g.dir, 'index.html'), newFile = path.join(ROOT, g.dir, 'index.html');
    const ctx = await browser.newContext(), pg = await ctx.newPage(), errs = [];
    pg.on('pageerror', e => errs.push(e.message));
    const url = base + g.dir, getS = () => pg.evaluate(h => JSON.parse(JSON.stringify(window[h].S)), g.hook);
    try {
      const hasOld = OLD && fs.existsSync(oldFile);
      put(hasOld ? oldFile : newFile, g.dir);
      await pg.goto(url); await pg.waitForTimeout(1200);
      if (!(await pg.evaluate(h => !!(window[h] && window[h].S), g.hook))) { await g.seed(pg); await pg.waitForTimeout(800); }
      await pg.evaluate(([h, m]) => { const S = window[h].S; new Function('S', m)(S); }, [g.hook, g.mark]);
      await pg.goto('about:blank'); await pg.waitForTimeout(300); // verlassen = speichern
      await pg.goto(url); await pg.waitForTimeout(1200);
      const before = await getS();
      await pg.goto('about:blank'); await pg.waitForTimeout(300);
      put(newFile, g.dir); // Update einspielen
      await pg.goto(url); await pg.waitForTimeout(1500);
      const after = await getS();
      const diff = missing(before, after, '', []);
      if (after.name !== 'Testkind') diff.unshift('Name fehlt, der Spielstand wurde nicht übernommen');
      if (errs.length) diff.push('Fehler auf der Seite: ' + errs.join(' | '));
      if (diff.length) { failed++; console.log(`✗ ${g.name}${hasOld ? '' : ' (neues Spiel)'}:\n  ` + diff.slice(0, 15).join('\n  ')); }
      else console.log(`✓ ${g.name}: Spielstand bleibt erhalten${hasOld ? ' (alte → neue Version)' : ' (neues Spiel, Neustart geprüft)'}`);
    } catch (e) { failed++; console.log(`✗ ${g.name}: ${e.message.split('\n')[0]}`); }
    await ctx.close();
  }
  await browser.close(); srv.close();
  fs.rmSync(SITE, { recursive: true, force: true });
  if (failed) { console.log(`\n${failed} Spiel(e) verlieren Daten. Nicht veröffentlichen!`); process.exit(1); }
  console.log('\nAlle Spielstände bleiben erhalten.');
})();
