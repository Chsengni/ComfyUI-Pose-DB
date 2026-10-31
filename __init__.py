from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# 新增节点放在独立模块 nodes_gallery.py 里，原 nodes.py 一行不动。
# 合并失败也不影响原来的姿势图选择器。
try:
    from .nodes_gallery import NODE_CLASS_MAPPINGS as _EXTRA_CLASS_MAPPINGS
    from .nodes_gallery import NODE_DISPLAY_NAME_MAPPINGS as _EXTRA_DISPLAY_NAME_MAPPINGS

    NODE_CLASS_MAPPINGS = {**NODE_CLASS_MAPPINGS, **_EXTRA_CLASS_MAPPINGS}
    NODE_DISPLAY_NAME_MAPPINGS = {**NODE_DISPLAY_NAME_MAPPINGS, **_EXTRA_DISPLAY_NAME_MAPPINGS}
except Exception as _exc:  # pragma: no cover
    print("[PoseDB] 扩展节点（服装/人像/角色合成）加载失败，已跳过：%r" % (_exc,))

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
