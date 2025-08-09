// index.js — previews API (course + exST)

export default {
  async fetch(req, env) {
    try {
      const url = new URL(req.url);

      // パス: /previews/v1/{date}/{pid}/{race}
      // {date}=today|YYYYMMDD, {pid}=01..24, {race}=1R..12R
      const m = url.pathname.match(/^\/previews\/v1\/(today|\d{8})\/(\d{2})\/((?:[1-9]|1[0-2])R)$/);
      if (!m) return j({ error: "bad path" }, 400);

      let [, dateRaw, pid, race] = m;
      const date = dateRaw === "today" ? jstYYYYMMDD() : dateRaw;
      const rno = race.replace(/R$/i, "");          // "1R" -> "1"

      // 公式ページ（SP直前情報）
      const src = officialDetailUrlSP(date, pid, rno);

      // 連続アクセス対策（任意）
      const sleepMs = Number(env.COURTESY_SLEEP_MS || 0);
      if (sleepMs > 0) await new Promise(r => setTimeout(r, sleepMs));

      // 公式取得（UAを明示）
      const res = await fetch(src, {
        headers: {
          "User-Agent": "boat-previews/1.0 (+contact:you@example.com)"
        }
      });

      if (!res.ok) {
        // まだ公開前など
        return j({
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

      const html = await res.text();

      // 進入コース + 展示ST を抽出
      const preview = parseExhibition(html);

      // 締切はあなたの公開JSONから拝借（あれば）
      const deadlineJson = await fetch(`https://boat-satan.github.io/racecard-crawl-api/programs-slim/v2/${date}/${pid}/${race}.json`)
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null);

      return j({
        schemaVersion: "1.0",
        generatedAt: new Date().toISOString(),
        date, pid, race,
        deadline: deadlineJson?.deadline ?? null,
        source: src,
        ...preview
      });

    } catch (err) {
      return j({ error: String(err) }, 500);
    }
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

// 公式SP直前情報ページ
function officialDetailUrlSP(date, pid, rno) {
  // SPは rno にゼロ埋め不要（1..12）
  return `https://www.boatrace.jp/owsp/sp/race/beforeinfo?hd=${date}&jcd=${pid}&rno=${Number(rno)}`;
}

// ===== 展示（スタート展示）のパース =====
// スクレイプ対象例：<table class="startTbl"> ... <div class="flame01"> <span class="flame">1</span> ... <span class="st">.28</span> </div>
function parseExhibition(html) {
  const entries = [];

  // スタート展示テーブル全体を抽出
  const mTable = html.match(/<table[^>]*class="[^"]*\bstartTbl\b[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
  if (!mTable) return { entries };

  const tbl = mTable[1];

  // 各枠のブロック（flame01..flame06）
  const flameRe = /<div[^>]*class="[^"]*\bflame0([1-6])\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let fm;
  while ((fm = flameRe.exec(tbl))) {
    const lane = parseInt(fm[1], 10);
    const block = fm[2];

    // 進入コース（<span class="flame">1</span> など）
    const mCourse = block.match(/<span[^>]*class="[^"]*\bflame\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const course = mCourse ? toInt(strip(mCourse[1])) : null;

    // 展示ST（<span class="st">.28</span> / "F.05" など）
    const mSt = block.match(/<span[^>]*class="[^"]*\bst\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    let exST = null;
    if (mSt) {
      const raw = strip(mSt[1]); // ".28" / "F.05"
      if (/^F/i.test(raw)) {
        exST = raw; // フライングは文字列のまま
      } else {
        const normalized = raw.startsWith(".") ? `0${raw}` : raw;
        const num = parseFloat(normalized);
        exST = Number.isFinite(num) ? num : raw || null;
      }
    }

    entries.push({ lane, course, exST });
  }

  // 念のため枠順でソート
  entries.sort((a, b) => a.lane - b.lane);

  return { entries };
}

const strip = (s) => String(s).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const toInt = (v) => {
  const n = parseInt(String(v).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
};
