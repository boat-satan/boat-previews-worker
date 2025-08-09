// index.js  — Cloudflare Workers (Modules)

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // ── 余計なクエリを排除（debug=1 だけは許可）────────────
    const dbg = url.searchParams.get("debug");
    const onlyDebug1 = (dbg === "1");
    if (url.search && !onlyDebug1) {
      url.search = "";                           // クエリ全部消す
      return Response.redirect(url.toString(), 302);
    }

    // /previews/v1/{date}/{pid}/{race}  (date=today|YYYYMMDD, pid=01..24, race=1R..12R)
    const m = url.pathname.match(/^\/previews\/v1\/(today|\d{8})\/(\d{2})\/((?:[1-9]|1[0-2])R)$/);
    if (!m) return json({ error: "bad path" }, 400);

    let [, dateRaw, pid, race] = m;
    const date = dateRaw === "today" ? jstYYYYMMDD() : dateRaw;
    const rno  = race.replace("R", "");
    const src  = officialBeforeUrl(date, pid, rno);

    // 公式へアクセス（礼儀スリープ任意）
    const sleepMs = Number(env.COURTESY_SLEEP_MS || 0);
    if (sleepMs > 0) await new Promise(r => setTimeout(r, sleepMs));

    const res  = await fetch(src, {
      headers: { "User-Agent": "boat-previews/1.0 (+contact: you@example.com)" }
    });
    const html = await res.text();

    if (dbg === "1") {
      // デバッグ：生HTMLの冒頭だけ返す
      return json({
        fetchStatus: res.status,
        source: src,
        html: html.slice(0, 2000) // 先頭だけ
      });
    }

    if (!res.ok) {
      return json({
        schemaVersion: "1.0",
        generatedAt: new Date().toISOString(),
        date, pid, race,
        deadline: null,
        entries: [],
        notReady: true,
        status: res.status,
        source: src
      });
    }

    // 直前情報パース
    const preview = parseExhibition(html);

    // 既存の出走表APIから締切を添える（失敗は無視）
    const deadline = await fetch(`https://boat-satan.github.io/racecard-crawl-api/programs-slim/v2/${date}/${pid}/${race}.json`)
      .then(r => r.ok ? r.json() : null)
      .then(j => j?.deadline ?? null)
      .catch(() => null);

    return json({
      schemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      date, pid, race,
      deadline,
      source: src,
      ...preview
    });
  }
};

// ───────────────── helpers ─────────────────

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*" // 必要ならCORS
    }
  });

const jstYYYYMMDD = () => {
  const t = new Date(Date.now() + 9 * 3600 * 1000);
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${t.getUTCFullYear()}${mm}${dd}`;
};

// 公式「直前情報」ページ（PC）
function officialBeforeUrl(date, pid, rno) {
  const r2 = String(rno).padStart(2, "0");
  return `https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=${date}&jcd=${pid}&rno=${r2}`;
}

// 直前情報のテーブルをざっくり抽出
function parseExhibition(html) {
  // 「直前情報」テーブルの tbody は class="is-fs12" が複数並ぶ構造（枠ごと）
  const bodyBlocks = [...html.matchAll(/<tbody[^>]*class="[^"]*is-fs12[^"]*"[^>]*>([\s\S]*?)<\/tbody>/gi)];
  const entries = bodyBlocks.map(tb => {
    const block = tb[1];

    // 枠番（最初の <td> に 1..6 が入る）
    const lane = pickInt(block.match(/<td[^>]*class="[^"]*is-boatColor\d[^"]*"[^>]*>\s*(\d+)/i)?.[1]);

    // 選手名（racersearch/profile のリンクテキスト）
    const name = text(block.match(/<a[^>]*href="\/owpc\/pc\/data\/racersearch\/profile\?[^"]*"[^>]*>([\s\S]*?)<\/a>/i)?.[1]);

    // 体重（「xx.xkg」）
    const weight = pickFloat(block.match(/>\s*([\d.]+)\s*kg\s*</i)?.[1]);

    // 調整重量（「±0.5」など。なければ null）
    const adjWeight = pickSignedFloat(block.match(/>\s*([+\-]?\d+(?:\.\d+)?)\s*</i)?.[1]);

    // 展示タイム（テーブル内に「タイム」列。xx.xx 想定）
    const exTime = pickFloat(block.match(/>\s*(\d{1,2}\.\d{2})\s*</)?.[1]);

    // 展示ST（「ST」行の直後セルが「0.1」等になっているケース）
    const exST = pickFloat(block.match(/>ST<\/td>\s*<td[^>]*>\s*([+\-]?\d+(?:\.\d+)?)\s*</i)?.[1]);

    // 部品交換（「labelGroup」内のラベル群）
    const parts = collectParts(block);

    return { lane, name, weight, adjWeight, exTime, exST, parts };
  }).filter(r => r.lane != null || r.name); // 何かしら取れている行だけ

  return { entries };
}

const text = (s) => s ? stripTags(s).replace(/\s+/g, " ").trim() : null;
const stripTags = (s) => s.replace(/<[^>]+>/g, "");
const pickInt = (v) => {
  const n = parseInt(v, 10); return Number.isFinite(n) ? n : null;
};
const pickFloat = (v) => {
  const n = parseFloat(v); return Number.isFinite(n) ? n : null;
};
const pickSignedFloat = (v) => {
  if (v == null) return null;
  const n = parseFloat(v.replace(/[^\d.+-]/g, "")); return Number.isFinite(n) ? n : null;
};
function collectParts(block) {
  const grp = block.match(/<ul[^>]*class="[^"]*labelGroup[^"]*"[^>]*>([\s\S]*?)<\/ul>/i)?.[1];
  if (!grp) return null;
  const items = [...grp.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(m => text(m[1])).filter(Boolean);
  return items.length ? items : null;
}
