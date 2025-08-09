// index.js — 展示情報スクレイパ（Workers）差し替え版
// 使い方: https://<your-worker>.workers.dev/previews/v1/{date}/{pid}/{race}[?debug=1]
// 例: https://boat-previews.example.workers.dev/previews/v1/20250809/02/1R

export default {
  async fetch(req, env) {
    try {
      const url = new URL(req.url);

      // ルーティング: /previews/v1/{date}/{pid}/{race}
      const m = url.pathname.match(/^\/previews\/v1\/(today|\d{8})\/(\d{2})\/((?:[1-9]|1[0-2])R)$/);
      if (!m) return j({ error: "bad path" }, 400);

      let [, dateRaw, pid, race] = m;
      const date = dateRaw === "today" ? jstYYYYMMDD() : dateRaw;
      const rno  = race.replace(/R$/i, "");
      const r2   = String(rno).padStart(2, "0");

      // 公式URL（まずはHTMLの beforeinfo を使う）
      const srcHtml = officialBeforeinfoHtml(date, pid, r2);

      // 礼儀スリープ（必要なら）
      const sleepMs = Number(env.COURTESY_SLEEP_MS || 0);
      if (sleepMs > 0) await new Promise(r => setTimeout(r, sleepMs));

      // 公式から取得（UAは明示）
      const res = await fetch(srcHtml, {
        headers: {
          "User-Agent": "boat-previews/1.0 (+contact:you@example.com)",
          "Accept": "text/html,application/xhtml+xml",
        },
      });

      // Pages 側の締切も添える（取れなければ null）
      const dl = await fetch(`https://boat-satan.github.io/racecard-crawl-api/programs-slim/v2/${date}/${pid}/${race}.json`)
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null);
      const deadline = dl?.deadline ?? null;

      // デバッグ: そのままHTMLを見たいとき
      const debug = url.searchParams.get("debug");
      const html  = await res.text();

      if (debug === "1") {
        // HTMLの先頭を返す（重くなるのでフルではなく冒頭だけ）
        const headCut = html.slice(0, 120000); // 120KB くらいまで
        return j({
          fetchStatus: res.status,
          source: srcHtml,
          html: headCut,
        });
      }

      if (!res.ok) {
        // 直前情報が未公開タイミング等
        return j({
          schemaVersion: "1.0",
          generatedAt: new Date().toISOString(),
          date, pid, race,
          deadline,
          source: srcHtml,
          entries: [],
          status: res.status,
          notReady: true,
        });
      }

      // HTMLパースして entries を作る
      const preview = parseExhibitionHtml(html);

      return j({
        schemaVersion: "1.0",
        generatedAt: new Date().toISOString(),
        date, pid, race,
        deadline,
        source: srcHtml,
        ...preview, // { entries }
      });
    } catch (err) {
      return j({ error: String(err) }, 500);
    }
  }
};

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
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}${String(t.getUTCDate()).padStart(2, "0")}`;
};

// 公式 直前情報（HTML）
// 例: https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=20250809&jcd=02&rno=01
const officialBeforeinfoHtml = (date, pid, r2) =>
  `https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=${date}&jcd=${pid}&rno=${r2}`;

// -------------------------------------------------------------
// HTMLパーサ（まずは確実に動く正規表現ベース）
// 直前情報ページのテーブル構造：tbody.is-fs12 が 1人あたり2つ並ぶ想定
//   上段: 枠/写真/選手名/体重/展示タイム/チルト/プロペラ/部品交換/…
//   下段: 進入/ST/着順
// -------------------------------------------------------------
function parseExhibitionHtml(html) {
  const entries = [];

  // 1人あたり上段・下段の tbody を拾う
  const tbodies = [...html.matchAll(/<tbody[^>]*class="[^"]*\bis-fs12\b[^"]*"[^>]*>([\s\S]*?)<\/tbody>/gi)].map(m => m[1]);

  for (let i = 0; i < tbodies.length; i += 2) {
    const upper = tbodies[i] || "";
    const lower = tbodies[i + 1] || "";

    // 枠番（class に boatColorX is-fs14、rowspan=4 のセル）
    const mLane = upper.match(/<td[^>]*class="[^"]*\bboatColor\d\b[^"]*\bis-fs14\b[^"]*"[^>]*rowspan="4"[^>]*>\s*([0-9]+)\s*<\/td>/i);
    const lane = mLane ? Number(mLane[1]) : null;

    // 選手名（プロフィールリンクの a テキスト）
    const mName = upper.match(/<a[^>]*href="\/owpc\/pc\/data\/raceresearch\/profile\?[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const name = mName ? strip(mName[1]) : null;

    // 体重（"xx.xkg"）
    const mWeight = upper.match(/>([0-9.]+)\s*kg<\//i);
    const weight = mWeight ? Number(mWeight[1]) : null;

    // 展示タイム（rowspan="4" の数値セルが最初に現れる想定：6.83 等）
    const mExTime = upper.match(/rowspan="4"[^>]*>\s*([0-9.]+)\s*<\/td>/i);
    const exTime = mExTime ? Number(mExTime[1]) : null;

    // チルト（「>チルト</td><td>…」）
    const mTilt = upper.match(/>チルト<\/td>\s*<td[^>]*>\s*([\-0-9.]+)\s*<\/td>/i);
    const tilt = mTilt ? Number(mTilt[1]) : null;

    // 部品交換（ul.labelGroup 内のテキストをまとめる）
    const mParts = upper.match(/<ul[^>]*class="[^"]*\blabelGroup\b[^"]*"[^>]*>([\s\S]*?)<\/ul>/i);
    const parts = mParts ? (strip(mParts[1]) || null) : null;

    // 下段: 進入/ST/着順
    const mCourse = lower.match(/>進入<\/td>\s*<td[^>]*>\s*([0-9])\s*<\/td>/i);
    const course = mCourse ? Number(mCourse[1]) : null;

    const mST = lower.match(/>ST<\/td>\s*<td[^>]*>\s*([\-0-9.]+)\s*<\/td>/i);
    const exST = mST ? Number(mST[1]) : null;

    // 着順（下段の最後、"着順" 見出しの次の行のセル）
    const mFinish = lower.match(/>着順<\/td>\s*<\/tr>[\s\S]*?<tr[^>]*>\s*<td[^>]*>\s*([^<]*)<\/td>/i);
    const finish = mFinish ? (strip(mFinish[1]) || null) : null;

    if (lane != null || name) {
      entries.push({
        lane, name,
        weight, exTime, tilt,
        parts,
        course, exST,
        finish,
      });
    }
  }

  return { entries };
}

const strip = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
