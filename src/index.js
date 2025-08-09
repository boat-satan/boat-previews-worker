// index.js（差し替え版）
// 他の部分は今まで通り、parseExhibition 部分だけ変更しているのだ

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const date = url.pathname.split("/")[3];
    const pid = url.pathname.split("/")[4];
    const race = url.pathname.split("/")[5];

    const sourceUrl = `https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=${date}&jcd=${pid}&rno=${race}`;
    const res = await fetch(sourceUrl);
    const html = await res.text();

    const exhibition = parseExhibition(html);

    return new Response(JSON.stringify({
      schemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      date,
      pid,
      race,
      source: sourceUrl,
      entries: exhibition.entries
    }, null, 2), {
      headers: { "content-type": "application/json; charset=UTF-8" }
    });
  }
};

// 展示データ解析
function parseExhibition(html) {
  const strip = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const z2h = (s) => s.replace(/[０-９．－]/g, ch =>
    "0123456789.-"["０１２３４５６７８９．－".indexOf(ch)]
  );
  const fnum = (s) => {
    const v = parseFloat(z2h(String(s)).replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(v) ? v : null;
  };
  const afterLabel = (label, block) => {
    const re = new RegExp(`<td[^>]*>\\s*${label}\\s*<\\/td>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`, "i");
    const m = block.match(re);
    return m ? strip(m[1]) : null;
  };

  const entries = [];
  const boatRe = /(<td[^>]*class="[^"]*boatColor(\d)[^"]*"[^>]*rowspan="?\d+"?[^>]*>\s*\2\s*<\/td>)([\s\S]*?)(?=<td[^>]*class="[^"]*boatColor\d|<\/tbody>)/gi;
  let m;
  while ((m = boatRe.exec(html))) {
    const lane = parseInt(m[2], 10);
    const block = m[3];

    const row1 = block.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i);
    let weight = null, adjWeight = null, exTime = null;
    if (row1) {
      const tds = [...row1[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(x => strip(x[1]));
      if (tds.length >= 3) {
        weight = fnum(tds.find(s => /kg/i.test(s)) ?? tds[0]);
        adjWeight = fnum(tds.find(s => /[\+\-]/.test(z2h(s))) ?? tds[1]);
        exTime = fnum(tds.find(s => /^[０-９0-9.]+$/.test(strip(z2h(s)))) ?? tds[2]);
      }
    }

    const exSTraw = afterLabel("ST", block);
    const courseRaw = afterLabel("進入", block);
    const exST = fnum(exSTraw);
    const course = courseRaw ? z2h(courseRaw).replace(/[^\d\-]/g, "") : null;

    entries.push({
      lane,
      weight,
      adjWeight,
      exTime,
      exST,
      course: course || null
    });
  }

  return { entries };
}
