import { app } from "../../scripts/app.js";

const MAX_OUTPUTS = 32;
const PAGE = 24; // 每批渲染的卡片数（一张卡片 5 个角度）

// 输出槽约定（与 nodes.py 保持一致）
//   槽 0      : images  整批选中图，按勾选顺序
//   槽 1..32  : img1..img32
const IMAGES_SLOT = 0;
const IMG_OFFSET = 1;

const BASE = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const CATALOG_URL = `${BASE}/catalog.json`;
const SMALL_URL = id => `${BASE}/small/${id}.jpg`;
const THUMB_URL = id => `${BASE}/thumbs/${id}.jpg`;

/* =========================================================================
 * 主题：跟随 ComfyUI 明暗切换
 * =======================================================================*/

const FALLBACK_THEME = {
  dark: {
    panel: "#14171c", sub: "#171b21", card: "#1b1f26", hover: "#252b34",
    border: "#2c323c", border2: "#39404a", text: "#e9ecf1", muted: "#98a1ae",
    accent: "#8fb4ff", accentText: "#111418", tileImg: "#f2f2f0",
    overlay: "rgba(4,6,10,.78)", shadow: "0 20px 60px rgba(0,0,0,.55)",
    track: "rgba(255,255,255,.06)",
  },
  light: {
    panel: "#ffffff", sub: "#f5f6f8", card: "#eef0f4", hover: "#e2e6ec",
    border: "#d5d9e0", border2: "#bfc5cf", text: "#1f2328", muted: "#5b6472",
    accent: "#3b82f6", accentText: "#ffffff", tileImg: "#ffffff",
    overlay: "rgba(20,26,36,.45)", shadow: "0 20px 60px rgba(15,22,35,.25)",
    track: "rgba(0,0,0,.05)",
  },
};

let themeCache = null;

function cssVar(name) {
  if (typeof getComputedStyle !== "function") return "";
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    try {
      const v = getComputedStyle(el).getPropertyValue(name);
      if (v && v.trim()) return v.trim();
    } catch (e) { /* ignore */ }
  }
  return "";
}

function parseColor(color) {
  if (!color) return null;
  const c = String(color).trim();
  let m = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(n => Number.isFinite(n))) return parts.slice(0, 3);
    return null;
  }
  m = /^#([0-9a-f]{3,8})$/i.exec(c);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split("").map(ch => ch + ch).join("");
    if (h.length >= 6) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
  }
  return null;
}

function luminance(color) {
  const rgb = parseColor(color);
  if (!rgb) return null;
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

function detectDark() {
  const cls = `${document.documentElement?.className || ""} ${document.body?.className || ""}`.toLowerCase();
  const hasDark = /(^|[\s"])(dark|dark-theme|p-dark)([\s"]|$)/.test(cls);
  const hasLight = /(^|[\s"])(light|light-theme)([\s"]|$)/.test(cls);
  if (hasDark) return true;
  if (hasLight) return false;

  const probe = cssVar("--bg-color") || cssVar("--comfy-menu-bg") ||
    (document.body ? getComputedStyle(document.body).backgroundColor : "");
  const lum = luminance(probe);
  if (lum != null) return lum < 0.5;

  try {
    return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? true;
  } catch (e) {
    return true;
  }
}

/** 读取 ComfyUI 自己的 CSS 变量，取不到就用明暗兜底色。 */
function buildPalette() {
  const dark = detectDark();
  const f = dark ? FALLBACK_THEME.dark : FALLBACK_THEME.light;
  const pick = (names, fb) => {
    for (const n of names) {
      const v = cssVar(n);
      if (v && parseColor(v)) return v;
    }
    return fb;
  };

  const accent = pick(["--p-primary-color", "--p-button-primary-background", "--comfy-primary"], f.accent);
  const accentLum = luminance(accent);
  return {
    dark,
    panel: pick(["--comfy-menu-bg", "--p-content-background", "--bg-color"], f.panel),
    sub: pick(["--comfy-menu-secondary-bg", "--p-content-background", "--comfy-menu-bg"], f.sub),
    card: pick(["--comfy-input-bg", "--p-inputtext-background", "--comfy-menu-secondary-bg"], f.card),
    border: pick(["--border-color", "--p-content-border-color"], f.border),
    border2: pick(["--border-color", "--p-inputtext-border-color"], f.border2),
    text: pick(["--fg-color", "--p-text-color", "--input-text"], f.text),
    muted: pick(["--descrip-text", "--p-text-muted-color"], f.muted),
    hover: f.hover,
    accent,
    accentText: accentLum == null ? f.accentText : (accentLum > 0.62 ? "#111418" : "#ffffff"),
    tileImg: f.tileImg,
    overlay: f.overlay,
    shadow: dark ? f.shadow : f.shadow,
    track: f.track,
  };
}

function palette() {
  if (!themeCache) themeCache = buildPalette();
  return themeCache;
}

function applyThemeVars(el) {
  const t = palette();
  const map = {
    "--posedb-panel": t.panel,
    "--posedb-sub": t.sub,
    "--posedb-card": t.card,
    "--posedb-hover": t.hover,
    "--posedb-border": t.border,
    "--posedb-border2": t.border2,
    "--posedb-text": t.text,
    "--posedb-muted": t.muted,
    "--posedb-accent": t.accent,
    "--posedb-accent-text": t.accentText,
    "--posedb-tile-img": t.tileImg,
    "--posedb-overlay": t.overlay,
    "--posedb-shadow": t.shadow,
    "--posedb-track": t.track,
  };
  for (const k in map) el.style.setProperty(k, map[k]);
}

let watchingTheme = false;
function watchTheme() {
  if (watchingTheme) return;
  watchingTheme = true;

  const onChange = () => {
    themeCache = null;
    const mask = document.getElementById("posedb-mask");
    if (mask) applyThemeVars(mask);
    app.graph?.setDirtyCanvas(true, true);
  };

  try {
    new MutationObserver(onChange).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    if (document.body) {
      new MutationObserver(onChange).observe(document.body, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme"],
      });
    }
  } catch (e) { /* ignore */ }

  try {
    window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", onChange);
  } catch (e) { /* ignore */ }
}

/* =========================================================================
 * 图库清单
 * =======================================================================*/

let catalogPromise = null;
function getCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch(CATALOG_URL, { cache: "force-cache" }).then(r => {
      if (!r.ok) throw new Error(`图库清单读取失败 HTTP ${r.status}`);
      return r.json();
    });
  }
  return catalogPromise;
}

/* =========================================================================
 * 节点：输出槽 + 缩略图条
 * =======================================================================*/

const storeOf = node => (node.widgets || []).find(w => w.name === "selected");
const buttonOf = node => (node.widgets || []).find(w => w.__posedb);

function readIds(node) {
  const w = storeOf(node);
  if (!w || w.value == null) return [];
  try {
    const v = typeof w.value === "string" ? JSON.parse(w.value || "[]") : w.value;
    return Array.isArray(v) ? v.filter(Boolean).map(String) : [];
  } catch {
    return [];
  }
}

function syncOutputs(node, count) {
  if (!node.outputs) return;

  const imgs = Math.max(1, Math.min(MAX_OUTPUTS, count | 0));
  const target = IMG_OFFSET + imgs;
  let cur = node.outputs.length;

  while (cur < target) {
    node.addOutput(cur === IMAGES_SLOT ? "images" : `img${cur}`, "IMAGE");
    cur++;
  }
  while (cur > target) {
    node.removeOutput(cur - 1);
    cur--;
  }

  // 名字对齐（兼容旧存档：旧版本槽 0 是 img1）
  node.outputs.forEach((o, i) => {
    const want = i === IMAGES_SLOT ? "images" : `img${i}`;
    if (o.name !== want) o.name = want;
  });

  const base = node.computeSize();
  node.setSize([Math.max(250, Math.min(470, base[0] + 30)), base[1] + (count ? 96 : 0)]);
}

function writeIds(node, ids) {
  const w = storeOf(node);
  if (w) w.value = JSON.stringify(ids);
  refresh(node);
}

function refresh(node) {
  const ids = readIds(node);
  const btn = buttonOf(node);
  if (btn) btn.name = ids.length ? `选择姿势图（已选 ${ids.length}）` : "选择姿势图…";
  syncOutputs(node, ids.length);
  node.setDirtyCanvas(true, true);
  app.graph?.setDirtyCanvas(true, true);
}

const thumbCache = new Map();
function canvasThumb(id) {
  let e = thumbCache.get(id);
  if (!e) {
    const img = new Image();
    e = { img, ok: false };
    img.onload = () => { e.ok = true; app.graph?.setDirtyCanvas(true, true); };
    img.onerror = () => { e.ok = false; };
    img.src = SMALL_URL(id);
    thumbCache.set(id, e);
  }
  return e;
}

function drawStrip(ctx, node) {
  const ids = readIds(node);
  if (!ids.length) return;

  const t = palette();
  const nodeW = Math.max(0, node.size[0]);
  const nodeH = Math.max(0, node.size[1]);
  const pad = 10;
  const h = Math.min(74, Math.max(0, nodeH - 16));
  if (nodeW < 90 || h < 24) return; // 节点太小就不画，避免画到节点外
  // 整条固定在节点内部：左右留 10px，底部留 8px
  const top = Math.max(0, nodeH - h - 8);
  const width = Math.max(0, nodeW - pad * 2);

  ctx.save();
  ctx.fillStyle = t.track;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(pad, top, width, h, 8);
  else ctx.rect(pad, top, width, h);
  ctx.fill();

  const gap = 6;
  const inner = width - 8; // 左右各留 4
  ctx.font = "600 13px system-ui, sans-serif";

  // 先按文字实际宽度算出可用空间，空间不够就少画几张缩略图，保证文字不越界
  let shown = Math.min(ids.length, 5);
  let label = "";
  let tileW = 0;
  for (;;) {
    if (shown === 0) { label = `共 ${ids.length} 张`; break; }
    label = ids.length > shown ? `+${ids.length - shown}` : `共 ${ids.length} 张`;
    const labelW = ctx.measureText(label).width;
    tileW = (inner - gap * (shown - 1) - labelW - 8) / shown;
    if (tileW >= 24) break;
    shown--;
  }
  tileW = Math.max(16, Math.min(52, tileW));

  const tileH = h - 12;
  const tileY = top + 6;

  // 整条裁剪在缩略图条内部，任何情况下都不会画到节点外面
  ctx.save();
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(pad, top, width, h, 8);
  else ctx.rect(pad, top, width, h);
  ctx.clip();

  for (let i = 0; i < shown; i++) {
    const x = pad + 4 + i * (tileW + gap);
    const entry = canvasThumb(ids[i]);
    ctx.fillStyle = t.dark ? "rgba(0,0,0,0.35)" : "rgba(0,0,0,0.08)";
    ctx.fillRect(x, tileY, tileW, tileH);
    if (entry.ok) ctx.drawImage(entry.img, x, tileY, tileW, tileH);
    ctx.strokeStyle = t.border2;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, tileY + 0.5, tileW - 1, tileH - 1);
  }

  ctx.fillStyle = t.text;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const textX = pad + 4 + shown * (tileW + gap);
  ctx.fillText(label, textX, tileY + tileH / 2);
  ctx.restore();
  ctx.restore();
}

/* =========================================================================
 * 选择面板
 * =======================================================================*/

const CSS = `
#posedb-mask{position:fixed;inset:0;z-index:10000;background:var(--posedb-overlay,rgba(4,6,10,.78));backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:24px;font:14px/1.6 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--posedb-text,#e9ecf1)}
#posedb-mask *{box-sizing:border-box}
.posedb-panel{width:min(920px,100%);height:min(86vh,900px);display:flex;flex-direction:column;background:var(--posedb-panel,#14171c);border:1px solid var(--posedb-border,#2c323c);border-radius:16px;box-shadow:var(--posedb-shadow,0 20px 60px rgba(0,0,0,.55));overflow:hidden;color:var(--posedb-text,#e9ecf1)}
.posedb-hd{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--posedb-border,#262b33)}
.posedb-hd h3{margin:0;font-size:17px;font-weight:700;color:var(--posedb-text,#e9ecf1)}
.posedb-hd .posedb-count{margin-left:auto;font-weight:700;color:var(--posedb-accent,#8fb4ff);white-space:nowrap}
.posedb-x{width:36px;height:36px;border-radius:50%;border:1px solid var(--posedb-border2,#3a414b);background:var(--posedb-card,#1b1f26);color:var(--posedb-text,#e9ecf1);font-size:18px;cursor:pointer}
.posedb-x:hover{background:var(--posedb-hover,#252b34)}
.posedb-ft{display:flex;align-items:center;gap:12px;padding:12px 18px;border-top:1px solid var(--posedb-border,#262b33);background:var(--posedb-sub,#171b21)}
.posedb-tools{display:flex;flex-wrap:wrap;gap:8px;padding:12px 18px;border-bottom:1px solid var(--posedb-border,#262b33);background:var(--posedb-sub,#171b21)}
.posedb-tools input,.posedb-tools select{height:38px;background:var(--posedb-card,#1b1f26);border:1px solid var(--posedb-border2,#39404a);border-radius:9px;color:var(--posedb-text,#e9ecf1);padding:0 10px;font-size:14px;outline:none}
.posedb-tools input::placeholder{color:var(--posedb-muted,#98a1ae)}
.posedb-tools select option{background:var(--posedb-panel,#14171c);color:var(--posedb-text,#e9ecf1)}
.posedb-tools input{flex:1 1 220px;min-width:160px}
.posedb-tools input:focus,.posedb-tools select:focus{border-color:var(--posedb-accent,#8fb4ff)}
/* 系列：4 个圆角按钮独占一行，横排铺满 */
.posedb-seriesbar{display:flex;gap:8px;flex:1 1 100%;width:100%}
.posedb-sbtn{flex:1 1 0;min-width:0;height:38px;padding:0 14px;border-radius:19px;border:1px solid var(--posedb-border2,#39404a);background:var(--posedb-card,#1b1f26);color:var(--posedb-text,#e9ecf1);font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;transition:background .12s,border-color .12s,color .12s}
.posedb-sbtn:hover{background:var(--posedb-hover,#252b34)}
.posedb-sbtn[aria-pressed="true"]{background:var(--posedb-accent,#8fb4ff);border-color:var(--posedb-accent,#8fb4ff);color:var(--posedb-accent-text,#111418)}
/* 分类下拉：自定义列表，右侧带已选数量徽标 */
.posedb-catwrap{position:relative;display:flex;flex:0 0 auto}
.posedb-catbtn{display:flex;align-items:center;gap:8px;height:38px;min-width:158px;padding:0 10px;background:var(--posedb-card,#1b1f26);border:1px solid var(--posedb-border2,#39404a);border-radius:9px;color:var(--posedb-text,#e9ecf1);font-size:14px;cursor:pointer}
.posedb-catbtn:hover{background:var(--posedb-hover,#252b34)}
.posedb-catbtn[aria-expanded="true"]{border-color:var(--posedb-accent,#8fb4ff)}
.posedb-catbtn .posedb-catlabel{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
.posedb-catbtn .posedb-caret{flex:0 0 auto;color:var(--posedb-muted,#98a1ae);font-size:10px;transition:transform .15s}
.posedb-catbtn[aria-expanded="true"] .posedb-caret{transform:rotate(180deg)}
.posedb-catmenu{position:absolute;top:calc(100% + 6px);left:0;z-index:30;min-width:260px;max-height:min(54vh,440px);overflow:auto;padding:6px;background:var(--posedb-panel,#14171c);border:1px solid var(--posedb-border,#2c323c);border-radius:12px;box-shadow:var(--posedb-shadow,0 20px 60px rgba(0,0,0,.55))}
.posedb-catmenu[hidden]{display:none}
.posedb-catitem{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:var(--posedb-text,#e9ecf1);font-size:14px;text-align:left;cursor:pointer}
.posedb-catitem:hover{background:var(--posedb-hover,#252b34)}
.posedb-catitem[aria-current="true"]{background:var(--posedb-hover,#252b34);font-weight:700}
.posedb-catitem .posedb-catnm{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.posedb-grid{flex:1;overflow:auto;padding:10px;display:grid;grid-template-columns:repeat(auto-fill,168px);justify-content:center;gap:10px;align-content:start;background:var(--posedb-panel,#14171c);scrollbar-gutter:stable}
/* 一个姿势 = 一张卡片：主图 → 标题 → 5 个角度小图 */
.posedb-card{display:flex;flex-direction:column;width:168px;padding:8px;gap:6px;border:1px solid var(--posedb-border,#2c323c);border-radius:11px;background:var(--posedb-card,#1b1f26)}
.posedb-card-hd{display:flex;flex-direction:column;gap:1px;min-width:0}
.posedb-card-hd b{font-size:12px;font-weight:700;color:var(--posedb-text,#e9ecf1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.posedb-card-hd i{font-style:normal;font-size:10px;color:var(--posedb-muted,#98a1ae);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.posedb-strip{display:grid;grid-template-columns:repeat(5,1fr);gap:4px}
.posedb-mini{position:relative;padding:0;aspect-ratio:3/4;border:2px solid transparent;border-radius:7px;background-color:var(--posedb-tile-img,#f2f2f0);background-size:cover;background-position:center;cursor:pointer;overflow:hidden}
.posedb-mini:hover{border-color:var(--posedb-border2,#4b5566)}
.posedb-mini[aria-pressed="true"]{border-color:var(--posedb-accent,#8fb4ff);box-shadow:0 0 0 2px var(--posedb-accent,#8fb4ff)}
.posedb-main{display:block;width:100%;aspect-ratio:3/4;object-fit:contain;border-radius:9px;background:var(--posedb-tile-img,#f2f2f0);cursor:pointer}
.posedb-badge{position:absolute;top:3px;left:3px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--posedb-accent,#8fb4ff);color:var(--posedb-accent-text,#111418);font-weight:700;font-size:11px;display:none;align-items:center;justify-content:center}
.posedb-mini[aria-pressed="true"] .posedb-badge{display:flex}
.posedb-btn{height:40px;padding:0 18px;border-radius:10px;border:1px solid var(--posedb-border2,#3a414b);background:var(--posedb-card,#1b1f26);color:var(--posedb-text,#e9ecf1);font-size:14px;font-weight:600;cursor:pointer}
.posedb-btn:hover{background:var(--posedb-hover,#252b34)}
.posedb-btn.primary{background:var(--posedb-accent,#8fb4ff);border-color:var(--posedb-accent,#8fb4ff);color:var(--posedb-accent-text,#111418)}
.posedb-btn.primary:hover{filter:brightness(1.06)}
.posedb-tip{color:var(--posedb-muted,#98a1ae);font-size:13px}
.posedb-empty{grid-column:1/-1;text-align:center;color:var(--posedb-muted,#98a1ae);padding:60px 0}
`;

function injectCSS() {
  if (document.getElementById("posedb-css")) return;
  const s = document.createElement("style");
  s.id = "posedb-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

async function openPicker(node) {
  if (document.getElementById("posedb-mask")) return;
  injectCSS();
  watchTheme();

  let catalog;
  try {
    catalog = await getCatalog();
  } catch (e) {
    alert(`读取内置图库清单失败：${e.message}\n请确认节点包里的 web/catalog.json 存在。`);
    return;
  }

  // 用 Set 维护“已选 id 的集合”，order 数组只负责勾选顺序。
  // 两者同步更新，切换分类时都不会被清空。
  const order = readIds(node).filter(id => catalog.items.some(it => it.id === id));
  const selected = new Set(order);

  const mask = document.createElement("div");
  mask.id = "posedb-mask";
  mask.innerHTML = `
    <div class="posedb-panel" role="dialog" aria-label="PoseDB 图库">
      <div class="posedb-hd">
        <h3>PoseDB 姿势图库</h3>
        <span class="posedb-count" id="posedb-num"></span>
        <button class="posedb-x" id="posedb-close" title="关闭">×</button>
      </div>
      <div class="posedb-tools">
        <div class="posedb-seriesbar" id="posedb-seriesbar"></div>
        <input id="posedb-q" type="search" placeholder="搜索：姿势名 / 编号 / id">
        <div class="posedb-catwrap">
          <button type="button" class="posedb-catbtn" id="posedb-cat-btn" aria-expanded="false" aria-haspopup="listbox">
            <span class="posedb-catlabel" id="posedb-cat-label">全部分类</span>
            <span class="posedb-caret">▼</span>
          </button>
          <div class="posedb-catmenu" id="posedb-cat-menu" role="listbox" hidden></div>
        </div>
      </div>
      <div class="posedb-grid" id="posedb-grid"></div>
      <div class="posedb-ft">
        <span class="posedb-tip" id="posedb-tip"></span>
        <span style="margin-left:auto"></span>
        <button class="posedb-btn" id="posedb-clear">清空</button>
        <button class="posedb-btn" id="posedb-cancel">取消</button>
        <button class="posedb-btn primary" id="posedb-ok">确定</button>
      </div>
    </div>`;
  applyThemeVars(mask);
  document.body.appendChild(mask);

  const $ = sel => mask.querySelector(sel);
  const grid = $("#posedb-grid");

  const cats = [...new Set(catalog.items.map(i => i.cat).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh"));
  const byId = new Map(catalog.items.map(it => [it.id, it]));

  // 一个姿势 = 一张卡片：同系列 + 同编号的 5 个角度归到一组，顺序沿用 catalog
  const poses = [];
  {
    const seen = new Map();
    for (const it of catalog.items) {
      const key = `${it.series}|${it.no}`;
      let p = seen.get(key);
      if (!p) {
        p = { key, series: it.series, no: it.no, name: it.name, cat: it.cat, items: [] };
        seen.set(key, p);
        poses.push(p);
      }
      p.items.push(it);
    }
  }

  // 上次用过的筛选条件（系列 / 分类）存在节点 properties 里，重开面板自动恢复
  const saved = (node.properties && node.properties.posedbFilter) || {};
  let curSeries = catalog.series.includes(saved.series) ? saved.series : "";

  // 系列：4 个圆角按钮横排，再点一次已选中的按钮 = 回到全部
  const seriesBar = $("#posedb-seriesbar");
  seriesBar.innerHTML = catalog.series.map(s =>
    `<button type="button" class="posedb-sbtn" data-series="${s}" aria-pressed="false">${s}</button>`).join("");
  function paintSeries() {
    for (const b of seriesBar.querySelectorAll(".posedb-sbtn")) {
      b.setAttribute("aria-pressed", b.dataset.series === curSeries ? "true" : "false");
    }
  }

  let curCat = cats.includes(saved.cat) ? saved.cat : "";
  const catBtn = $("#posedb-cat-btn");
  const catMenu = $("#posedb-cat-menu");
  const catLabel = $("#posedb-cat-label");

  catMenu.innerHTML = [""].concat(cats).map(c => `
    <button type="button" class="posedb-catitem" role="option" data-cat="${c}" aria-current="false">
      <span class="posedb-catnm">${c || "全部分类"}</span>
    </button>`).join("");

  function setCat(v, runFilter = true) {
    curCat = v || "";
    catLabel.textContent = curCat || "全部分类";
    catMenu.hidden = true;
    catBtn.setAttribute("aria-expanded", "false");
    if (runFilter) applyFilter();
  }

  function saveFilter() {
    node.properties = node.properties || {};
    node.properties.posedbFilter = {
      series: curSeries || "",
      cat: curCat || "",
    };
  }

  let filtered = [];          // 过滤后的姿势卡片
  let appended = 0;
  const activeOf = new Map(); // 卡片 key -> 主图正在显示的 id

  function updateCount() {
    $("#posedb-num").textContent = `已选 ${order.length} / ${MAX_OUTPUTS}`;
    $("#posedb-tip").textContent = order.length > MAX_OUTPUTS
      ? `超出上限 ${MAX_OUTPUTS} 张，只有前 ${MAX_OUTPUTS} 张会有输出`
      : `勾选顺序 = images 批内顺序 = img1、img2…`;
  }

  /** 一张卡片 = 一个姿势：标题 → 5 个角度小图（点一下勾选/取消）→ 主图 */
  function makeCard(p) {
    const el = document.createElement("div");
    el.className = "posedb-card";
    el.dataset.key = p.key;
    el.__pose = p;

    const hd = document.createElement("div");
    hd.className = "posedb-card-hd";
    hd.innerHTML = `<b title="${p.name}">${p.name}</b><i>${p.no}｜${p.cat}｜${p.series}</i>`;

    const strip = document.createElement("div");
    strip.className = "posedb-strip";
    for (const it of p.items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "posedb-mini";
      b.dataset.id = it.id;
      b.title = `${it.angle}｜${it.name}｜${it.no}`;
      b.style.backgroundImage = `url("${SMALL_URL(it.id)}")`;
      b.setAttribute("aria-pressed", "false");
      b.innerHTML = `<span class="posedb-badge"></span>`;
      strip.appendChild(b);
    }

    const main = document.createElement("img");
    main.className = "posedb-main";
    main.loading = "lazy";
    main.decoding = "async";
    main.alt = p.name;
    main.addEventListener("error", () => {
      if (main.dataset.fb) return;
      main.dataset.fb = "1";
      main.src = THUMB_URL(main.dataset.id);
    });

    // 卡片结构：主图 → 标题 → 5 个角度小图
    el.append(main, hd, strip);
    paintCard(el);
    return el;
  }

  /** 刷新一张卡片：主图 + 每个角度的勾选状态与序号 */
  function paintCard(el) {
    const p = el.__pose;
    const main = el.querySelector(".posedb-main");
    let act = activeOf.get(p.key);
    if (!act || !p.items.some(it => it.id === act)) act = p.items[0].id;
    activeOf.set(p.key, act);
    if (main.dataset.id !== act) {
      main.dataset.id = act;
      main.src = SMALL_URL(act);
    }
    for (const b of el.querySelectorAll(".posedb-mini")) {
      const i = order.indexOf(b.dataset.id);
      b.setAttribute("aria-pressed", i >= 0 ? "true" : "false");
      const bd = b.querySelector(".posedb-badge");
      if (bd) bd.textContent = i >= 0 ? i + 1 : "";
    }
  }

  function syncAll() {
    for (const el of grid.querySelectorAll(".posedb-card")) paintCard(el);
    updateCount();
  }

  function appendPage() {
    if (appended >= filtered.length) return;
    const slice = filtered.slice(appended, appended + PAGE);
    const frag = document.createDocumentFragment();
    for (const p of slice) frag.appendChild(makeCard(p));
    appended += slice.length;
    grid.appendChild(frag);
    updateCount();
  }

  let scrollTick = false;
  grid.addEventListener("scroll", () => {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      scrollTick = false;
      if (appended >= filtered.length) return;
      if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 260) appendPage();
    });
  });

  function applyFilter() {
    const q = $("#posedb-q").value.trim().toLowerCase();
    const series = curSeries;
    const cat = curCat;
    const hit = it =>
      (!series || it.series === series) &&
      (!cat || it.cat === cat) &&
      (!q || `${it.name} ${it.id} ${it.no} ${it.cat}`.toLowerCase().includes(q));

    filtered = [];
    for (const p of poses) {
      const items = p.items.filter(hit);
      if (items.length) filtered.push({ ...p, items });
    }

    grid.replaceChildren();
    appended = 0;

    if (!filtered.length) {
      grid.innerHTML = `<div class="posedb-empty">没有符合条件的图片</div>`;
      updateCount();
      return;
    }
    appendPage();
    syncAll();
  }

  function toggle(id) {
    const i = order.indexOf(id);
    if (i >= 0) {
      order.splice(i, 1);
      selected.delete(id);
    } else {
      order.push(id);
      selected.add(id);
    }
  }

  grid.addEventListener("click", e => {
    const card = e.target.closest(".posedb-card");
    if (!card) return;

    const mini = e.target.closest(".posedb-mini");
    if (mini) {
      // 小图 = 勾选开关，同时把它切成这张卡片的主图
      activeOf.set(card.dataset.key, mini.dataset.id);
      toggle(mini.dataset.id);
      syncAll();
      return;
    }
    // 点主图 = 切换当前主图的勾选状态
    const main = e.target.closest(".posedb-main");
    if (main && main.dataset.id) {
      toggle(main.dataset.id);
      syncAll();
    }
  });

  let timer = null;
  $("#posedb-q").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(applyFilter, 160);
  });
  seriesBar.addEventListener("click", e => {
    const b = e.target.closest(".posedb-sbtn");
    if (!b) return;
    curSeries = curSeries === b.dataset.series ? "" : b.dataset.series;
    paintSeries();
    saveFilter();
    applyFilter();
  });

  // 分类下拉：展开 / 收起、选中、点外面关掉
  const closeCatMenu = () => {
    catMenu.hidden = true;
    catBtn.setAttribute("aria-expanded", "false");
  };
  catBtn.addEventListener("click", e => {
    e.stopPropagation();
    const willOpen = catMenu.hidden;
    catMenu.hidden = !willOpen;
    catBtn.setAttribute("aria-expanded", willOpen ? "true" : "false");
  });
  catMenu.addEventListener("click", e => {
    const item = e.target.closest(".posedb-catitem");
    if (!item) return;
    e.stopPropagation();
    setCat(item.dataset.cat);
    saveFilter();
  });
  const onDocDown = e => {
    if (catMenu.hidden) return;
    if (e.target.closest && e.target.closest(".posedb-catwrap")) return;
    closeCatMenu();
  };
  document.addEventListener("mousedown", onDocDown, true);

  $("#posedb-clear").onclick = () => {
    order.length = 0;
    selected.clear();
    syncAll();
  };

  const onKey = e => {
    if (e.key === "Escape") {
      if (!catMenu.hidden) { closeCatMenu(); return; }
      close();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      $("#posedb-ok").click();
    }
  };
  function close() {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onDocDown, true);
    mask.remove();
  }
  document.addEventListener("keydown", onKey, true);
  $("#posedb-close").onclick = close;
  $("#posedb-cancel").onclick = close;
  mask.addEventListener("mousedown", e => { if (e.target === mask) close(); });
  $("#posedb-ok").onclick = () => {
    writeIds(node, order.slice(0, MAX_OUTPUTS));
    close();
  };

  paintSeries();
  catLabel.textContent = curCat || "全部分类";
  applyFilter();
  grid.scrollTop = 0;
  $("#posedb-q").focus();
}

app.registerExtension({
  name: "PoseDB.Selector",
  async setup() {
    watchTheme();
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "PoseDBSelector") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);

      const store = storeOf(this);
      if (store) {
        store.computeSize = () => [0, -4];
        if (store.element) store.element.style.display = "none";
      }

      const btn = this.addWidget("button", "选择姿势图…", null, () => openPicker(this), { serialize: false });
      btn.__posedb = true;
      this.__posedbStore = store;

      refresh(this);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      setTimeout(() => {
        const ids = readIds(this);
        syncOutputs(this, ids.length ? ids.length : 1);
        refresh(this);
      }, 0);
      return r;
    };

    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      onDrawForeground?.apply(this, arguments);
      try { drawStrip(ctx, this); } catch (e) { /* ignore */ }
    };
  },
});