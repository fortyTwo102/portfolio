#!/usr/bin/env python3
"""Build the portfolio into dist/.

Reads everything under content/ (written by the admin view), converts uploaded
files (Word, PDF, Markdown, text) into web pages, and writes a static site that
Cloudflare Pages serves. Run locally with:  python build.py
"""
from __future__ import annotations

import datetime as dt
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml
from jinja2 import Environment, FileSystemLoader, select_autoescape
from markdown_it import MarkdownIt

ROOT = Path(__file__).resolve().parent
CONTENT = Path(os.environ.get("CONTENT_DIR", ROOT / "content"))
PUBLIC = Path(os.environ.get("PUBLIC_DIR", ROOT / "public"))
TEMPLATES = ROOT / "templates"
DIST = Path(os.environ.get("OUT_DIR", ROOT / "dist"))
SITE_URL = os.environ.get("SITE_URL", "https://ammara-younas.pages.dev").rstrip("/")

# Section slugs live at the site root, so these names are taken.
RESERVED = {"admin", "api", "work", "for", "about", "search", "files", "assets", "r", "404", "index"}

PDF_RENDER_WIDTH = 1400  # pixels; pages display at up to ~700 CSS px on retina screens
PDF_MAX_PAGES = 60

WARNINGS: list[str] = []


def warn(msg: str) -> None:
    WARNINGS.append(msg)
    print(f"WARNING: {msg}", file=sys.stderr)


# ---------------------------------------------------------------- reading ---

FM_RE = re.compile(r"\A---[ \t]*\r?\n(.*?)(?:\r?\n)?---[ \t]*(?:\r?\n|\Z)(.*)\Z", re.S)


LINE_RE = re.compile(r"^([A-Za-z0-9_]+):[ \t]?(.*)$")


def parse_fields(block: str) -> dict:
    """The admin writes one `key: <JSON value>` per line (valid YAML too).
    Parse that directly; fall back to a full YAML parser for hand-edited files."""
    data = {}
    for line in block.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = LINE_RE.match(line)
        if not m:
            break
        raw = m.group(2).strip()
        try:
            data[m.group(1)] = json.loads(raw) if raw else ""
        except ValueError:
            break
    else:
        return data
    data = yaml.safe_load(block) or {}
    if not isinstance(data, dict):
        raise ValueError("front matter is not a key/value block")
    return data


def read_doc(path: Path) -> tuple[dict, str]:
    text = path.read_text(encoding="utf-8")
    m = FM_RE.match(text)
    if not m:
        return {}, text.strip()
    return parse_fields(m.group(1)), m.group(2).strip()


def as_str(v) -> str:
    if v is None:
        return ""
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()[:10]
    return str(v).strip()


def as_list(v) -> list:
    if v is None or v == "":
        return []
    if isinstance(v, list):
        return v
    return [v]


def as_bool(v, default=False) -> bool:
    if v is None or v == "":
        return default
    if isinstance(v, str):
        return v.strip().lower() in {"true", "yes", "1", "on"}
    return bool(v)


def as_int(v, default=0) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


MONTHS = ["January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December"]


def parse_date(s: str) -> tuple[int, int, int]:
    """'2024', '2024-03' or '2024-03-09' -> sortable tuple (0 for unknown parts)."""
    m = re.match(r"^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?", s or "")
    if not m:
        return (0, 0, 0)
    return (int(m.group(1)), int(m.group(2) or 0), int(m.group(3) or 0))


def format_date(s: str) -> str:
    y, mo, _ = parse_date(s)
    if not y:
        return s or ""
    if 1 <= mo <= 12:
        return f"{MONTHS[mo - 1]} {y}"
    return str(y)


def format_range(start: str, end: str) -> str:
    a = format_date(start)
    b = format_date(end) if end else "present"
    return f"{a} – {b}" if a else b


def load_settings() -> dict:
    path = CONTENT / "settings.yml"
    data = {}
    if path.exists():
        data = parse_fields(path.read_text(encoding="utf-8"))
    else:
        warn("content/settings.yml is missing; using defaults")
    s = {
        "name": as_str(data.get("name")) or "Ammara Younas",
        "kicker": as_str(data.get("kicker")),
        "headline": as_str(data.get("headline")),
        "intro": as_str(data.get("intro")),
        "results": [as_str(x) for x in as_list(data.get("results")) if as_str(x)],
        "about": as_str(data.get("about")),
        "location": as_str(data.get("location")),
        "email": as_str(data.get("email")),
        "phone": as_str(data.get("phone")),
        "linkedin": as_str(data.get("linkedin")),
        "photo": as_str(data.get("photo")),
        "cv": as_str(data.get("cv")),
        "skills": [as_str(x) for x in as_list(data.get("skills")) if as_str(x)],
        "education": [e for e in as_list(data.get("education")) if isinstance(e, dict)],
        "description": as_str(data.get("description")),
        "footnote": as_str(data.get("footnote")),
    }
    s["facts"] = [split_fact(r) for r in s["results"]]
    return s


FACT_RE = re.compile(r"^((?:[$£€]?\d[\d,.]*\s?(?:%|x|k|m)?\+?))\s+(.+)$", re.I)


def split_fact(text: str) -> dict:
    """'180%+ organic traffic growth' -> big figure '180%+' and caption; plain lines keep no figure."""
    m = FACT_RE.match(text)
    return {"figure": m.group(1), "caption": m.group(2)} if m else {"figure": "", "caption": text}


def load_collection(folder: str) -> list[tuple[str, dict, str]]:
    out = []
    d = CONTENT / folder
    if not d.exists():
        return out
    for path in sorted(d.glob("*.md")):
        try:
            data, body = read_doc(path)
        except Exception as e:  # noqa: BLE001 - report and skip one bad file
            warn(f"{path.relative_to(CONTENT)} could not be read ({e}); skipped")
            continue
        out.append((path.stem, data, body))
    return out


def load_sections() -> dict[str, dict]:
    sections = {}
    for slug, d, body in load_collection("sections"):
        if slug in RESERVED:
            warn(f"section slug '{slug}' is reserved; skipped")
            continue
        sections[slug] = {
            "slug": slug,
            "title": as_str(d.get("title")) or slug.replace("-", " ").capitalize(),
            "navLabel": as_str(d.get("navLabel")) or as_str(d.get("title")) or slug,
            "label": as_str(d.get("label")),
            "summary": as_str(d.get("summary")),
            "cta": as_str(d.get("cta")) or "See the work",
            "layout": "cards" if as_str(d.get("layout")) == "cards" else "list",
            # The introduction is the file's body; older files kept it in "description".
            "intro": body or as_str(d.get("description")),
            "description": as_str(d.get("summary")) or as_str(d.get("description")) or body.split("\n")[0],
            "order": as_int(d.get("order"), 99),
            "visible": as_bool(d.get("visible"), True),
            "lineBreaks": as_bool(d.get("lineBreaks"), False),
            "url": f"/{slug}/",
        }
    return dict(sorted(sections.items(), key=lambda kv: (kv[1]["order"], kv[1]["title"])))


def load_jobs() -> dict[str, dict]:
    jobs = {}
    for slug, d, _ in load_collection("jobs"):
        jobs[slug] = {
            "slug": slug,
            "title": as_str(d.get("title")),
            "company": as_str(d.get("company")),
            "shortName": as_str(d.get("shortName")) or as_str(d.get("company")),
            "location": as_str(d.get("location")),
            "type": as_str(d.get("type")),
            "start": as_str(d.get("start")),
            "end": as_str(d.get("end")),
            "order": as_int(d.get("order"), 99),
            "highlights": [as_str(x) for x in as_list(d.get("highlights")) if as_str(x)],
        }
        jobs[slug]["dates"] = format_range(jobs[slug]["start"], jobs[slug]["end"])
    # Current role first, then most recent start.
    return dict(sorted(jobs.items(), key=lambda kv: (kv[1]["end"] != "", tuple(-x for x in parse_date(kv[1]["start"])), kv[1]["order"])))


def load_focus() -> dict[str, dict]:
    focus = {}
    for slug, d, body in load_collection("focus"):
        focus[slug] = {
            "slug": slug,
            "title": as_str(d.get("title")) or slug,
            "order": as_int(d.get("order"), 99),
            "sections": [as_str(x) for x in as_list(d.get("sections"))],
            "pinned": [as_str(x) for x in as_list(d.get("pinned"))],
            "cv": as_str(d.get("cv")),
            "highlights": [as_str(x) for x in as_list(d.get("highlights")) if as_str(x)],
            "intro": body,
            "url": f"/for/{slug}/",
        }
    return dict(sorted(focus.items(), key=lambda kv: kv[1]["order"]))


def load_pieces(sections: dict, jobs: dict) -> list[dict]:
    pieces = []
    for slug, d, body in load_collection("pieces"):
        visibility = as_str(d.get("visibility")) or "public"
        if visibility not in {"public", "unlisted", "draft"}:
            visibility = "public"
        if visibility == "draft":
            continue
        secs = [s for s in (as_str(x) for x in as_list(d.get("sections"))) if s]
        known = [s for s in secs if s in sections]
        for s in secs:
            if s not in sections:
                warn(f"piece '{slug}' refers to unknown section '{s}'")
        job = jobs.get(as_str(d.get("job")))
        company = as_str(d.get("company")) or (job["shortName"] if job else "")
        date = as_str(d.get("date"))
        y, _, _ = parse_date(date)
        type_ = as_str(d.get("type"))
        line_breaks = d.get("lineBreaks")
        if line_breaks is None or line_breaks == "":
            line_breaks = any(sections[s]["lineBreaks"] for s in known)
        p = {
            "slug": slug,
            "url": f"/work/{slug}/",
            "title": as_str(d.get("title")) or slug,
            "sections": known,
            "type": type_,
            "place": as_str(d.get("place")),
            "topics": [as_str(t) for t in as_list(d.get("topics")) if as_str(t)],
            "date": date,
            "dateLabel": format_date(date),
            "year": str(y) if y else "",
            "sortDate": parse_date(date),
            "job": job,
            "company": company,
            "tags": [as_str(t) for t in as_list(d.get("tags")) if as_str(t)],
            "summary": as_str(d.get("summary")),
            "brief": as_str(d.get("brief")),
            "role": as_str(d.get("role")) or (job["title"] if job else ""),
            "result": as_str(d.get("result")),
            "featured": as_bool(d.get("featured")),
            # No order = 0, so new pieces list first (newest first), then the numbered ones in order.
            "order": as_int(d.get("order"), 0),
            "visibility": visibility,
            "lineBreaks": as_bool(line_breaks),
            "files": [f for f in as_list(d.get("files")) if isinstance(f, dict) and as_str(f.get("path"))],
            "links": [l for l in as_list(d.get("links")) if isinstance(l, dict) and as_str(l.get("url"))],
            "body": body,
        }
        pieces.append(p)
    pieces.sort(key=lambda p: (p["order"], tuple(-x for x in p["sortDate"]), p["title"].lower()))
    return pieces


# ------------------------------------------------------------- converting ---

def markdown(text: str, breaks: bool = False) -> str:
    md = MarkdownIt("commonmark", {"html": True, "breaks": breaks, "typographer": True})
    md.enable(["table", "strikethrough", "replacements", "smartquotes"])
    return md.render(text or "")


def plain_text_html(text: str) -> str:
    return f'<div class="plain">{html.escape(text.strip())}</div>'


def find_pandoc() -> str | None:
    p = shutil.which("pandoc")
    if p:
        return p
    try:
        import pypandoc  # type: ignore

        return pypandoc.get_pandoc_path()
    except Exception:  # noqa: BLE001
        return None


def docx_with_pandoc(src: Path, media_dir: Path, media_url: str) -> str | None:
    pandoc = find_pandoc()
    if not pandoc or os.environ.get("NO_PANDOC"):
        return None
    with tempfile.TemporaryDirectory() as tmp:
        tmp_media = Path(tmp) / "m"
        r = subprocess.run(
            [pandoc, str(src), "-f", "docx", "-t", "html5", "--wrap=none", f"--extract-media={tmp_media}"],
            capture_output=True, text=True, timeout=180,
        )
        if r.returncode != 0:
            warn(f"pandoc could not convert {src.name}: {r.stderr.strip()[:200]}")
            return None
        out = r.stdout
        if tmp_media.exists():
            for f in tmp_media.rglob("*"):
                if f.is_file():
                    rel = f.relative_to(tmp_media)
                    dest = media_dir / rel
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(f, dest)
            out = out.replace(str(tmp_media), media_url)
        # Word sets fixed image sizes; let the stylesheet size images instead.
        out = re.sub(r'\sstyle="(?:width|height):[^"]*"', "", out)
        return out


def docx_with_python_docx(src: Path) -> str:
    """Plain fallback when pandoc is unavailable: headings, paragraphs, lists, bold/italic, links, tables."""
    import docx  # type: ignore
    from docx.oxml.ns import qn  # type: ignore

    document = docx.Document(str(src))
    parts: list[str] = []
    list_open: str | None = None

    def runs_html(par) -> str:
        out = []
        for child in par._p.iterchildren():
            if child.tag == qn("w:r"):
                out.append(run_html(docx.text.run.Run(child, par)))
            elif child.tag == qn("w:hyperlink"):
                rid = child.get(qn("r:id"))
                href = ""
                if rid and rid in par.part.rels:
                    href = par.part.rels[rid].target_ref
                inner = "".join(run_html(docx.text.run.Run(r, par)) for r in child.iterchildren(qn("w:r")))
                out.append(f'<a href="{html.escape(href)}">{inner}</a>' if href else inner)
        return "".join(out)

    def run_html(run) -> str:
        t = html.escape(run.text or "")
        if not t:
            return ""
        if run.bold:
            t = f"<strong>{t}</strong>"
        if run.italic:
            t = f"<em>{t}</em>"
        return t

    def close_list():
        nonlocal list_open
        if list_open:
            parts.append(f"</{list_open}>")
            list_open = None

    body = document.element.body
    for child in body.iterchildren():
        if child.tag == qn("w:p"):
            par = docx.text.paragraph.Paragraph(child, document)
            style = (par.style.name if par.style is not None else "") or ""
            text = runs_html(par).strip()
            is_list = "List" in style or child.find(".//" + qn("w:numPr")) is not None
            if is_list and text:
                kind = "ol" if "Number" in style else "ul"
                if list_open != kind:
                    close_list()
                    parts.append(f"<{kind}>")
                    list_open = kind
                parts.append(f"<li>{text}</li>")
                continue
            close_list()
            if not text:
                continue
            m = re.match(r"Heading (\d)", style)
            if style == "Title":
                parts.append(f"<h2>{text}</h2>")
            elif m:
                level = min(int(m.group(1)) + 1, 6)
                parts.append(f"<h{level}>{text}</h{level}>")
            elif style.startswith("Quote") or style.startswith("Intense Quote"):
                parts.append(f"<blockquote><p>{text}</p></blockquote>")
            else:
                parts.append(f"<p>{text}</p>")
        elif child.tag == qn("w:tbl"):
            close_list()
            table = docx.table.Table(child, document)
            rows = []
            for row in table.rows:
                cells = "".join(f"<td>{html.escape(c.text)}</td>" for c in row.cells)
                rows.append(f"<tr>{cells}</tr>")
            parts.append("<table>" + "".join(rows) + "</table>")
    close_list()
    return "\n".join(parts)


def convert_docx(src: Path, media_dir: Path, media_url: str) -> str:
    out = docx_with_pandoc(src, media_dir, media_url)
    if out is None:
        out = docx_with_python_docx(src)
    return out


def convert_pdf(src: Path, out_dir: Path, url_prefix: str) -> dict:
    import pypdfium2 as pdfium  # type: ignore

    out_dir.mkdir(parents=True, exist_ok=True)
    pdf = pdfium.PdfDocument(str(src))
    pages, texts = [], []
    total = len(pdf)
    stem = re.sub(r"[^a-z0-9]+", "-", src.stem.lower()).strip("-") or "file"
    for i in range(min(total, PDF_MAX_PAGES)):
        page = pdf[i]
        w_pt = page.get_width() or 612
        scale = min(PDF_RENDER_WIDTH / w_pt, 3.0)
        img = page.render(scale=scale).to_pil()
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        name = f"{stem}-{i + 1}.webp"
        img.save(out_dir / name, "WEBP", quality=80, method=4)
        pages.append({"src": f"{url_prefix}/{name}", "w": img.width, "h": img.height})
        try:
            tp = page.get_textpage()
            texts.append(tp.get_text_range().strip())
            tp.close()
        except Exception:  # noqa: BLE001
            texts.append("")
        page.close()
    pdf.close()
    text = "\n\n".join(t for t in texts if t)
    return {"pages": pages, "pageCount": total, "truncated": total > PDF_MAX_PAGES, "text": text}


def strip_tags(s: str) -> str:
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", s, flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def human_size(n) -> str:
    try:
        n = int(n)
    except (TypeError, ValueError):
        return ""
    for unit in ("bytes", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "bytes" else f"{n:.1f} {unit}"
        n /= 1024
    return ""


FILE_KINDS = {".pdf": "pdf", ".docx": "docx", ".md": "md", ".markdown": "md", ".txt": "txt"}
KIND_LABEL = {"pdf": "PDF", "docx": "Word document", "md": "Markdown file", "txt": "text file", "other": "file"}


def link_item(link: dict) -> dict:
    url = as_str(link.get("url"))
    image = as_str(link.get("image"))
    return {
        "url": url,
        "title": as_str(link.get("title")) or url,
        "description": as_str(link.get("description")),
        "site": as_str(link.get("site")) or re.sub(r"^www\.", "", re.sub(r"^https?://([^/]+).*$", r"\1", url)),
        "image": image if image.startswith("https://") else "",
        "archive": as_str(link.get("archive")),
    }


def group_links(items: list[dict]) -> list[dict]:
    """Many links sharing a few captions (Canada / USA) read best as labelled groups."""
    captions = [i["description"] for i in items]
    distinct = list(dict.fromkeys(captions))
    if len(items) >= 6 and all(captions) and 1 < len(distinct) <= 3 and all(captions.count(c) >= 2 for c in distinct):
        return [{"label": c, "items": [i for i in items if i["description"] == c]} for c in distinct]
    return []


def render_piece(p: dict) -> None:
    """Fill p['parts'] with renderable blocks and p['searchText'] with plain text."""
    parts, texts = [], []
    if p["body"]:
        body_html = markdown(p["body"], p["lineBreaks"])
        parts.append({"kind": "html", "html": body_html, "keepLines": p["lineBreaks"]})
        texts.append(strip_tags(body_html))
    items = [link_item(l) for l in p["links"]]
    texts += [" ".join([i["title"], i["description"]]) for i in items]
    if len(items) == 1:
        parts.append({"kind": "link", **items[0]})
    elif items:
        parts.append({"kind": "links", "items": items, "groups": group_links(items)})
    p["linkItems"] = items
    for f in p["files"]:
        rel = as_str(f.get("path")).lstrip("/")
        src = PUBLIC / rel
        name = as_str(f.get("name")) or Path(rel).name
        kind = FILE_KINDS.get(src.suffix.lower(), "other")
        info = {"url": "/" + rel, "name": name, "kind": kind, "kindLabel": KIND_LABEL[kind], "size": human_size(f.get("size") or (src.stat().st_size if src.exists() else 0))}
        if not src.exists():
            warn(f"piece '{p['slug']}' lists a missing file: {rel}")
            continue
        render_dir = DIST / "r" / p["slug"]
        render_url = f"/r/{p['slug']}"
        try:
            if kind == "pdf":
                r = convert_pdf(src, render_dir, render_url)
                parts.append({"kind": "pdf", "file": info, **r})
                texts.append(r["text"])
            elif kind == "docx":
                stem = re.sub(r"[^a-z0-9]+", "-", src.stem.lower()).strip("-") or "doc"
                h = convert_docx(src, render_dir / stem, f"{render_url}/{stem}")
                parts.append({"kind": "html", "html": h, "file": info, "keepLines": p["lineBreaks"]})
                texts.append(strip_tags(h))
            elif kind == "md":
                h = markdown(src.read_text(encoding="utf-8", errors="replace"), p["lineBreaks"])
                parts.append({"kind": "html", "html": h, "file": info, "keepLines": p["lineBreaks"]})
                texts.append(strip_tags(h))
            elif kind == "txt":
                t = src.read_text(encoding="utf-8", errors="replace")
                parts.append({"kind": "html", "html": plain_text_html(t), "file": info, "keepLines": True})
                texts.append(t)
            else:
                parts.append({"kind": "download", "file": info})
        except Exception as e:  # noqa: BLE001 - one broken file must not break the site
            warn(f"could not convert {rel} for piece '{p['slug']}': {e}")
            parts.append({"kind": "download", "file": info})
    p["parts"] = parts
    p["searchText"] = re.sub(r"\s+", " ", " ".join(texts)).strip()
    p["wordCount"] = len(p["searchText"].split())


# --------------------------------------------------------------- building ---

def build() -> None:
    settings = load_settings()
    sections = load_sections()
    jobs = load_jobs()
    focus = load_focus()
    pieces = load_pieces(sections, jobs)

    if DIST.exists():
        shutil.rmtree(DIST)
    shutil.copytree(PUBLIC, DIST)

    for p in pieces:
        render_piece(p)

    public = [p for p in pieces if p["visibility"] == "public"]
    by_slug = {p["slug"]: p for p in pieces}
    for s in sections.values():
        s["pieces"] = [p for p in public if s["slug"] in p["sections"]]
    nav_sections = [s for s in sections.values() if s["visible"] and s["pieces"]]

    featured = sorted([p for p in public if p["featured"]], key=lambda p: (p["order"], tuple(-x for x in p["sortDate"])))
    featured = featured[:6]

    commit = os.environ.get("CF_PAGES_COMMIT_SHA", "")
    build_id = (commit or hashlib.sha1(str(dt.datetime.now().timestamp()).encode()).hexdigest())[:10]

    env = Environment(loader=FileSystemLoader(TEMPLATES), autoescape=select_autoescape(["html", "xml"]), trim_blocks=True, lstrip_blocks=True)
    env.filters["markdown"] = markdown
    env.globals.update(
        site=settings, site_url=SITE_URL, nav_sections=nav_sections, sections=sections,
        jobs=list(jobs.values()), focus_pages=list(focus.values()), year=dt.date.today().year,
        asset_version=build_id, format_date=format_date,
    )

    def write(path: str, template: str, **ctx) -> None:
        out = DIST / path.lstrip("/")
        if path.endswith("/"):
            out = out / "index.html"
        out.parent.mkdir(parents=True, exist_ok=True)
        ctx.setdefault("path", path)
        out.write_text(env.get_template(template).render(**ctx), encoding="utf-8")

    write("/", "home.html", featured=featured, public_count=len(public))
    write("/about/", "about.html")
    write("/search/", "search.html")
    write("/404.html", "404.html")

    for s in sections.values():
        if not s["pieces"]:
            continue
        ps = s["pieces"]
        filters = {
            "place": sorted({p["place"] for p in ps if p["place"]}),
            "type": sorted({p["type"] for p in ps if p["type"]}),
            "company": sorted({p["company"] for p in ps if p["company"]}),
            "year": sorted({p["year"] for p in ps if p["year"]}, reverse=True),
        }
        seen = [t for p in ps for t in p["topics"]]
        topics = sorted(dict.fromkeys(seen), key=lambda t: (-seen.count(t), seen.index(t)))
        # Details every piece in the section shares are left out of its list (the heading already says them).
        common = {k for k in ("type", "company") if len({p[k] for p in ps}) == 1}
        show_filters = s["layout"] == "list" and len(ps) > 5 and (len(topics) > 1 or any(len(v) > 1 for v in filters.values()))
        visible = [x for x in nav_sections]
        nxt = visible[(visible.index(s) + 1) % len(visible)] if s in visible and len(visible) > 1 else None
        write(s["url"], "section.html", section=s, filters=filters, topics=topics, show_filters=show_filters,
              common=common, next_section=nxt)

    for p in pieces:
        first = sections.get(p["sections"][0]) if p["sections"] else None
        related = [q for q in public if q is not p and first and first["slug"] in q["sections"]][:3]
        write(p["url"], "piece.html", piece=p, section=first, related=related)

    for f in focus.values():
        pinned = [by_slug[s] for s in f["pinned"] if s in by_slug]
        pinned_set = {p["slug"] for p in pinned}
        more = [p for p in public if p["slug"] not in pinned_set and set(p["sections"]) & set(f["sections"])][:12]
        if not pinned:
            pinned, more = more[:6], more[6:]
        write(f["url"], "focus.html", focus=f, pinned=pinned, more=more)

    # Search index: public pieces only.
    index = [{
        "u": p["url"], "t": p["title"], "s": p["summary"], "ty": p["type"], "c": p["company"], "d": p["dateLabel"],
        "sec": [sections[s]["title"] for s in p["sections"]], "tg": p["tags"] + p["topics"] + ([p["place"]] if p["place"] else []),
        "x": p["searchText"][:6000],
    } for p in public]
    (DIST / "search-index.json").write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")

    urls = ["/", "/about/"] + [s["url"] for s in nav_sections] + [f["url"] for f in focus.values()] + [p["url"] for p in public]
    sitemap = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    sitemap += [f"  <url><loc>{html.escape(SITE_URL + u)}</loc></url>" for u in urls]
    sitemap.append("</urlset>")
    (DIST / "sitemap.xml").write_text("\n".join(sitemap) + "\n", encoding="utf-8")
    (DIST / "robots.txt").write_text(f"User-agent: *\nDisallow: /admin/\nDisallow: /api/\n\nSitemap: {SITE_URL}/sitemap.xml\n", encoding="utf-8")

    (DIST / "build.json").write_text(json.dumps({
        "commit": commit,
        "builtAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "pieces": len(public),
        "warnings": WARNINGS,
    }, indent=2), encoding="utf-8")

    print(f"Built {len(public)} public pieces, {len(pieces) - len(public)} unlisted, "
          f"{len(nav_sections)} sections, {len(focus)} focus pages into {DIST}")
    if WARNINGS:
        print(f"{len(WARNINGS)} warning(s); see above.")


if __name__ == "__main__":
    build()
