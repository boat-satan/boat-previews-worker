export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/previews\/v1\/(today|\d{8})\/(\d{2})\/((?:[1-9]|1[0-2])R)$/);
    if (!m) return json({ error: "bad path" }, 400);

    const [, dateRaw, pid, race] = m;
    const date = dateRaw === "today" ? jstYYYYMMDD() : dateRaw;
    const rno  = race.replace("R", "");
    const ua   = env.FORCE_UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

    // polite sleep
    const sleepMs = Number(env.COURTESY_SLEEP_MS || 0);
    if (sleepMs > 0) await new Promise(r => setTimeout(r, sleepMs));

    // ---- 直前情報（beforeinfo）
    const srcBefore = officialUrl("beforeinfo", date, pid, rno);
    const h = {
      "User-Agent": ua,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "ja,en;q=0.9",
      "Referer": "https://www.boatrace.jp/",
      "Cache-Control": "no-cache"
    };
    const resB = await fetch(srcBefore, { headers: h });
    const htmlB = await resB.text();

    if (url.searchParams.get("debug") === "1") {
      return json({
        fetchStatus: resB.status,
        source: srcBefore,
        htmlHead: htmlB.slice(0, 2000)
      });
    }

    let preview = { entries: [] };
    if (resB.ok) {
      preview = parseExhibition(htmlB);
    }

    // ---- フォールバック（表が無い / 公開前）
    if (!preview.entries?.length) {
      const srcList = officialUrl("racelist", date, pid, rno);
      const resL = await fetch(srcList, { headers: h });
      const htmlL = await resL.text();
      const base = resL.ok ? parseRacelist(htmlL) : { entries: [] };
      preview = { ...preview, ...base, notReady: true, fallback: "racelist" };
    }

    // 既存の締切を付与
    const dl = await fetch(`https://boat-satan.github.io/racecard-crawl-api/programs-slim/v2/${date}/${pid}/${race}.json`)
      .then(r => r.ok ? r.json() : null).catch(() => null);

    return json({
      schemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      date, pid, race,
      deadline: dl?.deadline ?? null,
      source: preview.fallback ? officialUrl("beforeinfo", date, pid, rno) : srcBefore,
      ...preview
    });
  }
};

// ---------- helpers ----------
const json = (o, s = 200) => new Response(JSON.stringify(o, null, 2), {
  status: s,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const jstYYYYMMDD = () => {
  const t = new Date(Date.now() + 9 * 3600 * 1000);
  return `${t.getUTCFullYear()}${String(t.getUTCMonth()+1).padStart(2,"0")}${String(t.getUTCDate()).padStart(2,"0")}`;
};
const pad2 = v => String(v).padStart(2, "0");
const strip = s => s.replace(/<script[\s\S]*?<\/script>/gi, "")
                    .replace(/<style[\s\S]*?<\/style>/gi, "")
                    .replace(/<[^>]+>/g, "")
                    .replace(/\s+/g, " ").trim();
const toInt = v => {
  const n = parseInt(String(v).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
};

function officialUrl(kind, date, pid, rno) {
  const r2 = pad2(rno);
  if (kind === "beforeinfo") {
    return `https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=${date}&jcd=${pid}&rno=${r2}`;
  }
  // racelist fallback
  return `https://www.boatrace.jp/owpc/pc/race/racelist?hd=${date}&jcd=${pid}&rno=${r2}`;
}

// 展示テーブル（beforeinfo）
function parseExhibition(html) {
  // 「展示タイム」を含むテーブルを探す
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let pick = null, m;
  while ((m = tableRe.exec(html))) {
    const tbl = m[0];
    const ths = tbl.match(/<th[^>]*>[\s\S]*?<\/th>/gi)?.map(x => strip(x)) || [];
    if (ths.some(t => /展示.?タイム/.test(t))) { pick = tbl; break; }
  }
  if (!pick) return { entries: [] };

  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let r;
  while ((r = trRe.exec(pick))) {
    const cells = [...r[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(x => strip(x[1]));
    if (cells.length < 2) continue;
    const lane = toInt(cells[0]);
    if (!lane || lane > 6) continue;

    const exTime = cells.find(c => /^\d\.\d{2}$/.test(c)) || null;                 // 6.79 など
    const exST   = cells.find(c => /^[+-]?\d\.\d{2}$|^0\.\d{2}$/.test(c)) || null;  // 0.12 など
    const name   = cells.slice(0, 5).find(c => /[一-龠ぁ-んァ-ヶ]/.test(c)) || null;
    const parts  = cells.find(c => /(部品|交換|ピストン|リング|シリンダ|キャブ)/.test(c)) || null;

    rows.push({ lane, name, exTime, exST, parts });
  }
  return { entries: rows };
}

// 出走表（racelist）から最低限（枠・選手名）だけ
function parseRacelist(html) {
  // 出走表の6行テーブル（枠番と選手名が並ぶやつ）を大まかに拾う
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const tbl of tables) {
    const body = tbl;
    const trs = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    if (trs.length < 6) continue;

    const entries = [];
    for (const t of trs) {
      const cells = [...t[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(x => strip(x[1]));
      const lane = toInt(cells[0]);
      if (!lane || lane > 6) continue;
      const name = cells.find(c => /[一-龠ぁ-んァ-ヶ]/.test(c)) || null;
      if (name) entries.push({ lane, name });
    }
    if (entries.length >= 3) return { entries }; // それっぽい
  }
  return { entries: [] };
}
