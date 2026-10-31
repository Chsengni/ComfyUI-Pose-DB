import { app } from "../../scripts/app.js";

const MAX_OUTPUTS = 32;
const PAGE = 24;          // 每批渲染的卡片/图块数
const TILE_PAGE = 60;     // 服装 / 人像图块每批数量

// 输出槽约定（与 nodes.py 保持一致）
//   槽 0      : images  整批选中图，按勾选顺序
//   槽 1..32  : img1..img32
const IMAGES_SLOT = 0;
const IMG_OFFSET = 1;

const BASE = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

/* =========================================================================
 * 图库定义
 * =======================================================================*/

const LIBS = {
  pose: {
    key: "pose",
    title: "姿势",
    catalog: `${BASE}/catalog.json`,
    file: id => `${BASE}/thumbs/${id}.jpg`,
    preview: id => `${BASE}/small/${id}.jpg`,
    layout: "cards",
  },
  costume: {
    key: "costume",
    title: "服装",
    catalog: `${BASE}/costume/catalog.json`,
    file: id => `${BASE}/costume/thumbs/${id}.webp`,
    preview: id => `${BASE}/costume/thumbs/${id}.webp`,
    layout: "tiles",
    aspect: "2 / 3",
  },
  portrait: {
    key: "portrait",
    title: "人像",
    catalog: `${BASE}/portrait/catalog.json`,
    file: id => `${BASE}/portrait/thumbs/${id}.webp`,
    preview: id => `${BASE}/portrait/thumbs/${id}.webp`,
    layout: "tiles",
    aspect: "4 / 5",
  },
};

/** 清单里自带 thumb 相对路径时优先用它，否则按图库约定拼 */
const thumbOf = (lib, it) => (it && it.thumb ? `${BASE}/${it.thumb}` : LIBS[lib].file(it.id || it));
const previewOf = (lib, it) => (it && it.thumb ? `${BASE}/${it.thumb}` : LIBS[lib].preview(it.id || it));

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
    accentText: accentLum != null && accentLum > 0.62 ? "#111418" : "#ffffff",
    tileImg: f.tileImg,
    overlay: f.overlay,
    shadow: f.shadow,
    track: f.track,
  };
}

function palette() {
  if (!themeCache) themeCache = buildPalette();
  return themeCache;
}

function applyThemeVars(el) {
  const t = palette();
  const vars = {
    "--posedbg-panel": t.panel, "--posedbg-sub": t.sub, "--posedbg-card": t.card,
    "--posedbg-hover": t.hover, "--posedbg-border": t.border, "--posedbg-border2": t.border2,
    "--posedbg-text": t.text, "--posedbg-muted": t.muted, "--posedbg-accent": t.accent,
    "--posedbg-accent-text": t.accentText, "--posedbg-tile-img": t.tileImg,
    "--posedbg-overlay": t.overlay, "--posedbg-shadow": t.shadow,
  };
  for (const [k, v] of Object.entries(vars)) {
    if (v) el.style.setProperty(k, v);
  }
}

let watchingTheme = false;
function watchTheme() {
  if (watchingTheme) return;
  watchingTheme = true;
  const bump = () => {
    themeCache = null;
    const mask = document.getElementById("posedbg-mask");
    if (mask) applyThemeVars(mask);
    app.graph?.setDirtyCanvas(true, true);
  };
  try {
    new MutationObserver(bump).observe(document.documentElement, {
      attributes: true, attributeFilter: ["class", "style", "data-theme"],
    });
    new MutationObserver(bump).observe(document.body, {
      attributes: true, attributeFilter: ["class", "style", "data-theme"],
    });
  } catch (e) { /* ignore */ }
}

/* =========================================================================
 * 图库清单
 * =======================================================================*/

const catalogCache = new Map();

function getCatalog(lib) {
  if (!catalogCache.has(lib)) {
    const p = fetch(LIBS[lib].catalog, { cache: "force-cache" })
      .then(r => {
        if (!r.ok) throw new Error(`${LIBS[lib].title}图库清单读取失败 HTTP ${r.status}`);
        return r.json();
      })
      .then(data => buildView(lib, data))
      .catch(err => {
        catalogCache.delete(lib);
        throw err;
      });
    catalogCache.set(lib, p);
  }
  return catalogCache.get(lib);
}

/** 把原始清单整理成面板好用的结构 */
function buildView(lib, data) {
  const items = data.items || [];
  const byId = new Map(items.map(it => [it.id, it]));
  const view = { lib, data, items, byId, groups: null, chips: [], sub: null };

  if (lib === "pose") {
    const groups = new Map();
    for (const it of items) {
      const key = `${it.series}|${it.no}`;
      let g = groups.get(key);
      if (!g) {
        g = { key, series: it.series, no: it.no, name: it.name, cat: it.cat, items: [] };
        groups.set(key, g);
      }
      g.items.push(it);
    }
    view.groups = [...groups.values()];
    view.chips = [{ field: "series", values: data.series || [] }];
    view.hasCatMenu = true;
  } else if (lib === "costume") {
    view.chips = [{ field: "cat", values: data.cats || [] }];
  } else {
    view.chips = [{ field: "section", values: data.sections || [] }];
    view.sub = { field: "hair", values: data.hairs || [] };
  }
  return view;
}

/* =========================================================================
 * 节点：读写选中值 / 输出槽 / 缩略图条
 * =======================================================================*/

const widgetNamed = (node, name) => (node.widgets || []).find(w => w.name === name);
const buttonOf = node => (node.widgets || []).find(w => w.__posedbg);

function parseIds(value) {
  if (value == null) return [];
  try {
    const v = typeof value === "string" ? JSON.parse(value || "[]") : value;
    if (Array.isArray(v)) return v.filter(Boolean).map(String);
    if (v && typeof v === "object") return parseIds(v.ids || v.selected || []);
    if (typeof v === "string" && v.trim()) return [v.trim()];
    return [];
  } catch {
    const s = String(value).trim();
    return s ? [s] : [];
  }
}

function readIds(node) {
  const w = widgetNamed(node, "selected");
  return w ? parseIds(w.value) : [];
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
  const w = widgetNamed(node, "selected");
  if (w) w.value = JSON.stringify(ids);
  refreshSelector(node);
}

function refreshSelector(node, label) {
  if (label) node.__posedbgLabel = label;
  const nm = node.__posedbgLabel || "选择图片";
  const ids = readIds(node);
  const btn = buttonOf(node);
  if (btn) btn.name = ids.length ? `${nm}（已选 ${ids.length}）` : `${nm}…`;
  syncOutputs(node, ids.length);
  node.setDirtyCanvas(true, true);
  app.graph?.setDirtyCanvas(true, true);
}

/* ---- 角色合成节点 ---- */

const CHAR_WIDGETS = { portrait: "portrait_id", costume: "outfit_id", pose: "pose_id" };

function readRecipe(node) {
  const out = {};
  for (const [lib, name] of Object.entries(CHAR_WIDGETS)) {
    const w = widgetNamed(node, name);
    out[lib] = w ? (parseIds(w.value)[0] || "") : "";
  }
  return out;
}

function writeRecipe(node, recipe) {
  for (const [lib, name] of Object.entries(CHAR_WIDGETS)) {
    const w = widgetNamed(node, name);
    if (w) w.value = recipe[lib] || "";
  }
  refreshCharacter(node);
}

function refreshCharacter(node) {
  const r = readRecipe(node);
  const btn = buttonOf(node);
  const n = [r.portrait, r.costume, r.pose].filter(Boolean).length;
  if (btn) btn.name = n ? `选择角色配方（${n}/3 已选）` : "选择角色配方…";
  node.setDirtyCanvas(true, true);
  app.graph?.setDirtyCanvas(true, true);
}

/* ---- canvas 缩略图 ---- */

const thumbCache = new Map();
function canvasThumb(lib, item) {
  const key = `${lib}:${item.id}`;
  let e = thumbCache.get(key);
  if (!e) {
    const img = new Image();
    e = { img, ok: false };
    img.onload = () => { e.ok = true; app.graph?.setDirtyCanvas(true, true); };
    img.onerror = () => { e.ok = false; };
    img.src = previewOf(lib, item);
    thumbCache.set(key, e);
  }
  return e;
}

/** 选择器节点：底部缩略图条（按节点所属图库取图） */
function drawStrip(ctx, node) {
  const ids = readIds(node);
  if (!ids.length) return;
  const lib = node.__posedbgLib || "costume";

  const t = palette();
  const nodeW = Math.max(0, node.size[0]);
  const nodeH = Math.max(0, node.size[1]);
  const pad = 10;
  const h = Math.min(74, Math.max(0, nodeH - 16));
  if (nodeW < 90 || h < 24) return;
  const top = Math.max(0, nodeH - h - 8);
  const width = Math.max(0, nodeW - pad * 2);

  ctx.save();
  ctx.fillStyle = t.track;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(pad, top, width, h, 8);
  else ctx.rect(pad, top, width, h);
  ctx.fill();

  const gap = 6;
  const inner = width - 8;
  ctx.font = "600 13px system-ui, sans-serif";

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

  ctx.save();
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(pad, top, width, h, 8);
  else ctx.rect(pad, top, width, h);
  ctx.clip();

  for (let i = 0; i < shown; i++) {
    const x = pad + 4 + i * (tileW + gap);
    const entry = canvasThumb(lib, { id: ids[i] });
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

/** 角色合成节点：人像 / 服装 / 姿势 三张缩略图 + 名称 */
function drawRecipe(ctx, node) {
  const recipe = readRecipe(node);
  const nodeW = Math.max(0, node.size[0]);
  const nodeH = Math.max(0, node.size[1]);
  const pad = 10;
  const h = Math.min(132, Math.max(0, nodeH - 16));
  if (nodeW < 120 || h < 60) return;

  const top = Math.max(0, nodeH - h - 8);
  const width = Math.max(0, nodeW - pad * 2);
  const t = palette();

  ctx.save();
  ctx.fillStyle = t.track;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(pad, top, width, h, 8);
  else ctx.rect(pad, top, width, h);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(pad, top, width, h, 8);
  else ctx.rect(pad, top, width, h);
  ctx.clip();

  const gap = 8;
  const cellW = (width - 8 - gap * 2) / 3;
  const cellH = h - 26;
  const labels = [["人像", "portrait"], ["服装", "costume"], ["姿势", "pose"]];

  ctx.textAlign = "center";
  labels.forEach(([text, lib], i) => {
    const x = pad + 4 + i * (cellW + gap);
    const y = top + 6;
    ctx.fillStyle = t.dark ? "rgba(0,0,0,0.35)" : "rgba(0,0,0,0.08)";
    ctx.fillRect(x, y, cellW, cellH);

    const id = recipe[lib];
    if (id) {
      const entry = canvasThumb(lib, { id, thumb: "" });
      if (entry.ok) ctx.drawImage(entry.img, x, y, cellW, cellH);
    }
    ctx.strokeStyle = t.border2;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);

    ctx.fillStyle = t.muted;
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText(text, x + cellW / 2, y + cellH + 4);
  });
  ctx.restore();
  ctx.restore();
}

/* =========================================================================
 * 选择面板
 * =======================================================================*/

const CSS = `
#posedbg-mask{position:fixed;inset:0;z-index:10000;background:var(--posedbg-overlay,rgba(4,6,10,.78));backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:24px;font:14px/1.6 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--posedbg-text,#e9ecf1)}
#posedbg-mask *{box-sizing:border-box}
.posedbg-panel{width:min(920px,100%);height:min(86vh,900px);display:flex;flex-direction:column;background:var(--posedbg-panel,#14171c);border:1px solid var(--posedbg-border,#2c323c);border-radius:16px;box-shadow:var(--posedbg-shadow,0 20px 60px rgba(0,0,0,.55));overflow:hidden;color:var(--posedbg-text,#e9ecf1)}
.posedbg-hd{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--posedbg-border,#262b33)}
.posedbg-hd h3{margin:0;font-size:17px;font-weight:700;color:var(--posedbg-text,#e9ecf1)}
.posedbg-hd .posedbg-count{margin-left:auto;font-weight:700;color:var(--posedbg-accent,#8fb4ff);white-space:nowrap}
.posedbg-x{width:36px;height:36px;border-radius:50%;border:1px solid var(--posedbg-border2,#3a414b);background:var(--posedbg-card,#1b1f26);color:var(--posedbg-text,#e9ecf1);font-size:18px;cursor:pointer}
.posedbg-x:hover{background:var(--posedbg-hover,#252b34)}
/* 图库标签页 */
.posedbg-tabs{display:flex;gap:8px;padding:10px 18px 0;background:var(--posedbg-sub,#171b21);border-bottom:1px solid var(--posedbg-border,#262b33)}
.posedbg-tab{position:relative;display:flex;align-items:center;gap:6px;height:38px;padding:0 16px;border:1px solid transparent;border-bottom:0;border-radius:10px 10px 0 0;background:transparent;color:var(--posedbg-muted,#98a1ae);font-size:14px;font-weight:600;cursor:pointer}
.posedbg-tab:hover{color:var(--posedbg-text,#e9ecf1)}
.posedbg-tab[aria-selected="true"]{background:var(--posedbg-panel,#14171c);border-color:var(--posedbg-border,#262b33);color:var(--posedbg-text,#e9ecf1)}
.posedbg-tab i{font-style:normal;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--posedbg-accent,#8fb4ff);color:var(--posedbg-accent-text,#111418);font-size:11px;font-weight:700;display:none;align-items:center;justify-content:center}
.posedbg-tab i.on{display:inline-flex}
.posedbg-ft{display:flex;align-items:center;gap:12px;padding:12px 18px;border-top:1px solid var(--posedbg-border,#262b33);background:var(--posedbg-sub,#171b21)}
.posedbg-tools{display:flex;flex-wrap:wrap;gap:8px;padding:12px 18px;border-bottom:1px solid var(--posedbg-border,#262b33);background:var(--posedbg-sub,#171b21)}
.posedbg-tools input,.posedbg-tools select{height:38px;background:var(--posedbg-card,#1b1f26);border:1px solid var(--posedbg-border2,#39404a);border-radius:9px;color:var(--posedbg-text,#e9ecf1);padding:0 10px;font-size:14px;outline:none}
.posedbg-tools input::placeholder{color:var(--posedbg-muted,#98a1ae)}
.posedbg-tools select option{background:var(--posedbg-panel,#14171c);color:var(--posedbg-text,#e9ecf1)}
.posedbg-tools input{flex:1 1 220px;min-width:160px}
.posedbg-tools input:focus,.posedbg-tools select:focus{border-color:var(--posedbg-accent,#8fb4ff)}
/* 筛选：圆角按钮（系列 / 分类 / 分区 / 发长） */
.posedbg-chiprow{display:flex;flex-wrap:wrap;gap:6px;flex:1 1 100%}
.posedbg-chip{height:32px;padding:0 13px;border-radius:16px;border:1px solid var(--posedbg-border2,#39404a);background:var(--posedbg-card,#1b1f26);color:var(--posedbg-text,#e9ecf1);font-size:13px;font-weight:600;white-space:nowrap;cursor:pointer;transition:background .12s,border-color .12s,color .12s}
.posedbg-chip:hover{background:var(--posedbg-hover,#252b34)}
.posedbg-chip[aria-pressed="true"]{background:var(--posedbg-accent,#8fb4ff);border-color:var(--posedbg-accent,#8fb4ff);color:var(--posedbg-accent-text,#111418)}
/* 分类下拉：自定义列表 */
.posedbg-catwrap{position:relative;display:flex;flex:0 0 auto}
.posedbg-catbtn{display:flex;align-items:center;gap:8px;height:38px;min-width:158px;padding:0 10px;background:var(--posedbg-card,#1b1f26);border:1px solid var(--posedbg-border2,#39404a);border-radius:9px;color:var(--posedbg-text,#e9ecf1);font-size:14px;cursor:pointer}
.posedbg-catbtn:hover{background:var(--posedbg-hover,#252b34)}
.posedbg-catbtn[aria-expanded="true"]{border-color:var(--posedbg-accent,#8fb4ff)}
.posedbg-catbtn .posedbg-catlabel{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
.posedbg-catbtn .posedbg-caret{flex:0 0 auto;color:var(--posedbg-muted,#98a1ae);font-size:10px;transition:transform .15s}
.posedbg-catbtn[aria-expanded="true"] .posedbg-caret{transform:rotate(180deg)}
.posedbg-catmenu{position:absolute;top:calc(100% + 6px);left:0;z-index:30;min-width:260px;max-height:min(54vh,440px);overflow:auto;padding:6px;background:var(--posedbg-panel,#14171c);border:1px solid var(--posedbg-border,#2c323c);border-radius:12px;box-shadow:var(--posedbg-shadow,0 20px 60px rgba(0,0,0,.55))}
.posedbg-catmenu[hidden]{display:none}
.posedbg-catitem{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:var(--posedbg-text,#e9ecf1);font-size:14px;text-align:left;cursor:pointer}
.posedbg-catitem:hover{background:var(--posedbg-hover,#252b34)}
.posedbg-catitem[aria-current="true"]{background:var(--posedbg-hover,#252b34);font-weight:700}
.posedbg-catitem .posedbg-catnm{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 网格：姿势卡片 / 服装人像图块 */
.posedbg-grid{flex:1;overflow:auto;padding:10px;align-content:start;background:var(--posedbg-panel,#14171c);scrollbar-gutter:stable}
.posedbg-grid.cards{display:grid;grid-template-columns:repeat(auto-fill,168px);justify-content:center;gap:10px}
.posedbg-grid.tiles{display:grid;grid-template-columns:repeat(auto-fill,138px);justify-content:center;gap:10px}
.posedbg-card{display:flex;flex-direction:column;width:168px;padding:8px;gap:6px;border:1px solid var(--posedbg-border,#2c323c);border-radius:11px;background:var(--posedbg-card,#1b1f26)}
.posedbg-card-hd{display:flex;flex-direction:column;gap:1px;min-width:0}
.posedbg-card-hd b{font-size:12px;font-weight:700;color:var(--posedbg-text,#e9ecf1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.posedbg-card-hd i{font-style:normal;font-size:10px;color:var(--posedbg-muted,#98a1ae);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.posedbg-strip{display:grid;grid-template-columns:repeat(5,1fr);gap:4px}
.posedbg-mini{position:relative;padding:0;aspect-ratio:3/4;border:2px solid transparent;border-radius:7px;background-color:var(--posedbg-tile-img,#f2f2f0);background-size:cover;background-position:center;cursor:pointer;overflow:hidden}
.posedbg-mini:hover{border-color:var(--posedbg-border2,#4b5566)}
.posedbg-mini[aria-pressed="true"]{border-color:var(--posedbg-accent,#8fb4ff);box-shadow:0 0 0 2px var(--posedbg-accent,#8fb4ff)}
.posedbg-main{display:block;width:100%;aspect-ratio:3/4;object-fit:contain;border-radius:9px;background:var(--posedbg-tile-img,#f2f2f0);cursor:pointer}
.posedbg-badge{position:absolute;top:3px;left:3px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--posedbg-accent,#8fb4ff);color:var(--posedbg-accent-text,#111418);font-weight:700;font-size:11px;display:none;align-items:center;justify-content:center}
.posedbg-mini[aria-pressed="true"] .posedbg-badge{display:flex}
/* 服装 / 人像图块 */
.posedbg-tile{position:relative;display:flex;flex-direction:column;width:138px;padding:0;border:2px solid transparent;border-radius:11px;background:var(--posedbg-card,#1b1f26);color:var(--posedbg-text,#e9ecf1);cursor:pointer;overflow:hidden;text-align:left}
.posedbg-tile:hover{border-color:var(--posedbg-border2,#4b5566)}
.posedbg-tile[aria-pressed="true"]{border-color:var(--posedbg-accent,#8fb4ff);box-shadow:0 0 0 2px var(--posedbg-accent,#8fb4ff)}
.posedbg-tile img{display:block;width:100%;aspect-ratio:var(--posedbg-ar,2/3);object-fit:cover;background:var(--posedbg-tile-img,#f2f2f0)}
.posedbg-tile .posedbg-tnm{display:block;padding:6px 7px 2px;font-size:11px;line-height:1.35;max-height:46px;overflow:hidden}
.posedbg-tile .posedbg-tmeta{display:block;padding:0 7px 7px;font-size:10px;color:var(--posedbg-muted,#98a1ae);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.posedbg-tile .posedbg-badge{top:5px;left:5px;min-width:20px;height:20px}
.posedbg-tile[aria-pressed="true"] .posedbg-badge{display:flex}
.posedbg-btn{height:40px;padding:0 18px;border-radius:10px;border:1px solid var(--posedbg-border2,#3a414b);background:var(--posedbg-card,#1b1f26);color:var(--posedbg-text,#e9ecf1);font-size:14px;font-weight:600;cursor:pointer}
.posedbg-btn:hover{background:var(--posedbg-hover,#252b34)}
.posedbg-btn.primary{background:var(--posedbg-accent,#8fb4ff);border-color:var(--posedbg-accent,#8fb4ff);color:var(--posedbg-accent-text,#111418)}
.posedbg-btn.primary:hover{filter:brightness(1.06)}
.posedbg-tip{color:var(--posedbg-muted,#98a1ae);font-size:13px}
.posedbg-empty{grid-column:1/-1;text-align:center;color:var(--posedbg-muted,#98a1ae);padding:60px 0}
`;

function injectCSS() {
  if (document.getElementById("posedbg-css")) return;
  const s = document.createElement("style");
  s.id = "posedbg-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * 打开选择面板。
 * cfg = {
 *   title, libs:[...], multi:bool, max:int,
 *   read:()=>({lib:[ids]}), write:(map)=>void
 * }
 */
async function openPicker(node, cfg) {
  if (document.getElementById("posedbg-mask")) return;
  injectCSS();
  watchTheme();

  const libs = cfg.libs.slice();
  const multi = cfg.multi !== false;
  const max = cfg.max || MAX_OUTPUTS;

  const views = {};
  try {
    const list = await Promise.all(libs.map(l => getCatalog(l)));
    libs.forEach((l, i) => { views[l] = list[i]; });
  } catch (e) {
    alert(`读取内置图库清单失败：${e.message}\n请确认节点包里的 web/ 目录完整。`);
    return;
  }

  // 选中状态：order 记顺序，set 用于快速判断
  const initial = (cfg.read && cfg.read()) || {};
  const order = {};
  const sel = {};
  for (const lib of libs) {
    const ids = (initial[lib] || []).filter(id => views[lib].byId.has(id));
    order[lib] = multi ? ids.slice(0, max) : ids.slice(0, 1);
    sel[lib] = new Set(order[lib]);
  }

  // 每个图库各自的筛选状态（同一图库再次打开时沿用上次的）
  const savedAll = (node.properties && node.properties.posedbgFilter) || {};
  const filters = {};
  for (const lib of libs) {
    const saved = savedAll[lib] || {};
    filters[lib] = {
      q: "",
      qRaw: "",
      series: saved.series || "",
      cat: saved.cat || "",
      section: saved.section || "",
      hair: saved.hair || "",
    };
  }

  let active = libs[0];

  const mask = document.createElement("div");
  mask.id = "posedbg-mask";
  mask.innerHTML = `
    <div class="posedbg-panel" role="dialog" aria-label="PoseDB 图库">
      <div class="posedbg-hd">
        <h3>${esc(cfg.title || "PoseDB 图库")}</h3>
        <span class="posedbg-count" id="posedbg-num"></span>
        <button class="posedbg-x" id="posedbg-close" title="关闭">×</button>
      </div>
      ${libs.length > 1 ? `<div class="posedbg-tabs" id="posedbg-tabs">
        ${libs.map(l => `<button type="button" class="posedbg-tab" data-lib="${l}" aria-selected="false">
          ${esc(LIBS[l].title)}<i></i></button>`).join("")}
      </div>` : ""}
      <div class="posedbg-tools" id="posedbg-tools"></div>
      <div class="posedbg-grid" id="posedbg-grid"></div>
      <div class="posedbg-ft">
        <span class="posedbg-tip" id="posedbg-tip"></span>
        <span style="margin-left:auto"></span>
        <button class="posedbg-btn" id="posedbg-clear">清空</button>
        <button class="posedbg-btn" id="posedbg-cancel">取消</button>
        <button class="posedbg-btn primary" id="posedbg-ok">确定</button>
      </div>
    </div>`;
  applyThemeVars(mask);
  document.body.appendChild(mask);

  const $ = s => mask.querySelector(s);
  const grid = $("#posedbg-grid");
  const tools = $("#posedbg-tools");
  const tabs = $("#posedbg-tabs");

  /* ---- 计数 / 徽标 ---- */

  function totalCount() {
    return libs.reduce((n, l) => n + order[l].length, 0);
  }

  function updateCount() {
    const total = totalCount();
    $("#posedbg-num").textContent = multi
      ? `已选 ${total} / ${max}`
      : `已选 ${total} / ${libs.length}`;

    if (tabs) {
      for (const b of tabs.querySelectorAll(".posedbg-tab")) {
        const n = order[b.dataset.lib].length;
        const i = b.querySelector("i");
        i.textContent = n ? String(n) : "";
        i.classList.toggle("on", n > 0);
      }
    }

    const over = multi && total > max;
    $("#posedbg-tip").textContent = over
      ? `超出上限 ${max} 张，只有前 ${max} 张会有输出`
      : multi
        ? "勾选顺序 = images 批内顺序 = img1、img2…"
        : "人像 / 服装 / 姿势 各选一张，确定后输出三张参考图 + 提示词";
  }

  /* ---- 筛选条 ---- */

  function chipRow(view, chip) {
    const cur = filters[view.lib][chip.field] || "";
    return `<div class="posedbg-chiprow" data-field="${chip.field}">
      <button type="button" class="posedbg-chip" data-v="" aria-pressed="${cur ? "false" : "true"}">全部</button>
      ${chip.values.map(v => `<button type="button" class="posedbg-chip" data-v="${esc(v)}"
        aria-pressed="${cur === v ? "true" : "false"}">${esc(v)}</button>`).join("")}
    </div>`;
  }

  function buildTools() {
    const view = views[active];
    const f = filters[active];
    let html = view.chips.map(c => chipRow(view, c)).join("");
    html += `<input id="posedbg-q" type="search" placeholder="${
      active === "pose" ? "搜索：姿势名 / 编号 / id"
        : active === "costume" ? "搜索：服装名称 / 分类 / 标签 / 英文关键词"
          : "搜索：发型 / 分区 / id"}" value="${esc(f.qRaw || "")}">`;

    if (view.sub) {
      html += `<select id="posedbg-sub">
        <option value="">全部${esc(view.sub.field === "hair" ? "发长" : "")}</option>
        ${view.sub.values.map(v => `<option value="${esc(v)}"${f[view.sub.field] === v ? " selected" : ""}>${esc(v)}</option>`).join("")}
      </select>`;
    }

    if (view.hasCatMenu) {
      const cats = [...new Set(view.items.map(i => i.cat).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, "zh"));
      html += `<div class="posedbg-catwrap">
        <button type="button" class="posedbg-catbtn" id="posedbg-cat-btn" aria-expanded="false" aria-haspopup="listbox">
          <span class="posedbg-catlabel" id="posedbg-cat-label">${esc(f.cat || "全部分类")}</span>
          <span class="posedbg-caret">▼</span>
        </button>
        <div class="posedbg-catmenu" id="posedbg-cat-menu" role="listbox" hidden>
          ${["", ...cats].map(c => `<button type="button" class="posedbg-catitem" role="option"
            data-cat="${esc(c)}" aria-current="${c === f.cat ? "true" : "false"}">
            <span class="posedbg-catnm">${esc(c || "全部分类")}</span></button>`).join("")}
        </div>
      </div>`;
    }
    tools.innerHTML = html;

    // 搜索
    let timer = null;
    $("#posedbg-q").addEventListener("input", e => {
      clearTimeout(timer);
      const v = e.target.value;
      timer = setTimeout(() => {
        filters[active].qRaw = v;
        filters[active].q = v.trim().toLowerCase();
        render();
      }, 160);
    });

    // 圆角筛选按钮
    for (const row of tools.querySelectorAll(".posedbg-chiprow")) {
      row.addEventListener("click", e => {
        const b = e.target.closest(".posedbg-chip");
        if (!b) return;
        const field = row.dataset.field;
        const v = b.dataset.v;
        filters[active][field] = filters[active][field] === v ? "" : v;
        saveFilter();
        buildTools();
        render();
      });
    }

    if (view.sub) {
      $("#posedbg-sub").addEventListener("change", e => {
        filters[active][view.sub.field] = e.target.value;
        saveFilter();
        render();
      });
    }

    if (view.hasCatMenu) {
      const catBtn = $("#posedbg-cat-btn");
      const catMenu = $("#posedbg-cat-menu");
      const closeMenu = () => { catMenu.hidden = true; catBtn.setAttribute("aria-expanded", "false"); };
      catBtn.addEventListener("click", e => {
        e.stopPropagation();
        const open = catMenu.hidden;
        catMenu.hidden = !open;
        catBtn.setAttribute("aria-expanded", open ? "true" : "false");
      });
      catMenu.addEventListener("click", e => {
        const item = e.target.closest(".posedbg-catitem");
        if (!item) return;
        e.stopPropagation();
        filters[active].cat = item.dataset.cat;
        saveFilter();
        buildTools();
        render();
      });
      mask.__closeCat = closeMenu;
    } else {
      mask.__closeCat = null;
    }
  }

  function saveFilter() {
    node.properties = node.properties || {};
    const out = { ...(node.properties.posedbgFilter || {}) };
    for (const lib of libs) {
      const f = filters[lib];
      out[lib] = { series: f.series, cat: f.cat, section: f.section, hair: f.hair };
    }
    node.properties.posedbgFilter = out;
  }

  /* ---- 列表 ---- */

  let filtered = [];
  let appended = 0;
  const activeOf = new Map(); // 姿势卡片 key -> 当前主图 id

  function filterItems() {
    const view = views[active];
    const f = filters[active];
    const q = f.q;
    const hit = it => {
      if (f.series && it.series !== f.series) return false;
      if (f.cat && it.cat !== f.cat) return false;
      if (f.section && it.section !== f.section) return false;
      if (f.hair && it.hair !== f.hair) return false;
      if (!q) return true;
      const hay = active === "pose"
        ? `${it.name} ${it.id} ${it.no} ${it.cat} ${it.series} ${it.angle}`
        : active === "costume"
          ? `${it.name} ${it.id} ${it.cat} ${(it.tags || []).join(" ")} ${it.kw || ""}`
          : `${it.name} ${it.id} ${it.section} ${it.hair} ${it.style || ""}`;
      return hay.toLowerCase().includes(q);
    };
    return hit;
  }

  function render() {
    const view = views[active];
    const hit = filterItems();
    grid.className = `posedbg-grid ${view.groups ? "cards" : "tiles"}`;
    if (LIBS[active].aspect) grid.style.setProperty("--posedbg-ar", LIBS[active].aspect);
    grid.replaceChildren();
    appended = 0;

    if (view.groups) {
      filtered = [];
      for (const g of view.groups) {
        const items = g.items.filter(hit);
        if (items.length) filtered.push({ ...g, items });
      }
    } else {
      filtered = view.items.filter(hit);
    }

    if (!filtered.length) {
      grid.innerHTML = `<div class="posedbg-empty">没有符合条件的图片</div>`;
      updateCount();
      return;
    }
    appendPage();
    syncAll();
  }

  function pageSize() {
    return views[active].groups ? PAGE : TILE_PAGE;
  }

  function appendPage() {
    if (appended >= filtered.length) return;
    const slice = filtered.slice(appended, appended + pageSize());
    const frag = document.createDocumentFragment();
    const view = views[active];
    for (const entry of slice) {
      frag.appendChild(view.groups ? makeCard(entry) : makeTile(entry));
    }
    appended += slice.length;
    grid.appendChild(frag);
    updateCount();
  }

  /* ---- 姿势卡片 ---- */

  function makeCard(p) {
    const el = document.createElement("div");
    el.className = "posedbg-card";
    el.dataset.key = p.key;
    el.__pose = p;

    const hd = document.createElement("div");
    hd.className = "posedbg-card-hd";
    hd.innerHTML = `<b title="${esc(p.name)}">${esc(p.name)}</b><i>${esc(p.no)}｜${esc(p.cat)}｜${esc(p.series)}</i>`;

    const strip = document.createElement("div");
    strip.className = "posedbg-strip";
    for (const it of p.items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "posedbg-mini";
      b.dataset.id = it.id;
      b.title = `${it.angle}｜${it.name}｜${it.no}`;
      b.style.backgroundImage = `url("${previewOf("pose", it)}")`;
      b.setAttribute("aria-pressed", "false");
      b.innerHTML = `<span class="posedbg-badge"></span>`;
      strip.appendChild(b);
    }

    const main = document.createElement("img");
    main.className = "posedbg-main";
    main.loading = "lazy";
    main.decoding = "async";
    main.alt = p.name;
    main.addEventListener("error", () => {
      if (main.dataset.fb) return;
      main.dataset.fb = "1";
      main.src = thumbOf("pose", { id: main.dataset.id });
    });

    // 卡片结构：主图 → 标题 → 5 个角度小图
    el.append(main, hd, strip);
    paintCard(el);
    return el;
  }

  function paintCard(el) {
    const p = el.__pose;
    const main = el.querySelector(".posedbg-main");
    let act = activeOf.get(p.key);
    if (!act || !p.items.some(it => it.id === act)) act = p.items[0].id;
    activeOf.set(p.key, act);
    if (main.dataset.id !== act) {
      main.dataset.id = act;
      main.src = previewOf("pose", { id: act });
    }
    for (const b of el.querySelectorAll(".posedbg-mini")) {
      const i = order.pose.indexOf(b.dataset.id);
      b.setAttribute("aria-pressed", i >= 0 ? "true" : "false");
      const bd = b.querySelector(".posedbg-badge");
      if (bd) bd.textContent = i >= 0 ? i + 1 : "";
    }
  }

  /* ---- 服装 / 人像图块 ---- */

  function makeTile(it) {
    const lib = active;
    const el = document.createElement("button");
    el.type = "button";
    el.className = "posedbg-tile";
    el.dataset.id = it.id;
    el.title = lib === "costume"
      ? `${it.name}\n分类：${it.cat}\n关键词：${it.kw || ""}`
      : `${it.name}\n分区：${it.section}\n发长：${it.hair}`;
    el.setAttribute("aria-pressed", "false");

    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.src = thumbOf(lib, it);
    img.alt = it.name;

    const nm = document.createElement("span");
    nm.className = "posedbg-tnm";
    nm.textContent = it.name;

    const meta = document.createElement("span");
    meta.className = "posedbg-tmeta";
    meta.textContent = lib === "costume" ? it.cat : `${it.section}｜${it.hair}`;

    const badge = document.createElement("span");
    badge.className = "posedbg-badge";

    el.append(img, nm, meta, badge);
    paintTile(el);
    return el;
  }

  function paintTile(el) {
    const i = order[active].indexOf(el.dataset.id);
    el.setAttribute("aria-pressed", i >= 0 ? "true" : "false");
    const b = el.querySelector(".posedbg-badge");
    if (b) b.textContent = i >= 0 ? String(i + 1) : "";
  }

  function syncAll() {
    if (views[active].groups) {
      for (const el of grid.querySelectorAll(".posedbg-card")) paintCard(el);
    } else {
      for (const el of grid.querySelectorAll(".posedbg-tile")) paintTile(el);
    }
    updateCount();
  }

  /* ---- 选择逻辑 ---- */

  function toggle(lib, id) {
    if (!multi) {
      // 单选：再点一次已选中的图 = 取消
      if (order[lib][0] === id) {
        order[lib] = [];
        sel[lib].clear();
      } else {
        order[lib] = [id];
        sel[lib] = new Set([id]);
      }
      return;
    }
    const i = order[lib].indexOf(id);
    if (i >= 0) {
      order[lib].splice(i, 1);
      sel[lib].delete(id);
    } else if (order[lib].length < max) {
      order[lib].push(id);
      sel[lib].add(id);
    } else {
      $("#posedbg-tip").textContent = `最多选 ${max} 张，先取消几张再选`;
      return;
    }
  }

  grid.addEventListener("click", e => {
    if (views[active].groups) {
      const card = e.target.closest(".posedbg-card");
      if (!card) return;
      const mini = e.target.closest(".posedbg-mini");
      if (mini) {
        activeOf.set(card.dataset.key, mini.dataset.id);
        toggle("pose", mini.dataset.id);
        syncAll();
        return;
      }
      const main = e.target.closest(".posedbg-main");
      if (main && main.dataset.id) {
        toggle("pose", main.dataset.id);
        syncAll();
      }
      return;
    }

    const tile = e.target.closest(".posedbg-tile");
    if (!tile) return;
    toggle(active, tile.dataset.id);
    syncAll();
  });

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

  /* ---- 标签页 ---- */

  function setActive(lib) {
    active = lib;
    if (tabs) {
      for (const b of tabs.querySelectorAll(".posedbg-tab")) {
        b.setAttribute("aria-selected", b.dataset.lib === lib ? "true" : "false");
      }
    }
    buildTools();
    render();
    grid.scrollTop = 0;
  }

  if (tabs) {
    tabs.addEventListener("click", e => {
      const b = e.target.closest(".posedbg-tab");
      if (b && b.dataset.lib !== active) setActive(b.dataset.lib);
    });
  }

  /* ---- 底部按钮 ---- */

  $("#posedbg-clear").onclick = () => {
    for (const lib of libs) {
      order[lib].length = 0;
      sel[lib].clear();
    }
    syncAll();
  };

  const onKey = e => {
    if (e.key === "Escape") {
      if (mask.__closeCat) {
        const menu = $("#posedbg-cat-menu");
        if (menu && !menu.hidden) { mask.__closeCat(); return; }
      }
      close();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      $("#posedbg-ok").click();
    }
  };
  function close() {
    document.removeEventListener("keydown", onKey, true);
    mask.remove();
  }
  document.addEventListener("keydown", onKey, true);
  $("#posedbg-close").onclick = close;
  $("#posedbg-cancel").onclick = close;
  mask.addEventListener("mousedown", e => { if (e.target === mask) close(); });
  $("#posedbg-ok").onclick = () => {
    const out = {};
    for (const lib of libs) out[lib] = order[lib].slice(0, multi ? max : 1);
    cfg.write(out);
    close();
  };

  setActive(active);
}

/* =========================================================================
 * 节点注册
 * =======================================================================*/

const SELECTOR_NODES = {
  // 姿势选择器仍由 pose_db.js 负责，这里只接管新增的两个图库选择器
  PoseDBCostumeSelector: { lib: "costume", title: "PoseDB 服装图库", button: "选择服装" },
  PoseDBPortraitSelector: { lib: "portrait", title: "PoseDB 人像图库", button: "选择人像" },
};

function setupSelector(node, cfg) {
  const store = widgetNamed(node, "selected");
  if (store) {
    store.computeSize = () => [0, -4];
    if (store.element) store.element.style.display = "none";
  }

  const btn = node.addWidget("button", `${cfg.button}…`, null, () => {
    openPicker(node, {
      title: cfg.title,
      libs: [cfg.lib],
      multi: true,
      max: MAX_OUTPUTS,
      read: () => ({ [cfg.lib]: readIds(node) }),
      write: map => writeIds(node, map[cfg.lib] || []),
    });
  }, { serialize: false });
  btn.__posedbg = true;
  node.__posedbgLib = cfg.lib;

  refreshSelector(node, cfg.button);
}

function setupCharacter(node) {
  for (const name of Object.values(CHAR_WIDGETS)) {
    const w = widgetNamed(node, name);
    if (!w) continue;
    w.computeSize = () => [0, -4];
    if (w.element) w.element.style.display = "none";
  }

  const btn = node.addWidget("button", "选择角色配方…", null, () => {
    openPicker(node, {
      title: "PoseDB 角色配方（人像 + 服装 + 姿势）",
      libs: ["portrait", "costume", "pose"],
      multi: false,
      read: () => {
        const r = readRecipe(node);
        return { portrait: r.portrait ? [r.portrait] : [], costume: r.costume ? [r.costume] : [], pose: r.pose ? [r.pose] : [] };
      },
      write: map => writeRecipe(node, {
        portrait: (map.portrait || [])[0] || "",
        costume: (map.costume || [])[0] || "",
        pose: (map.pose || [])[0] || "",
      }),
    });
  }, { serialize: false });
  btn.__posedbg = true;

  refreshCharacter(node);
}

app.registerExtension({
  name: "PoseDB.Gallery",
  async setup() {
    watchTheme();
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    const sel = SELECTOR_NODES[nodeData.name];
    const isChar = nodeData.name === "PoseDBCharacter";
    if (!sel && !isChar) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      if (sel) setupSelector(this, sel);
      else setupCharacter(this);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      setTimeout(() => {
        if (sel) {
          const ids = readIds(this);
          syncOutputs(this, ids.length ? ids.length : 1);
          refreshSelector(this, sel.button);
        } else {
          refreshCharacter(this);
        }
      }, 0);
      return r;
    };

    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      onDrawForeground?.apply(this, arguments);
      try {
        if (sel) drawStrip(ctx, this);
        else drawRecipe(ctx, this);
      } catch (e) { /* ignore */ }
    };
  },
});
