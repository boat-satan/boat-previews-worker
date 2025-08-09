// index.js — ultra-light start-exhibition parser (course & exST only)

export default {
  async fetch(req, env) {
    try {
      const url = new URL(req.url);
      // /previews/v1/{date}/{pid}/{race}  (date=today|YYYYMMDD, pid=01..24, race=1R..12R)
      const m = url.pathname.match(/^\/previews\/v1\/(today|\d{8})\/(\d{2})\/((?:[1-9]|1[0-2])R)$/);
      if (!m) return j({ error: "bad path" }, 400);

      const [, dateRaw, pid, race] = m;
      const date = dateRaw === "today" ? jstYYYYMMDD() : dateRaw;
      const rno  = race.replace("R", "");
      const src  = spBeforeInfoUrl(date, pid, rno);

      // Optional: courtesy sleep to be kind to origin
      const sleepMs = Number(env.COURTESY_SLEEP_MS || 0);
      if (sleepMs > 0) await new Promise(r => setTimeout(r, sleepMs));

      // Fetch with 5s timeout
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), Number(env.FETCH_TIMEOUT_MS || 5000));
      const res = await fetch(src, {
        signal: controller.signal,
        headers: {
          "User-Agent": "boat-previews/1.0 (+contact:you@example.com)"
        }
      }).catch(err => ({ ok:false, statusText:String(err), text: async ()=>"" }));
      clearTimeout(t);

      const meta = { schemaVersion:"1.0", generatedAt:new Date().toISOString(), date, pid, race, source: src };

      if (!res || !res.ok) {
        return j({ ...meta, entries: [], status: res?.status || 0, notReady: true });
      }

      const html = await res.text();

      // --- fast-narrow to the start table block (keeps CPU/heap tiny) ---
      const startIdx = html.indexOf("startTbl");
      const block = startIdx >= 0 ? html.slice(startIdx, startIdx + 6000) : "";
      const entries = parseStartBlock(block);

      // also try to attach deadline from your Pages API (best-effort)
      let deadline = null;
      try {
        const dl = await fetch(`https://boat-satan.github.io/racecard-crawl-api/programs-slim/v2/${date}/${pid}/${race}.json`);
        if (dl.ok) {
          const js = await dl.json();
          deadline = js?.deadline ?? null;
        }
      } catch (_) {}

      // lightweight debug: only return first 1000 chars to avoid 1102
      if (url.searchParams.get("debug") === "1") {
        return j({ ...meta, debug: { sampleHtml: html.slice(startIdx > 0 ? startIdx : 0, (startIdx > 0 ? startIdx : 0) + 1000) }, entries, deadline });
      }

      return j({ ...meta, entries, deadline });
    } catch (e) {
      return j({ error: String(e) }, 500);
    }
  }
};

const j = (o, s = 200) => new Response(JSON.stringify(o, null, 2), {
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

// SP版 直前情報ページ
function spBeforeInfoUrl(date, pid, rno) {
  const rr = String(rno).padStart(2, "0");
  return `https://www.boatrace.jp/owsp/sp/race/beforeinfo?hd=${date}&jcd=${pid}&rno=${rr}`;
}

// ====== ultra-light parser for "スタート展示" ======
function parseStartBlock(block) {
  if (!block) return [];

  const out = [];
  // 各枠の塊: class="flame01" ... class="st">.28 など
  // できるだけ堅牢に：クォートは ' も " も許容
  const divRe = /class=['"]flame0([1-6])['"][\s\S]*?id=['"]csdisp['"][^>]*>(\d)[\s\S]*?class=['"]st['"][^>]*>([^<]+)/g;
  let m;
  while ((m = divRe.exec(block))) {
    const lane   = toInt(m[1]);     // 1..6（表示順）
    const course = toInt(m[2]);     // 1..6（進入コース）
    const stRaw  = (m[3] || "").trim();
    const exST   = stRaw.replace(/[^\d\.\-]/g, ""); // ".28" → ".28"
    out.push({ lane, course, exST });
    if (out.length === 6) break; // 6艇で十分
  }
  return out;
}

const toInt = (v) => {
  const n = parseInt(String(v).replace(/[^\d\-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
};
