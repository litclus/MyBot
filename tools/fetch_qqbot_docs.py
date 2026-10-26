#!/usr/bin/env python3
"""把 QQ 机器人官方文档（开发文档 / api-v2 部分）抓取为本地 Markdown。

用法：
    python tools/fetch_qqbot_docs.py

依赖：markdownify、beautifulsoup4（pip install markdownify beautifulsoup4）

输出：
    docs/api-v2/**.md      与线上路径一一对应的 Markdown 文档
    docs/README.md         目录索引
    docs/index.json        机器可读的页面索引（标题、路径、原文、标题层级）
"""

from __future__ import annotations

import datetime as dt
import json
import posixpath
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from bs4 import BeautifulSoup
from markdownify import MarkdownConverter

BASE = "https://bot.q.qq.com"
SITE_PREFIX = "/wiki"
SECTION = "/wiki/develop/api-v2/"
SITEMAP = BASE + "/wiki/sitemap.xml"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "docs"
DOCS_PREFIX = "api-v2"  # 输出到 docs/api-v2/ 下
WORKERS = 4


def fetch(url: str, retries: int = 4) -> str:
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": UA,
                    "Accept": "text/html,application/xhtml+xml",
                    "Accept-Language": "zh-CN,zh;q=0.9",
                },
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
            return raw.decode("utf-8", errors="replace")
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"抓取失败 {url}: {last}")


def normalize(url: str) -> str | None:
    """规范化站内链接；只保留 api-v2 下的 HTML 页面。"""
    url = url.split("#", 1)[0].split("?", 1)[0]
    if not url:
        return None
    if not url.startswith(BASE):
        return None
    if not url.startswith(BASE + SECTION):
        return None
    if url.endswith("/"):
        url += "index.html"
    if not url.endswith(".html"):
        return None
    return url


def url_to_rel_md(url: str) -> str:
    """https://bot.q.qq.com/wiki/develop/api-v2/a/b.html -> api-v2/a/b.md"""
    path = url.split(BASE, 1)[-1].split("?", 1)[0].split("#", 1)[0]
    path = path[len(SITE_PREFIX):]  # -> /develop/api-v2/a/b.html
    if path.endswith("/"):
        path += "index.html"
    if path.endswith(".html"):
        path = path[: -len(".html")]
    path = path.lstrip("/")
    if path.startswith("develop/"):
        path = path[len("develop/"):]
    return f"{path}.md"


def rel_link(from_rel: str, to_rel: str) -> str:
    start = posixpath.dirname(from_rel) or "."
    return posixpath.relpath(to_rel, start=start)


def rewrite_href(href: str, current_rel: str) -> str | None:
    if href.startswith(("#", "mailto:", "javascript:")):
        return None
    anchor = ""
    if "#" in href:
        href, rest = href.split("#", 1)
        anchor = "#" + rest
    absolute = urllib.parse.urljoin(BASE + "/", href)
    if absolute.startswith(BASE + SECTION):
        return rel_link(current_rel, url_to_rel_md(absolute)) + anchor
    if href.startswith("/"):
        return BASE + href + anchor
    return None


def make_converter(current_rel: str) -> MarkdownConverter:
    class Conv(MarkdownConverter):
        def convert_a(self, el, text, parent_tags=None):
            href = el.get("href")
            if href:
                new = rewrite_href(href, current_rel)
                if new is not None:
                    el["href"] = new
            return super().convert_a(el, text, parent_tags)

        def convert_img(self, el, text, parent_tags=None):
            src = el.get("src") or ""
            if src.startswith("data:"):
                return ""  # 二维码等内联图片，丢弃
            if src.startswith("/"):
                el["src"] = BASE + src
            return super().convert_img(el, text, parent_tags)

        def convert_pre(self, el, text, parent_tags=None):
            code = el.find("code")
            lang = ""
            for node in (code, el):
                if node is None or lang:
                    continue
                for cls in node.get("class") or []:
                    if cls.startswith("language-") and cls != "language-":
                        lang = cls[len("language-"):]
                        break
            body = (code.get_text() if code is not None else el.get_text()).rstrip("\n")
            return f"\n\n```{lang}\n{body}\n```\n\n"

    return Conv(
        heading_style="ATX",
        bullets="-",
        escape_underscores=False,
        escape_asterisks=False,
        strong_em_symbol="*",
        newline_style="SPACES",
    )


def clean_content(content: BeautifulSoup) -> BeautifulSoup:
    for a in content.select("a.header-anchor"):
        a.decompose()
    for sp in content.select("span.sr-only"):
        # VuePress 给外链加的 "(opens new window)"
        sp.decompose()
    for el in content.select(".line-numbers-wrapper"):
        el.decompose()
    for el in content.select("div.line-numbers-mode"):
        el["class"] = [c for c in el.get("class", []) if c != "line-numbers-mode"]

    # 提示块 -> 引用块
    for div in content.select("div.custom-block"):
        bq = content.new_tag("blockquote")
        title = div.select_one(".custom-block-title")
        if title is not None:
            text = title.get_text(" ", strip=True)
            if text:
                p = content.new_tag("p")
                strong = content.new_tag("strong")
                strong.string = text
                p.append(strong)
                bq.append(p)
            title.decompose()
        for child in list(div.contents):
            bq.append(child.extract())
        div.replace_with(bq)

    for iframe in content.select("iframe"):
        iframe.replace_with(content.new_string("> [内嵌视频/页面，请见线上原文]"))
    return content


def extract_title(soup: BeautifulSoup) -> str:
    h1 = soup.select_one("div.theme-default-content h1")
    if h1:
        text = h1.get_text(" ", strip=True).lstrip("#").strip()
        if text:
            return text
    if soup.title:
        return soup.title.get_text(strip=True).split("|")[0].strip()
    return "未命名"


def convert_page(url: str) -> tuple[dict, list[str]]:
    rel = url_to_rel_md(url)
    html = fetch(url)
    soup = BeautifulSoup(html, "html.parser")
    title = extract_title(soup)
    content = soup.select_one("div.theme-default-content")
    if content is None:
        raise RuntimeError(f"未找到正文: {url}")
    updated_el = soup.select_one(".last-updated .time")
    updated = updated_el.get_text(strip=True) if updated_el else ""

    # 站内链接（正文 + 侧边栏）用于发现 sitemap 之外的页面（如 autogen）
    found: list[str] = []
    for a in soup.select("div.theme-default-content a[href], aside.sidebar a[href]"):
        n = normalize(urllib.parse.urljoin(url, a["href"]))
        if n:
            found.append(n)

    headings = [
        h.get_text(" ", strip=True).lstrip("#").strip()
        for h in content.select("h1, h2, h3")
    ]

    content = clean_content(content)
    body = make_converter(rel).convert_soup(content)
    body = body.replace("\xa0", " ")
    body = re.sub(r"\n{3,}", "\n\n", body).strip()
    body = re.sub(r"^#\s+.*\n+", "", body, count=1)

    fm = [
        "---",
        f'title: "{title}"',
        f'source: "{url}"',
        f'last_updated: "{updated}"',
        "---",
        "",
    ]
    head = f"# {title}\n\n> 原文：{url}" + (f"（最后更新：{updated}）" if updated else "") + "\n\n"
    text = "\n".join(fm) + head + body.strip() + "\n"

    target = OUT_DIR / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8", newline="\n")
    return {
        "url": url,
        "rel": rel,
        "title": title,
        "updated": updated,
        "chars": len(text),
        "headings": headings,
    }, found


def build_index(pages: list[dict]) -> None:
    today = dt.date.today().isoformat()
    groups: dict[str, list[dict]] = {}
    for p in pages:
        sub = posixpath.dirname(p["rel"])[len(DOCS_PREFIX):].lstrip("/") or "."
        groups.setdefault(sub, []).append(p)

    section_names = {
        "dev-prepare": "起步指南",
        "server-inter": "服务端接口",
        "autogen": "接口与事件参考（自动生成）",
        "gateway": "网关",
        "openapi": "开放接口",
    }

    def pretty(sub: str) -> str:
        if sub == ".":
            return "根目录"
        head, _, tail = sub.partition("/")
        name = section_names.get(head, head)
        return f"{name} / {tail}" if tail else name

    lines = [
        "# QQ 机器人开发文档（本地镜像）",
        "",
        f"- 抓取自：<{BASE}/wiki/develop/api-v2/>",
        f"- 抓取时间：{today}",
        f"- 页面数量：{len(pages)}",
        "",
        "内容版权归腾讯 QQ 开放平台所有，此目录仅作离线查阅用途。原文如有更新，以线上为准。",
        "",
        "重新抓取：`python tools/fetch_qqbot_docs.py`",
        "",
        "## 目录",
        "",
    ]
    for sub in sorted(groups, key=lambda s: (s != ".", s)):
        lines.append(f"### {pretty(sub)}")
        lines.append("")
        for p in sorted(groups[sub], key=lambda x: x["rel"]):
            lines.append(f"- [{p['title']}]({p['rel']})")
        lines.append("")
    (OUT_DIR / "README.md").write_text("\n".join(lines), encoding="utf-8", newline="\n")

    meta = {
        "source": BASE + "/wiki/develop/api-v2/",
        "generated": today,
        "count": len(pages),
        "pages": [
            {
                "title": p["title"],
                "path": p["rel"],
                "url": p["url"],
                "last_updated": p["updated"],
                "headings": p["headings"],
            }
            for p in sorted(pages, key=lambda x: x["rel"])
        ],
    }
    (OUT_DIR / "index.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n"
    )


def discover() -> list[str]:
    xml = fetch(SITEMAP)
    seeds = [u.strip() for u in re.findall(r"<loc>([^<]+)</loc>", xml) if SECTION in u]
    seeds.append(BASE + SECTION)
    return [s for s in (normalize(u) for u in seeds) if s]


def main() -> None:
    seen: set[str] = set()
    pending = list(dict.fromkeys(discover()))
    pages: list[dict] = []
    failed: list[str] = []
    print(f"初始页面 {len(pending)} 个，开始抓取…")

    while pending:
        batch = [u for u in pending if u not in seen][: WORKERS * 2]
        pending = [u for u in pending if u not in seen and u not in batch]
        for u in batch:
            seen.add(u)
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            results = list(pool.map(lambda u: (u, *safe_convert(u)), batch))
        fresh = 0
        for url, info, found, err in results:
            if err:
                failed.append(url)
                print(f" fail {url}: {err}")
                continue
            pages.append(info)
            print(f"  ok  {info['rel']}  ({info['chars']} 字)")
            for n in found:
                if n not in seen and n not in pending:
                    pending.append(n)
                    fresh += 1
        print(f"— 本轮完成，新增待抓 {fresh}，累计成功 {len(pages)} —")

    build_index(sorted(pages, key=lambda p: p["rel"]))
    print(f"完成：成功 {len(pages)}，失败 {len(failed)}")
    for f in failed:
        print("  失败:", f)
    if failed:
        sys.exit(1)


def safe_convert(url: str):
    try:
        info, found = convert_page(url)
        return info, found, None
    except Exception as exc:  # noqa: BLE001
        return None, [], exc


if __name__ == "__main__":
    main()
