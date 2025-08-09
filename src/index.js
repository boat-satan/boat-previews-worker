// Cloudflare Worker: previews API (PC版 beforeinfo をスクレイプ)
//   GET /previews/v1/{date}/{pid}/{race}
//   - date: "today" or YYYYMMDD
//   - pid : 01..24
//   - race: 1R..12R
//
// 返却: { schemaVersion, generatedAt, date, pid, race, deadline, source, entries:[{lane,course,exST}] }
//
// メモ:
//  - PC版固定: https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=YYYYMMDD&jcd=PID&rno=RNO
//  - UA をデスクトップっぽく、言語ヘッダも付ける
//  - ?debug=1 を付けると HTML の先頭を返して確認できる

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // ルーティング
    const m = url.pathname.match(/^\/previews\/v1\/(today|\d{8})\/(\d{2})\/((?:[1-9]|1[0-2])R)$/);
    if (!m) return j({ error: "bad path" }, 400);

    let [, dateRaw, pid, race] = m;
    const date = dateRaw === "today" ? jstYYYYMMDD() : dateRaw;
    const rno = race.replace(/R$/i, "");
    const src = pcBeforeInfoUrl(date, pid, rno);

    // optional courtesy sleep
    const sleepMs = Number(env.COURTESY_SLEEP_MS || 0);
    if (sleepMs > 0) await new Promise(r => setTimeout(r, sleepMs));

    // fetch (PC想定のUA & 言語)
    const res = await fetch(src, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        "Accept-Language": "ja,en;q=0.8",
        "Cache-Control": "no-cache"
      }
    });

    const html = await res.text();

    // デバッグモード: ?debug=1 でHTML冒頭を返す
    if (url.searchParams.get("debug") === "1") {
      return j({
        fetchStatus: res.status,
        source: src,
        htmlHead: html.slice(0, 4000) // 頭 4KB だけ
      });
    }

    // 取れなかった時
    if (!res.ok || !html) {
      return j({
        schemaVersion: "1.0",
        generatedAt: new Date().toISOString(),
        date, pid, race,
        deadline: null,
        source: src,
        entries: [],
        status: res.status,
        notReady: true
      });
    }

    // パース
    const entries = parsePCBeforeInfo(html);
    // 締切は PC 直前ページにもあるが、君の pages の JSON から補完（なければ null）
    const dl = await fetch(`https://boat-satan.github.io/racecard-crawl-api/programs-slim/v2/${date}/${pid}/${race}.json`)
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null);

    return j({
      schemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      date, pid, race,
      deadline: dl?.deadline ?? null,
      source: src,
      entries
    });
  }
};

// ---------- helpers ----------

const j = (o, s = 200) =>
  new Response(JSON.stringify(o, null, 2), {
    status: s,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });

const jstYYYYMMDD = () => {
  const t = new Date(Date.now() + 9 * 3600 * 1000);
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${t.getUTCFullYear()}${mm}${dd}`;
};

const pcBeforeInfoUrl = (date, pid, rno) =>
  `https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=${date}&jcd=${pid}&rno=${rno}`;

/**
 * PC版 beforeinfo の HTML から「進入コース」と「展示ST」を抜く
 * できるだけ堅牢に、複数パターンを試す
 * 返却: [{ lane:1..6, course: number|null, exST: string|null }]
 */
function parsePCBeforeInfo(html) {
  const rows = [
    { lane: 1, course: null, exST: null },
    { lane: 2, course: null, exST: null },
    { lane: 3, course: null, exST: null },
    { lane: 4, course: null, exST: null },
    { lane: 5, course: null, exST: null },
    { lane: 6, course: null, exST: null }
  ];

  const norm = (s) => (s ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

  // --- パターンA: 「スタート展示」ブロック（PC）
  // コースの数字と各STが並ぶテーブルから抽出
  // コース欄: <th>コース</th>、ST欄: <th>ST</th> を含むテーブルを狙う
  const startBlock = findTableByHeaders(html, ["コース", "並び", "ST"]) ||
                     findTableByHeaders(html, ["コース", "ST"]); // 保険

  if (startBlock) {
    // コース数字（1..6）を順に拾う
    const courseNums = [];
    const courseCellRe = />(?:\s*|&#x3000;)*([1-6])(?:\s*|&#x3000;)*</g;
    let cm;
    while ((cm = courseCellRe.exec(startBlock))) {
      courseNums.push(parseInt(cm[1], 10));
      if (courseNums.length === 6) break;
    }

    // ST値を順に拾う（.xx や 0.xx など）
    const stVals = [];
    // 「.xx」「0.xx」「F.xx」「L.xx」などに対応
    const stRe = />\s*([FL]?\s*\.?\d+(?:\.\d+)?)\s*</g;
    let sm;
    while ((sm = stRe.exec(startBlock))) {
      const val = norm(sm[1]).replace(/\s+/g, "");
      // 例: ".14" / "0.14" / "F.05" / "L.03"
      if (/^[FL]?\.?\d/.test(val)) stVals.push(val.startsWith(".") ? val : val);
      if (stVals.length === 6) break;
    }

    // 反映（並びが1..6で来ない場合も lane=1..6 の順に割当）
    for (let i = 0; i < 6; i++) {
      if (courseNums[i] != null) rows[i].course = courseNums[i];
      if (stVals[i] != null) rows[i].exST = stVals[i];
    }
  } else {
    // --- パターンB: 予備（万一テーブルが分割されている場合）
    // 「flame01」「st」などのクラスを横に並べるSP/PC混在っぽい構造にも対応
    const laneBlocks = [];
    const laneRe = /<div[^>]*class="[^"]*flame0([1-6])[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    let lm;
    while ((lm = laneRe.exec(html))) {
      laneBlocks[parseInt(lm[1], 10) - 1] = lm[2];
    }
    for (let i = 0; i < 6; i++) {
      const b = laneBlocks[i];
      if (!b) continue;
      // コース数字
      const csm = b.match(/id="csdisp"[^>]*>([^<]+)</i) || b.match(/class="flame"[^>]*>([^<]+)</i);
      if (csm) {
        const n = parseInt(norm(csm[1]), 10);
        if (Number.isFinite(n)) rows[i].course = n;
      }
      // ST
      const stm = b.match(/id="st"[^>]*>([^<]+)</i) || b.match(/class="st"[^>]*>([^<]+)</i);
      if (stm) {
        rows[i].exST = norm(stm[1]);
      }
    }
  }

  return rows;
}

/**
 * 指定の見出しテキスト群を <th> に含むテーブルHTML断片を返す
 */
function findTableByHeaders(html, headers = []) {
  // テーブル単位で走査
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = tableRe.exec(html))) {
    const t = m[0];
    let ok = true;
    for (const h of headers) {
      if (!new RegExp(`<t[hd][^>]*>\\s*${escapeReg(h)}\\s*<`, "i").test(t)) {
        ok = false;
        break;
      }
    }
    if (ok) return t;
  }
  return null;
}

function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
