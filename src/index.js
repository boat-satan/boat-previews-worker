export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // /previews/v1/{date}/{pid}/{race}  (date=today|YYYYMMDD, pid=01..24, race=1R..12R)
    const m = url.pathname.match(/^\/previews\/v1\/(today|\d{8})\/(\d{2})\/((?:[1-9]|1[0-2])R)$/);
    if (!m) return j({ error: "bad path" }, 400);

    let [, dateRaw, pid, race] = m;
    const date = dateRaw === "today" ? jstYYYYMMDD() : dateRaw;
    const rno = race.replace("R", "");
    const src = officialDetailUrl(date, pid, rno);

    // 連続アクセス対策スリープ
    const sleepMs = Number(env.COURTESY_SLEEP_MS || 0);
    if (sleepMs > 0) await new Promise(r => setTimeout(r, sleepMs));

    // 公式へアクセス
    const res = await fetch(src, { headers: { "User-Agent": "boat-previews/1.0 (+contact:you@example.com)" } });
    if (!res.ok) {
      return j({
        schemaVersion: "1.0",
        generatedAt: new Date().toISOString(),
        date, pid, race,
        entries: [],
        status: res.status,
        notReady: true,
        source: src
      });
    }

    const html = await res.text();
    const preview = parseExhibition(html);

    // 既存APIから締切取得
    const dl = await fetch(`https://boat-satan.github.io/racecard-crawl-api/programs-slim/v2/${date}/${pid}/${race}.json`)
      .then(r => r.ok ? r.json() : null).catch(() => null);

    return j({
      schemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      date, pid, race,
      deadline: dl?.deadline ?? null,
      source: src,
      ...preview
    });
  }
};

const j = (o, s = 200) => new Response(JSON.stringify(o, null, 2), {
  status: s,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

const jstYYYYMMDD = () => {
  const t = new Date(Date.now() + 9 * 3600 * 1000);
  return `${t.getUTCFullYear()}${String(t.getUTCMonth()+1).padStart(2,"0")}${String(t.getUTCDate()).padStart(2,"0")}`;
};

// ★直前情報（beforeinfo）URLに変更
function officialDetailUrl(date, pid, rno) {
  const r2 = String(rno).padStart(2, "0");
  return `https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=${date}&jcd=${pid}&rno=${r2}`;
}

// ★展示テーブルパーサ
function parseExhibition(html) {
  // 「展示タイム」が入っているテーブルを探す
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let pick = null, m;
  while ((m = tableRe.exec(html))) {
    const tbl = m[0];
    const head = tbl.match(/<th[^>]*>[\s\S]*?<\/th>/gi)?.map(x => strip(x)) || [];
    if (head.some(h => /展示.?タイム/.test(h))) { pick = tbl; break; }
  }
  if (!pick) return { entries: [] };

  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let r;
  while ((r = trRe.exec(pick))) {
    const cells = [...r[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(x => strip(x[1]));
    if (cells.length < 3) continue;
    const lane = toInt(cells[0]);
    if (!lane || lane > 6) continue;
    const exTime = cells.find(c => /^\d\.\d{2}$/.test(c)) || null;                // 例: 6.79
    const exST   = cells.find(c => /^[+-]?\d\.\d{2}$|^0\.\d{2}$/.test(c)) || null; // 例: 0.12
    const name   = cells.slice(0, 4).find(c => /[一-龠ぁ-んァ-ヶ]/.test(c)) || null;
    const parts  = cells.find(c => /(部品|交換|ピストン|リング|シリンダ|キャブ)/.test(c)) || null;
    rows.push({ lane, name, exTime, exST, parts });
  }
  return { entries: rows };
}

const strip = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const toInt = (v) => {
  const n = parseInt(String(v).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
};
