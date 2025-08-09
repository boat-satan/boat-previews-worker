// src/index.js
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/previews\/v1\/(today|\d{8})\/(\d{2})\/((?:[1-9]|1[0-2])R)$/);
    if (!m) return j({ error: "bad path" }, 400);

    const [, dateRaw, pid, race] = m;
    const date = dateRaw === "today" ? jstYYYYMMDD() : dateRaw;
    const rno  = race.replace("R", "");
    const ua   = env.FORCE_UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

    // お行儀スリープ（必要なら）
    const sleepMs = Number(env.COURTESY_SLEEP_MS || 0);
    if (sleepMs > 0) await new Promise(r => setTimeout(r, sleepMs));

    // ---- 直前情報（beforeinfo）
    const srcB = officialUrl("beforeinfo", date, pid, rno);
    const headers = {
      "User-Agent": ua,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "ja,en;q=0.9",
      "Referer": "https://www.boatrace.jp/",
      "Cache-Control": "no-cache"
    };
    const resB  = await fetch(srcB, { headers });
    const htmlB = await resB.text();

    // デバッグ：HTMLそのものを返す（先頭だけじゃなく全文）
    if (url.searchParams.get("debug") === "1") {
      return new Response(JSON.stringify({
        fetchStatus: resB.status,
        source: srcB,
        html: htmlB
      }, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
    }

    let preview = { entries: [] };
    if (resB.ok) {
      preview = parseExhibition(htmlB);
    }

    // ---- 展示テーブルが無い場合（公開前など）は出走表にフォールバック
    if (!preview.entries?.length) {
      const srcL  = officialUrl("racelist", date, pid, rno);
      const resL  = await fetch(srcL, { headers });
      const htmlL = await resL.text();
      const base  = resL.ok ? parseRacelist(htmlL) : { entries: [] };
      preview = { ...preview, ...base, notReady: true, fallback: "racelist" };
    }

    // 締切（君のPagesのJSON）を付与
    const dl = await fetch(`https://boat-satan.github.io/racecard-crawl-api/programs-slim/v2/${date}/${pid}/${race}.json`)
      .then(r => r.ok ? r.json() : null).catch(() => null);

    return j({
      schemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      date, pid, race,
      deadline: dl?.deadline ?? null,
      source: srcB,
      ...preview
    });
  }
};

// ---------- helpers ----------
const j = (o, s = 200) => new Response(JSON.stringify(o, null, 2), {
  status: s,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  }
});
const jstYYYYMMDD = () => {
  const t = new Date(Date.now() + 9 * 3600 * 1000);
  return `${t.getUTCFullYear()}${String(t.getUTCMonth()+1).padStart(2,"0")}${String(t.getUTCDate()).padStart(2,"0")}`;
};
const pad2  = v => String(v).padStart(2,"0");
const strip = s => s
  .replace(/<script[\s\S]*?<\/script>/gi, "")
  .replace(/<style[\s\S]*?<\/style>/gi, "")
  .replace(/<[^>]+>/g, "")
  .replace(/\s+/g, " ")
  .trim();
const toInt = v => {
  const n = parseInt(String(v).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
};

function officialUrl(kind, date, pid, rno) {
  const r2 = pad2(rno);
  if (kind === "beforeinfo") {
    // 直前情報
    return `https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=${date}&jcd=${pid}&rno=${r2}`;
  }
  // 出走表
  return `https://www.boatrace.jp/owpc/pc/race/racelist?hd=${date}&jcd=${pid}&rno=${r2}`;
}

/**
 * 展示テーブル抽出（クラス名に依存しない広めのロジック）
 * 1) ページ内の全tableを走査
 * 2) ヘッダに「展示」「直前」「タイム」「ST」などの語があるtableを採用
 * 3) 各行から 枠番/選手名/展示タイム/展示ST/部品交換 を推測抽出
 */
function parseExhibition(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  let pick = null;

  for (const tbl of tables) {
    const ths = tbl.match(/<th[^>]*>[\s\S]*?<\/th>/gi)?.map(x => strip(x)) || [];
    const headerStr = ths.join(" ");
    if (
      /展示|直前/.test(headerStr) &&  // “展示” or “直前” がどこかにある
      (/タイム|ST/.test(headerStr))   // “タイム” か “ST” もある
    ) {
      pick = tbl;
      break;
    }
  }
  if (!pick) return { entries: [] };

  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(pick))) {
    const cells = [...tr[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(x => strip(x[1]));
    if (cells.length < 2) continue;

    // 1列目か近辺に枠番（1..6）が入っていることが多い
    let lane = toInt(cells[0]);
    if (!lane || lane > 6) {
      // 先頭で取れなかったら全セルから最初の1..6を拾う
      for (const c of cells) { const n = toInt(c); if (n >= 1 && n <= 6) { lane = n; break; } }
    }
    if (!lane) continue;

    // 選手名（漢字/カナを含む最初のセル）
    const name = cells.find(c => /[一-龠ぁ-んァ-ヶ]/.test(c)) || null;

    // 展示タイム（6.79 など）
    const exTime = cells.find(c => /^\d\.\d{2}$/.test(c)) || null;

    // 展示ST（0.12, -0.01 など）
    const exST = cells.find(c => /^[+-]?\d\.\d{2}$/.test(c)) || null;

    // 部品交換（語を含むセル）
    const parts = cells.find(c => /(部品|交換|ピストン|リング|シリンダ|キャブ|ギヤ|シャフト)/.test(c)) || null;

    // 名前がない行はスキップ（見出し・合計などの行を避ける）
    if (!name) continue;

    rows.push({ lane, name, exTime, exST, parts });
  }

  // 行は枠順でソートしておく（保険）
  rows.sort((a, b) => (a.lane ?? 99) - (b.lane ?? 99));
  return { entries: rows };
}

/**
 * 出走表（racelist）から枠番・選手名の最小限だけ拾う
 */
function parseRacelist(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const tbl of tables) {
    const trs = [...tbl.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    if (trs.length < 3) continue;

    const entries = [];
    for (const t of trs) {
      const cells = [...t[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(x => strip(x[1]));
      const lane  = toInt(cells[0]);
      if (!lane || lane > 6) continue;
      const name  = cells.find(c => /[一-龠ぁ-んァ-ヶ]/.test(c)) || null;
      if (name) entries.push({ lane, name });
    }
    if (entries.length >= 3) return { entries };
  }
  return { entries: [] };
}
