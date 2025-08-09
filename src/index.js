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

    // 連続アクセス対策の礼儀スリープ（調整可）
    const sleepMs = Number(env.COURTESY_SLEEP_MS || 0);
    if (sleepMs > 0) await new Promise(r => setTimeout(r, sleepMs));

    // 公式へアクセス（UA明示）
    const res = await fetch(src, { headers: { "User-Agent": "boat-previews/1.0 (+contact:you@example.com)" } });
    if (!res.ok) {
      // 直前情報がまだ出てない/時間外は404や空があり得る
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
    const preview = parseExhibition(html, { date, pid, race });

    // 既存の出走表API（君のPages）から締切を添える
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

// ★実ページの直前タブURLに合わせて調整（例は placeholder）
function officialDetailUrl(date, pid, rno) {
  const r2 = String(rno).padStart(2, "0");
  // 例: racelist / beforeinfo など。ここは実ページを見て正しいパスに変えてね。
  return `https://www.boatrace.jp/owpc/pc/race/racelist?hd=${date}&jcd=${pid}&rno=${r2}`;
}

// ★最初はざっくりパース。実HTMLに合わせてセレクタ/正規表現を調整
function parseExhibition(html, meta) {
  const rows = [];
  // 例：class名に exhibition / before / tyokuzen 等が含まれる table を想定
  const mTable = html.match(/<table[^>]*class="[^"]*(exhibition|before|tyokuzen)[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
  if (mTable) {
    const tbody = mTable[2];
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let m;
    while ((m = trRe.exec(tbody))) {
      const cells = [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(x => strip(x[1]));
      if (cells.length >= 4) {
        rows.push({
          lane: toInt(cells[0]),        // 枠番
          name: cells[1] || null,       // 選手名
          exTime: cells[2] || null,     // 展示タイム
          exST: cells[3] || null,       // 展示ST
          parts: cells[4] || null       // 部品交換（列があれば）
        });
      }
    }
  }
  return { entries: rows };
}

const strip = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const toInt = (v) => {
  const n = parseInt(String(v).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
};
