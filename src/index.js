// index.js  ← Cloudflare Workers (modules)

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // /previews/v1/{date}/{pid}/{race}
    const m = url.pathname.match(/^\/previews\/v1\/(today|\d{8})\/(\d{2})\/((?:[1-9]|1[0-2])R)$/);
    if (!m) return json({ error: "bad path" }, 400);

    let [, dateRaw, pid, race] = m;
    const date = dateRaw === "today" ? jstYYYYMMDD() : dateRaw;
    const rno  = race.replace("R", "").padStart(2, "0");

    const ua = {
      "User-Agent":
        // デスクトップUAで統一（SP側の判定・遅配対策）
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept-Language": "ja,en;q=0.8"
    };

    const pcURL = `https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=${date}&jcd=${pid}&rno=${rno}`;
    const spURL = `https://www.boatrace.jp/owsp/sp/race/beforeinfo?hd=${date}&jcd=${pid}&rno=${rno}`;

    // 礼儀スリープ（必要なら）
    const sleepMs = Number(env.COURTESY_SLEEP_MS || 0);
    if (sleepMs > 0) await new Promise(r => setTimeout(r, sleepMs));

    // 1) PC版 → 2) SP版 の順に試す
    let html = null, sourceTried = [];
    // PC
    {
      const r = await fetch(pcURL, { headers: ua });
      sourceTried.push({ url: pcURL, status: r.status });
      if (r.ok) html = await r.text();
    }
    // SP（PCで拾えなかった／パース0件なら後で使う）
    let htmlSp = null, spStatus = null;
    if (!html) {
      const r2 = await fetch(spURL, { headers: ua });
      spStatus = r2.status;
      sourceTried.push({ url: spURL, status: r2.status });
      if (r2.ok) htmlSp = await r2.text();
    }

    // まずPC版のパース（公式PCはテーブル内に展示ST/進入が埋まっている）
    let entries = [];
    if (html) {
      entries = parsePC(html);
    }

    // PCで0件ならSP版から抜く（スマホの「スタート展示」ブロック）
    if ((!entries || entries.length === 0) && htmlSp) {
      entries = parseSP(htmlSp);
    }

    // 既存の出走表APIから締切だけ添える
    const deadline = await fetch(`https://boat-satan.github.io/racecard-crawl-api/programs-slim/v2/${date}/${pid}/${rno}R.json`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => j?.deadline ?? null)
      .catch(() => null);

    // データが出てない/読めない場合の扱い
    if (!entries || entries.length === 0) {
      // 公式側では公開済みでも、たまに空が返ることがあるため notReady を付与
      return json({
        schemaVersion: "1.0",
        generatedAt: new Date().toISOString(),
        date, pid, race: `${rno}R`,
        source: (html ? pcURL : spURL),
        entries: [],
        status: sourceTried.at(-1)?.status ?? 0,
        notReady: true
      });
    }

    return json({
      schemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      date, pid, race: `${rno}R`,
      deadline,
      source: (html ? pcURL : spURL),
      entries
    });
  }
};

const json = (o, s = 200) =>
  new Response(JSON.stringify(o, null, 2), {
    status: s,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });

const jstYYYYMMDD = () => {
  const t = new Date(Date.now() + 9 * 3600 * 1000);
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}${String(t.getUTCDate()).padStart(2, "0")}`;
};

// ---- パーサ群 ----

// PC版：テーブルに「スタート展示」や「展示ST」がそのまま入っているケースに対応
function parsePC(html) {
  const out = [];

  // 進入コースと展示STの候補をざっくり拾う
  // 例: <td class="st">.16</td> など（PCは表構造が場によって微差あり）
  // ここでは「コース順=1..6 で順番に ST が並んでいる」最小解を想定
  const stMatches = [...html.matchAll(/>([.\-]?\d\.\d{2})<\/(?:td|span)>/g)].map(m => m[1]);
  // 進入の並びは 1..6 か、もしくは「コース」列に 1..6 が並ぶ
  // 見つからない場合は 1..6 をデフォルトにする
  let courses = [...html.matchAll(/>([1-6])<\/(?:td|span)>/g)].map(m => m[1]).slice(0, 6);
  if (courses.length !== 6) courses = ["1", "2", "3", "4", "5", "6"];

  // ST候補から先頭6つを採る（.xx フォーマット想定）
  const sts = stMatches.filter(v => /^\-?\.\d{2}$/.test(v)).slice(0, 6);

  for (let i = 0; i < 6; i++) {
    out.push({
      lane: i + 1,
      course: toInt(courses[i]),
      exST: sts[i] ?? null
    });
  }
  return normalize(out);
}

// SP版：「スタート展示」ブロックを直接抜く
function parseSP(html) {
  const out = [];
  // <div class="flame0N"><span class="flame">N</span> ... <span class="st">.28</span></div>
  const re = /<div class="flame0([1-6])"[^>]*>[\s\S]*?<span[^>]*class="flame"[^>]*>([1-6])<\/span>[\s\S]*?<span[^>]*class="st"[^>]*>([\.\-]?\d{2})<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    const lane = toInt(m[1]);
    const course = toInt(m[2]);
    // ".28" など → そのまま文字列で返す
    const exST = /^\-?\.\d{2}$/.test(m[3]) ? m[3] : (m[3].startsWith(".") ? m[3] : "." + m[3]);
    out.push({ lane, course, exST });
  }

  // 6艇揃っていなければ穴埋め
  if (out.length < 6) {
    const byLane = Object.fromEntries(out.map(x => [x.lane, x]));
    for (let i = 1; i <= 6; i++) {
      if (!byLane[i]) byLane[i] = { lane: i, course: null, exST: null };
    }
    return normalize(Object.values(byLane).sort((a, b) => a.lane - b.lane));
  }
  return normalize(out.sort((a, b) => a.lane - b.lane));
}

function normalize(arr) {
  // 数・型の整形だけ担保
  return arr.map(x => ({
    lane: toInt(x.lane),
    course: toInt(x.course),
    exST: x.exST ?? null
  }));
}

const toInt = (v) => {
  const n = parseInt(String(v).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
};
