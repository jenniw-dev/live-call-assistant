"""mkdocs HTML → Markdown 转换工具（纯标准库，无三方依赖）。

用法：python scripts/html2md.py <file.html> [more.html ...]
输出：同目录同名 .md

只提取 mkdocs-material 的 md-content 正文，保留标题/列表/代码/表格结构，
跳过导航/侧栏/页脚等噪声。转换产物放入 data/knowledge 即可被 RAG 索引（rglob *.md）。
"""
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

SKIP_CLASSES = ("md-nav", "md-sidebar", "md-header", "md-footer", "md-dialog", "md-overlay", "md-source")
SKIP_TAGS = {"script", "style", "svg", "nav", "header", "footer"}


class _Md(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.skip = 0            # 基于 class/tag 的跳过深度
        self.in_pre = 0
        self.in_content = False
        self.stack: list[bool] = []   # 每层是否处于 skip 区

    def handle_starttag(self, tag, attrs):
        cls = dict(attrs).get("class", "")
        if not self.in_content:
            if tag == "div" and "md-content" in cls:
                self.in_content = True
            return
        if tag in SKIP_TAGS or any(c in cls for c in SKIP_CLASSES):
            self.skip += 1
            self.stack.append(True)
            return
        self.stack.append(False)
        if self.skip:
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self.out.append("\n\n" + "#" * int(tag[1]) + " ")
        elif tag == "li":
            self.out.append("\n- ")
        elif tag == "p":
            self.out.append("\n\n")
        elif tag == "br":
            self.out.append("\n")
        elif tag == "pre":
            self.in_pre += 1
            self.out.append("\n\n```\n")
        elif tag == "tr":
            self.out.append("\n|")
        elif tag in ("td", "th"):
            self.out.append(" ")
        elif tag in ("strong", "b"):
            self.out.append("**")
        elif tag in ("em", "i"):
            self.out.append("*")
        elif tag == "code" and not self.in_pre:
            self.out.append("`")

    def handle_endtag(self, tag):
        if not self.in_content:
            return
        if self.stack:
            skipped = self.stack.pop()
            if skipped:
                self.skip -= 1
                return
        if self.skip:
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6", "p"):
            self.out.append("\n")
        elif tag == "pre":
            self.in_pre = max(0, self.in_pre - 1)
            self.out.append("\n```\n")
        elif tag in ("td", "th"):
            self.out.append(" |")
        elif tag in ("strong", "b"):
            self.out.append("**")
        elif tag in ("em", "i"):
            self.out.append("*")
        elif tag == "code" and not self.in_pre:
            self.out.append("`")

    def handle_data(self, data):
        if not self.in_content or self.skip:
            return
        t = data if self.in_pre else re.sub(r"\s+", " ", data)
        if t.strip():
            self.out.append(t)


def convert(path: Path) -> str:
    p = _Md()
    p.feed(path.read_text(encoding="utf-8"))
    text = re.sub(r"\n{3,}", "\n\n", "".join(p.out))
    return text.strip() + "\n"


if __name__ == "__main__":
    for f in sys.argv[1:]:
        src = Path(f)
        dst = src.with_suffix(".md")
        md = convert(src)
        dst.write_text(md, encoding="utf-8")
        print(f"{src.name} -> {dst.name} ({len(md)} chars)")
