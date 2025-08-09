// index.js (Cloudflare Workers) — stable "today" resolver + tolerant parser

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // /previews/v1/{date}/{pid}/{race}
    //   date: today | YYYYMMDD
    //   pid : 01..24
    //   race: 1R..12R
    const m = url.pathname.match(
      /^\/previews\/v1\/(today|\d{8})\/(\d{2})\/((?:[1-9]|1[0-2])R)$/
    );
    if (!m) return j({ error: "bad path" }, 400);

    let [, dateRaw, pid, race] = m;

    // ★ 安定化：today は必ず JST の 8桁に解決
    const date = dateRaw.toLowerCase() === "today" ? jstYYYYMMDD() : dateRaw;

    const rno = race.replace("R", "");
    const src = officialBeforeInfoUrl(date, pid, rno);

    // 礼儀スリープ（必要なら）
    const sleepMs = Number(env.COURTESY_SLEEP_MS || 0);
    if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));

    // 公式へアクセス（UA 明示、念のため no-cache）
    const res = await fetch(src, {
      headers: {
        "User-Agent": "boat-previews/1.0 (+contact:you@example.com)",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });

    if (!res.ok) {
      return j({
        schemaVersion: "1.0",
        generatedAt: new Date().toISOString(),
        date,
        pid,
        race,
        deadline: null,
        source: src,
        status: res.status,
        notReady: true,
        entries: [],
      });
    }

    const html = await res.text();
    const preview = parseExhibition(html);

    // 既存の出走表API（君のPages）から締切を添える（失敗しても無視）
    const dl = await fetch(
      `https://boat-satan.github.io/racecard-crawl-api/programs-slim/v2/${date}/${pid}/${race}.json`,
      { headers: { "Cache-Control": "no-cache" } }
    )
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

    return j({
      schemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      date,
      pid,
      race,
      deadline: dl?.deadline ?? null,
      source: src,
      entries: preview.entries,
    });
  },
};

// ---------- helpers ----------

const j = (o, s = 200) =>
  new Response(JSON.stringify(o, null, 2), {
    status: s,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const jstYYYYMMDD = () => {
  const t = new Date(Date.now() + 9 * 3600 * 1000);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, "0");
  const d = String(t.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
};

// 直前情報ページ（公式）
function officialBeforeInfoUrl(date, pid, rno) {
  const r2 = String(rno).padStart(2, "0");
  return `https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=${date}&jcd=${pid}&rno=${r2}`;
}

// ------- tolerant parser (進入コース & 展示ST を優先) -------
// HTMLはたまに構造差があるので、枠ごとのブロックを緩めに抽出して
// その中から「進入」「ST」セルを探す。
function parseExhibition(html) {
  const entries = [];

  // tbody単位で分割（選手ごとに「rowspan=4」などの塊が並ぶことが多い）
  const tbodies = [...html.matchAll(/<tbody[^>]*>([\s\S]*?)<\/tbody>/gi)].map(
    (m) => m[1]
  );

  // 各 tbody 内で「枠」「進入」「ST」らしきセルを探す
  for (const body of tbodies) {
    // 枠(1..6) を示すセル（例：<td class="is-fs14" rowspan="4">1</td> 等）
    const laneMatch =
      body.match(
        /<td[^>]*rowspan="4"[^>]*>(\s*([1-6])\s*)<\/td>/i
      ) || body.match(/<th[^>]*>\s*枠\s*<\/th>[\s\S]*?<td[^>]*>([1-6])<\/td>/i);

    const lane =
      (laneMatch && (laneMatch[2] || laneMatch[3])) ?
        parseInt(laneMatch[2] || laneMatch[3], 10) :
        null;

    // 進入（例：<td>進入</td> ... <td>コース数字</td>）
    let course = null;
    const courseBlock =
      body.match(/>進入<[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i) ||
      body.match(/>進入<[\s\S]*?<t[hd][^>]*>(\d)/i);
    if (courseBlock) {
      const c = strip(courseBlock[1]).replace(/[^\d]/g, "");
      if (c) course = parseInt(c, 10);
    }

    // ST（例：<td>ST</td> ... <td>0.12</td>）
    let exST = null;
    const stBlock =
      body.match(/>ST<[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i) ||
      body.match(/>ST<[\s\S]*?<t[hd][^>]*>([\d.−\-]+)</i);
    if (stBlock) {
      const s = strip(stBlock[1]).replace(/[^\d.\-]/g, "");
      if (s) exST = s;
    }

    if (lane) {
      entries.push({
        lane,
        course, // 進入コース（1..6）or null
        exST,   // 展示ST（"0.12" など）or null
      });
    }
  }

  // 1〜6 だけ残す & ソート
  const uniq = new Map();
  for (const e of entries) {
    if (e.lane >= 1 && e.lane <= 6 && !uniq.has(e.lane)) {
      uniq.set(e.lane, e);
    }
  }
  return { entries: [...uniq.values()].sort((a, b) => a.lane - b.lane) };
}

function strip(s) {
  return String(s).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
