import fetch from "node-fetch";

async function fetchRaceData(date, pid, rno) {
  // PC版・スマホ版両方のURLを試す
  const urls = [
    `https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=${date}&jcd=${pid}&rno=${rno}`,
    `https://www.boatrace.jp/owsp/sp/race/beforeinfo?hd=${date}&jcd=${pid}&rno=${rno}`
  ];

  let html = null;
  let sourceUrl = null;

  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        html = await res.text();
        sourceUrl = url;
        break;
      }
    } catch (err) {
      console.error(`Fetch failed for ${url}:`, err);
    }
  }

  if (!html) {
    return { error: "Failed to fetch race HTML" };
  }

  const entries = parseExhibition(html);

  return {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    date,
    pid,
    race: `${String(rno).padStart(2, "0")}R`,
    source: sourceUrl,
    entries
  };
}

function parseExhibition(html) {
  const out = [];

  // スタート展示テーブル抽出（スマホ版・PC版）
  const mStart = html.match(/<table[^>]*class="[^"]*\bstartTbl\b[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
  if (!mStart) return out;

  const block = mStart[1];

  for (let lane = 1; lane <= 6; lane++) {
    const re = new RegExp(
      `<div[^>]*class="[^"]*flame0${lane}[^"]*"[^>]*>[\\s\\S]*?` +
      `<span[^>]*class="[^"]*flame[^"]*"[^>]*>([\\s\\S]*?)<\\/span>[\\s\\S]*?` + // コース番号
      `<span[^>]*class="[^"]*st[^"]*"[^>]*>([\\s\\S]*?)<\\/span>`,
      "i"
    );
    const mm = block.match(re);
    if (mm) {
      const courseText = strip(mm[1]);
      let stText = strip(mm[2]);
      if (/^\.\d+/.test(stText)) stText = "0" + stText;
      out.push({
        lane,
        course: toInt(courseText),
        exST: stText || null
      });
    } else {
      out.push({ lane, course: null, exST: null });
    }
  }
  return out;
}

function strip(s) {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function toInt(v) {
  const n = parseInt(String(v).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

// 実行例（Cloudflare Workerでの fetch イベント）
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const date = url.searchParams.get("date") || "20250809";
    const pid = url.searchParams.get("pid") || "02";
    const rno = url.searchParams.get("rno") || "1";

    const data = await fetchRaceData(date, pid, rno);
    return new Response(JSON.stringify(data, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }
};
