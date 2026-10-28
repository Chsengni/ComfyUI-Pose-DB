import json
import os
from collections import OrderedDict

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps

NODE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(NODE_DIR, "web")
THUMB_DIR = os.path.join(WEB_DIR, "thumbs")
CATALOG_PATH = os.path.join(WEB_DIR, "catalog.json")

MAX_OUTPUTS = 32
_CACHE_LIMIT = 64

# 输出槽 0 固定为 images（整批选中图），槽 1 起为 img1、img2 …（前端保持同样约定）
IMAGES_SLOT = 0
IMG_OFFSET = 1

_IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".bmp")

_catalog = None
_catalog_by_id = None
_cache = OrderedDict()
_PLACEHOLDER = None
_thumb_index = None


# --------------------------------------------------------------------------
# 图库清单 / 图片路径
# --------------------------------------------------------------------------

def get_catalog():
    """读取 web/catalog.json（进程内缓存一次）。"""
    global _catalog, _catalog_by_id
    if _catalog is None:
        if not os.path.isfile(CATALOG_PATH):
            raise RuntimeError(
                "PoseDB：找不到图库清单 %s，请确认自定义节点目录完整（web/catalog.json）。" % CATALOG_PATH
            )
        with open(CATALOG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        _catalog = data.get("items", []) or []
        _catalog_by_id = {str(it.get("id")): it for it in _catalog if it.get("id")}
    return _catalog


def _thumb_index():
    """web/ 下所有图片的 basename / 主文件名 → 绝对路径，作为路径兜底索引。"""
    global _thumb_index
    if _thumb_index is None:
        index = {}
        for root, dirs, files in os.walk(WEB_DIR):
            dirs[:] = [d for d in dirs if d.lower() != "small"]
            for name in files:
                if not name.lower().endswith(_IMAGE_EXT):
                    continue
                full = os.path.join(root, name)
                key = name.lower()
                index.setdefault(key, full)
                index.setdefault(os.path.splitext(key)[0], full)
        _thumb_index = index
    return _thumb_index


def _resolve_path(item):
    """定位一张图片：先按清单路径，再按 id 猜扩展名，最后用文件名索引兜底。"""
    rel = str(item.get("thumb") or "").replace("\\", "/").lstrip("/")
    ident = str(item.get("id") or "").strip()
    base = os.path.basename(rel) if rel else ""
    stem = os.path.splitext(base)[0] if base else ident

    candidates = []
    if rel:
        parts = rel.split("/")
        candidates.append(os.path.join(WEB_DIR, *parts))
        candidates.append(os.path.join(NODE_DIR, *parts))
        candidates.append(os.path.join(THUMB_DIR, base))
    for name in (base, stem, ident):
        if not name:
            continue
        ext = os.path.splitext(name)[1]
        if ext:
            candidates.append(os.path.join(THUMB_DIR, name))
        else:
            for candidate_ext in _IMAGE_EXT:
                candidates.append(os.path.join(THUMB_DIR, name + candidate_ext))

    for path in candidates:
        if os.path.isfile(path):
            return path

    index = _thumb_index()
    for name in (base, ident + ".jpg", ident, stem):
        if not name:
            continue
        hit = index.get(name.lower())
        if hit:
            return hit
    return None


def _placeholder():
    """未选中 / 无法读取时的占位图（8×8 黑图），仅用于占位，不会被真正使用。"""
    global _PLACEHOLDER
    if _PLACEHOLDER is None:
        _PLACEHOLDER = torch.zeros((1, 8, 8, 3), dtype=torch.float32)
    return _PLACEHOLDER


def _load_image(item):
    path = _resolve_path(item)
    if path is None:
        raise FileNotFoundError(
            "找不到图片文件（清单 thumb=%r / id=%r；web/ 下共索引到 %d 张图）"
            % (item.get("thumb"), item.get("id"), len(_thumb_index()))
        )

    key = (path, os.path.getmtime(path))
    hit = _cache.get(key)
    if hit is not None:
        _cache.move_to_end(key)
        return hit

    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    if img.mode == "I":
        img = img.point(lambda v: v * (1 / 255))
    arr = np.asarray(img.convert("RGB")).astype(np.float32) / 255.0
    tensor = torch.from_numpy(np.ascontiguousarray(arr))[None, ...]

    _cache[key] = tensor
    if len(_cache) > _CACHE_LIMIT:
        _cache.popitem(last=False)
    return tensor


def _stack(tensors):
    """把多张图拼成一个 batch；尺寸不一致时按最大尺寸等比补到同一大小。"""
    if not tensors:
        return _placeholder()
    if len(tensors) == 1:
        return tensors[0]
    shapes = {tuple(t.shape[1:]) for t in tensors}
    if len(shapes) == 1:
        return torch.cat(tensors, dim=0)

    height = max(int(t.shape[1]) for t in tensors)
    width = max(int(t.shape[2]) for t in tensors)
    out = []
    for t in tensors:
        if t.shape[1] == height and t.shape[2] == width:
            out.append(t)
            continue
        x = t.permute(0, 3, 1, 2)
        x = F.interpolate(x, size=(height, width), mode="bilinear", align_corners=False)
        out.append(x.permute(0, 2, 3, 1))
    return torch.cat(out, dim=0)


# --------------------------------------------------------------------------
# 选中值的解析
# --------------------------------------------------------------------------

def _parse_selected(raw):
    """把节点上存的值解析为 id 列表，兼容 JSON 数组、逗号串、dict、以及直接写文件名。"""
    if raw is None:
        return []

    value = raw
    if isinstance(value, bytes):
        value = value.decode("utf-8", "ignore")

    if isinstance(value, str):
        text = value.strip()
        if not text or text in ("[]", "{}", "null", "None"):
            return []
        try:
            value = json.loads(text)
        except Exception:
            # 兼容 a,b / a;b / 换行 分隔，以及 ['a','b'] 这种单引号写法
            cleaned = text.strip().strip("[](){}").replace("'", '"').strip()
            try:
                value = json.loads("[" + cleaned + "]") if cleaned else []
                if not isinstance(value, list):
                    raise ValueError(value)
            except Exception:
                parts = text.replace("\n", ",").replace(";", ",").split(",")
                value = [p.strip() for p in parts if p.strip()]

    if isinstance(value, dict):
        value = value.get("ids") or value.get("selected") or value.get("items") or []

    # 解析后仍是字符串（例如双重编码的 JSON 字符串）：再解析一次
    if isinstance(value, (str, bytes)) and value != raw:
        return _parse_selected(value)
    if isinstance(value, (str, bytes)):
        return []
    if isinstance(value, (set, tuple)):
        value = list(value)
    if not isinstance(value, list):
        return []

    ids = []
    for entry in value:
        if isinstance(entry, dict):
            entry = entry.get("id") or entry.get("thumb") or entry.get("name")
        if entry is None:
            continue
        ident = str(entry).strip().strip('"').strip("'")
        if ident.lower().endswith(_IMAGE_EXT):
            ident = os.path.splitext(os.path.basename(ident.replace("\\", "/")))[0]
        if ident:
            ids.append(ident)
    return ids


# --------------------------------------------------------------------------
# 节点
# --------------------------------------------------------------------------

class PoseDBSelector:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "selected": (
                    "STRING",
                    {
                        "default": "[]",
                        "multiline": False,
                        "tooltip": "内部存储：选中图片 id 的 JSON 数组，点节点上的按钮修改",
                    },
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    # 槽 0 = images（整批），槽 1..32 = img1..img32
    RETURN_TYPES = ("IMAGE",) + tuple(["IMAGE"] * MAX_OUTPUTS)
    RETURN_NAMES = ("images",) + tuple("img%d" % (i + 1) for i in range(MAX_OUTPUTS))
    FUNCTION = "run"
    CATEGORY = "PoseDB"
    DESCRIPTION = (
        "内置 1439 张姿势参考图（300×400 JPG）：在节点面板里挑选，"
        "`images` 输出整批选中图（按勾选顺序，可接 SaveImage / ControlNet 批量），"
        "另外每选一张就多一个 imgN 输出。"
    )

    @classmethod
    def IS_CHANGED(cls, selected="[]", **kwargs):
        return str(selected)

    def run(self, selected="[]", **kwargs):
        ids = _parse_selected(selected)
        get_catalog()
        by_id = _catalog_by_id or {}

        slots = []          # 与勾选顺序对齐：张量或 None
        picked = []         # 成功读取的张量（按勾选顺序），用于 images 批量输出
        problems = []       # (id, 原因)

        for index in range(MAX_OUTPUTS):
            ident = ids[index] if index < len(ids) else None
            if not ident:
                slots.append(None)
                continue

            item = by_id.get(ident)
            if item is None:
                problems.append("%s（catalog.json 中没有这个 id）" % ident)
                slots.append(None)
                continue

            try:
                tensor = _load_image(item)
            except Exception as exc:
                problems.append("%s（%s）" % (ident, exc))
                slots.append(None)
                continue

            slots.append(tensor)
            picked.append(tensor)

        # 选了图却一张都读不出来 —— 直接报错，绝不静默吐 8×8 黑图
        if ids and not picked:
            raise RuntimeError(
                "PoseDB：选中的 %d 张图全部读取失败，已阻止输出 8×8 黑色占位图。\n"
                "  清单文件：%s\n"
                "  图片目录：%s（存在=%s，其中图片 %d 个）\n"
                "  首个失败项：%s"
                % (
                    len(ids),
                    CATALOG_PATH,
                    THUMB_DIR,
                    os.path.isdir(THUMB_DIR),
                    len(_thumb_index()),
                    problems[0] if problems else "(未知)",
                )
            )

        if problems:
            print("[PoseDB] 有 %d 张选中图无法读取：%s" % (len(problems), problems[:8]))
        if len(ids) > MAX_OUTPUTS:
            print("[PoseDB] 选择 %d 张，超出上限 %d，多余的已忽略" % (len(ids), MAX_OUTPUTS))

        batch = _stack(picked)
        outputs = [batch]
        outputs.extend(t if t is not None else _placeholder() for t in slots)
        return tuple(outputs)


NODE_CLASS_MAPPINGS = {"PoseDBSelector": PoseDBSelector}
NODE_DISPLAY_NAME_MAPPINGS = {"PoseDBSelector": "PoseDB 姿势图选择器"}
