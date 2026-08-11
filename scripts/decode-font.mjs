#!/usr/bin/env node
// 诊断/解码：还原 BOSS 直聘字体反爬的薪资文本
// 原理：在页面内用 Canvas 渲染加密字符，与候选字形（0-99、K、薪、万等）做像素匹配
const PORT = 9222;
const CDP = `http://127.0.0.1:${PORT}`;

async function main() {
  const tabs = await (await fetch(`${CDP}/json/list`)).json();
  const tab = tabs.find(
    (t) => t.type === "page" && t.url && t.url.includes("zhipin.com")
  );
  if (!tab) {
    console.log("NO_ZHIPIN_TAB");
    process.exit(0);
  }
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("timeout " + method));
        }
      }, 40000);
    });
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  const expr = `(async () => {
    const els = Array.from(document.querySelectorAll(".job-salary"));
    if (!els.length) return JSON.stringify({ error: "no salary els" });
    const fontList = getComputedStyle(els[0]).fontFamily;
    const fontsInfo = Array.from(document.fonts).map((f) => ({
      family: f.family,
      status: f.status,
      weight: f.weight,
    }));
    await document.fonts.ready;
    const loaded = [];
    for (const fam of ["kanzhun-mix", "kanzhun-Regular"]) {
      try {
        const ff = await document.fonts.load('20px "' + fam + '"');
        loaded.push(fam + ":" + ff.length);
      } catch (e) {
        loaded.push(fam + ":err");
      }
    }

    const W = 24, H = 24, FS = 20;
    function render(str, fam) {
      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      const ctx = c.getContext("2d");
      ctx.font = FS + 'px "' + fam + '"';
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#000";
      ctx.fillText(str, 0, H / 2);
      const d = ctx.getImageData(0, 0, W, H).data;
      const g = new Uint8Array(W * H);
      let ink = 0;
      for (let i = 0; i < W * H; i++) {
        g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
        if (g[i] < 128) ink++;
      }
      return { g, ink };
    }
    function sim(a, b) {
      let s = 0;
      for (let i = 0; i < a.g.length; i++) {
        const d = a.g[i] - b.g[i];
        s += d * d;
      }
      return s;
    }

    const candidates = [];
    for (let i = 0; i < 10; i++) candidates.push(String(i));
    ["K", "k", "薪", "万", "·", "-", "年"].forEach((s) => candidates.push(s));
    for (let i = 10; i < 100; i++) candidates.push(String(i));
    const cache = new Map();
    const candBitmap = (s) => {
      if (!cache.has(s)) cache.set(s, render(s, "kanzhun-mix"));
      return cache.get(s);
    };

    const allText = els.map((e) => e.innerText).join("");
    const chars = Array.from(new Set(allText.split("")));
    const map = {};
    for (const ch of chars) {
      const b = render(ch, "kanzhun-mix");
      let best = null, bestScore = Infinity;
      for (const s of candidates) {
        const score = sim(b, candBitmap(s));
        if (score < bestScore) { bestScore = score; best = s; }
      }
      map[ch] = { glyph: best, score: Math.round(bestScore), ink: b.ink };
    }
    const decoded = els.map((e) =>
      Array.from(e.innerText).map((ch) => (map[ch] ? map[ch].glyph : ch)).join("")
    );
    const ink5 = render("5", "kanzhun-mix").ink;
    const ink8 = render("8", "kanzhun-Regular").ink;
    return JSON.stringify({
      fontList,
      fontsInfo,
      loaded,
      ink5,
      ink8,
      map,
      decoded,
      sample: els[0].innerText,
    });
  })()`;

  const r = await call("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(
    r.result && r.result.result && r.result.result.value
      ? r.result.result.value
      : JSON.stringify(r).slice(0, 2000)
  );
  ws.close();
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error("ERR " + e.message);
  process.exit(1);
});
