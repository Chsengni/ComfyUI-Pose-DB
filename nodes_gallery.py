"""PoseDB 扩展节点（独立模块，新增而不改动原节点）。

包含三个节点：
    PoseDBCostumeSelector   服装选择器
    PoseDBPortraitSelector  人像选择器
    PoseDBCharacter         角色合成（人像 + 服装 + 姿势 → 三张参考图 + 提示词）

本模块自包含：不 import nodes.py、不修改 nodes.py 里的任何逻辑，
原来的「PoseDB 姿势图选择器」完全保持原样。
"""

import json
import os
from collections import OrderedDict

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps

NODE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(NODE_DIR, "web")

MAX_OUTPUTS = 32
_CACHE_LIMIT = 64

# 输出槽 0 固定为 images（整批选中图），槽 1 起为 img1、img2 …（前端保持同样约定）
IMAGES_SLOT = 0
IMG_OFFSET = 1

_IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".bmp")

# 三个内置图库：清单路径 + 图片目录 + 显示名
LIBS = {
    "pose": {
        "catalog": "catalog.json",
        "dir": "thumbs",
        "label": "姿势",
        "count": 1439,
    },
    "costume": {
        "catalog": "costume/catalog.json",
        "dir": "costume/thumbs",
        "label": "服装",
        "count": 1407,
    },
    "portrait": {
        "catalog": "portrait/catalog.json",
        "dir": "portrait/thumbs",
        "label": "人像",
        "count": 1499,
    },
}

_libs = {}                 # lib -> {"data": 原始 JSON, "items": [...], "by_id": {...}}
_cache = OrderedDict()
_PLACEHOLDER = None
_thumb_index = None


# --------------------------------------------------------------------------
# 图库清单 / 图片路径
# --------------------------------------------------------------------------

def _load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def get_lib(lib):
    """读取某个图库的清单：返回 {"data": 原始 JSON, "items": [...], "by_id": {...}}。"""
    if lib in _libs:
        return _libs[lib]

    conf = LIBS.get(lib)
    if conf is None:
        raise RuntimeError("PoseDB：未知图库 %r" % (lib,))

    path = os.path.join(WEB_DIR, *conf["catalog"].split("/"))
    if not os.path.isfile(path):
        raise RuntimeError(
            "PoseDB：找不到%s图库清单 %s，请确认节点包完整。" % (conf["label"], path)
        )
    data = _load_json(path)
    items = data.get("items", []) or []
    entry = {
        "data": data,
        "items": items,
        "by_id": {str(it.get("id")): it for it in items if it.get("id")},
    }
    _libs[lib] = entry
    return entry


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


def _resolve_path(item, lib="pose"):
    """定位一张图片：先按清单路径，再按 id 猜扩展名，最后用文件名索引兜底。"""
    rel = str(item.get("thumb") or "").replace("\\", "/").lstrip("/")
    ident = str(item.get("id") or "").strip()
    base = os.path.basename(rel) if rel else ""
    stem = os.path.splitext(base)[0] if base else ident

    lib_dir = os.path.join(WEB_DIR, *LIBS.get(lib, LIBS["pose"])["dir"].split("/"))

    candidates = []
    if rel:
        parts = rel.split("/")
        candidates.append(os.path.join(WEB_DIR, *parts))
        candidates.append(os.path.join(NODE_DIR, *parts))
        candidates.append(os.path.join(lib_dir, base))
    for name in (base, stem, ident):
        if not name:
            continue
        ext = os.path.splitext(name)[1]
        if ext:
            candidates.append(os.path.join(lib_dir, name))
        else:
            for candidate_ext in _IMAGE_EXT:
                candidates.append(os.path.join(lib_dir, name + candidate_ext))

    for path in candidates:
        if os.path.isfile(path):
            return path

    index = _thumb_index()
    for name in (base, ident + ".webp", ident + ".jpg", ident, stem):
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


def _load_image(item, lib="pose"):
    path = _resolve_path(item, lib)
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


def _parse_single(raw):
    ids = _parse_selected(raw)
    return ids[0] if ids else ""


# --------------------------------------------------------------------------
# 图库选择器（服装 / 人像共用一套逻辑）
# --------------------------------------------------------------------------

class _LibSelector:
    LIB = "costume"
    LABEL = "服装"

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

    @classmethod
    def IS_CHANGED(cls, selected="[]", **kwargs):
        return str(selected)

    def run(self, selected="[]", **kwargs):
        lib = self.LIB
        conf = LIBS[lib]
        ids = _parse_selected(selected)
        by_id = get_lib(lib)["by_id"]

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
                problems.append("%s（%s清单中没有这个 id）" % (ident, conf["label"]))
                slots.append(None)
                continue

            try:
                tensor = _load_image(item, lib)
            except Exception as exc:
                problems.append("%s（%s）" % (ident, exc))
                slots.append(None)
                continue

            slots.append(tensor)
            picked.append(tensor)

        # 选了图却一张都读不出来 —— 直接报错，绝不静默吐 8×8 黑图
        if ids and not picked:
            raise RuntimeError(
                "PoseDB：选中的 %d 张%s图全部读取失败，已阻止输出 8×8 黑色占位图。\n"
                "  清单文件：%s\n"
                "  图片目录：%s（存在=%s，其中图片 %d 个）\n"
                "  首个失败项：%s"
                % (
                    len(ids),
                    conf["label"],
                    os.path.join(WEB_DIR, *conf["catalog"].split("/")),
                    os.path.join(WEB_DIR, *conf["dir"].split("/")),
                    os.path.isdir(os.path.join(WEB_DIR, *conf["dir"].split("/"))),
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


class PoseDBCostumeSelector(_LibSelector):
    LIB = "costume"
    LABEL = "服装"
    DESCRIPTION = (
        "内置 1407 套服装穿搭参考图（360×540 WebP，8 个分类）："
        "`images` 输出整批选中图，另外每选一张就多一个 imgN 输出。"
    )


class PoseDBPortraitSelector(_LibSelector):
    LIB = "portrait"
    LABEL = "人像"
    DESCRIPTION = (
        "内置 1499 张 CC0 人像 / 发型参考图（400×500 WebP，正脸参考 + 造型氛围）："
        "`images` 输出整批选中图，另外每选一张就多一个 imgN 输出。"
    )


# --------------------------------------------------------------------------
# 角色合成节点：人像 + 服装 + 姿势 → 三张参考图 + 提示词
# --------------------------------------------------------------------------

DEFAULT_STYLE = "写实摄影风格，柔和自然光，浅景深，高清细节"

DEFAULT_TEMPLATE = """以图 1 的人物为角色原型，保留其面部特征与发型；穿上图 2 的整套服装；按照图 3 的姿势与镜头角度绘制。

【角色】{portrait_name}（发长：{portrait_hair}）
【服装】{outfit_name}
【姿势】{pose_name}（视角：{pose_angle}）
【风格】{style}

要求：
- 面部特征、发型与图 1 完全一致
- 服装的款式、颜色、材质与图 2 完全一致
- 身体比例、四肢位置、镜头角度与图 3 一致
- 单人全身像，干净背景，柔和自然光，高清细节，无文字无水印"""


class PoseDBCharacter:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "portrait_id": (
                    "STRING",
                    {"default": "", "multiline": False, "tooltip": "内部存储：选中的人像 id"},
                ),
                "outfit_id": (
                    "STRING",
                    {"default": "", "multiline": False, "tooltip": "内部存储：选中的服装 id"},
                ),
                "pose_id": (
                    "STRING",
                    {"default": "", "multiline": False, "tooltip": "内部存储：选中的姿势 id"},
                ),
                "style": (
                    "STRING",
                    {
                        "default": DEFAULT_STYLE,
                        "multiline": True,
                        "tooltip": "风格补充词，会填进提示词的 {style}",
                    },
                ),
                "template": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "自定义提示词模板；留空用内置模板。可用占位符："
                                   "{portrait_name} {portrait_hair} {portrait_section} "
                                   "{outfit_name} {outfit_cat} {outfit_kw} {outfit_tags} "
                                   "{pose_name} {pose_angle} {pose_cat} {pose_series} {style}",
                    },
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "STRING")
    RETURN_NAMES = ("头部", "服装", "姿势", "提示词")
    FUNCTION = "run"
    CATEGORY = "PoseDB"
    DESCRIPTION = (
        "三合一角色合成：分别选一张人像、一套服装、一个姿势，"
        "输出三张参考图 + 拼好的中文提示词（可直接接 CLIPTextEncode）。"
    )

    @classmethod
    def IS_CHANGED(cls, portrait_id="", outfit_id="", pose_id="", style="", template="", **kwargs):
        return "|".join([str(portrait_id), str(outfit_id), str(pose_id), str(style), str(template)])

    def run(self, portrait_id="", outfit_id="", pose_id="", style="", template="", **kwargs):
        picks = {
            "portrait": _parse_single(portrait_id),
            "costume": _parse_single(outfit_id),
            "pose": _parse_single(pose_id),
        }
        if not any(picks.values()):
            raise RuntimeError(
                "PoseDB 角色合成：还没有选择任何参考图。点节点上的「选择角色配方…」按钮，"
                "分别挑一张人像、一套服装、一个姿势。"
            )

        images = []
        items = {}
        missing = []
        for lib, ident in picks.items():
            label = LIBS[lib]["label"]
            item = None
            tensor = None
            if ident:
                item = get_lib(lib)["by_id"].get(ident)
                if item is None:
                    missing.append("%s（%s，清单里没有）" % (ident, label))
                else:
                    try:
                        tensor = _load_image(item, lib)
                    except Exception as exc:  # noqa: BLE001
                        missing.append("%s（%s，%s）" % (ident, label, exc))
            items[lib] = item
            images.append(tensor if tensor is not None else _placeholder())

        if missing:
            print("[PoseDB] 角色合成有 %d 项未能读取：%s" % (len(missing), missing))

        prompt = _build_prompt(items, style or "", template or "")
        return (images[0], images[1], images[2], prompt)


def _build_prompt(items, style, template):
    """按模板拼提示词；模板留空用内置模板，占位符缺失时留「未选」。"""
    portrait = items.get("portrait") or {}
    outfit = items.get("costume") or {}
    pose = items.get("pose") or {}

    values = {
        "portrait_name": portrait.get("name") or "未选",
        "portrait_hair": portrait.get("hair") or "未选",
        "portrait_section": portrait.get("section") or "未选",
        "outfit_name": outfit.get("name") or "未选",
        "outfit_cat": outfit.get("cat") or "未选",
        "outfit_kw": outfit.get("kw") or "",
        "outfit_tags": "、".join(outfit.get("tags") or []),
        "pose_name": pose.get("name") or "未选",
        "pose_angle": pose.get("angle") or "未选",
        "pose_cat": pose.get("cat") or "未选",
        "pose_series": pose.get("series") or "未选",
        "style": style or DEFAULT_STYLE,
    }

    tpl = (template or "").strip() or DEFAULT_TEMPLATE
    try:
        text = tpl.format(**values)
    except (KeyError, IndexError, ValueError) as exc:
        print("[PoseDB] 提示词模板占位符有问题（%s），改用内置模板" % (exc,))
        text = DEFAULT_TEMPLATE.format(**values)

    # 模板里若有一整行只剩「【xxx】」而没有内容（占位符为空时可能出现），去掉这行
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("【") and stripped.endswith("】"):
            continue
        lines.append(line.rstrip())
    return "\n".join(lines).strip()


NODE_CLASS_MAPPINGS = {
    "PoseDBCostumeSelector": PoseDBCostumeSelector,
    "PoseDBPortraitSelector": PoseDBPortraitSelector,
    "PoseDBCharacter": PoseDBCharacter,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PoseDBCostumeSelector": "PoseDB 服装选择器",
    "PoseDBPortraitSelector": "PoseDB 人像选择器",
    "PoseDBCharacter": "PoseDB 角色合成（人像+服装+姿势）",
}
