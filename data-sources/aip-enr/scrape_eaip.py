"""Scrape eAIP ENAIRE para generar aip-data.json automaticamente.

Sustituye a parse_aip.py (que dependia de PDFs descargados a mano y de un
layout fragil). Aqui descargamos directamente las paginas HTML del eAIP que
ENAIRE publica sin login:

  ENR 3.2 -> aerovias (lista ordenada de waypoints + FL inferior/superior)
  ENR 4.1 -> radioayudas (NAVAIDs: VOR/DME/TACAN/NDB)
  ENR 4.4 -> designadores RNAV de 5 letras (POPUL, NEPAL, ESPOR, ...)

La salida es el mismo aip-data.json que esperaba parse_aip.py, asi que
embed_aip.py funciona sin cambios.
"""

import argparse
import io
import json
import os
import re
import sys
import urllib.request

from bs4 import BeautifulSoup, NavigableString

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_JSON = os.path.join(HERE, "aip-data.json")

BASE = "https://aip.enaire.es/AIP/contenido_AIP/ENR"
URLS = {
    "ENR_3_2": f"{BASE}/LE_ENR_3_2_es.html",
    "ENR_4_1": f"{BASE}/LE_ENR_4_1_es.html",
    "ENR_4_4": f"{BASE}/LE_ENR_4_4_es.html",
}

# Coords DDMMSS[.x][N|S] DDDMMSS[.x][E|W]
RE_COORD = re.compile(
    r"(\d{2})(\d{2})(\d{2}(?:\.\d+)?)([NS])\s*(\d{3})(\d{2})(\d{2}(?:\.\d+)?)([EW])"
)
RE_AIRAC = re.compile(r"WEF\s+\d{2}-[A-Z]{3}-\d{2}", re.IGNORECASE)
# El AIRAC actual aparece en <span class="nuevo">WEF DD-MMM-YY</span> en la
# cabecera; la version "viejo" es el AIRAC anterior y aparece justo despues.
# Tambien hay "WEF 10-OCT-74" insertado como id legacy en algunos atributos.
RE_AIRAC_NUEVO = re.compile(
    r'<span[^>]*class=\"[^\"]*\bnuevo\b[^\"]*\"[^>]*>(WEF\s+\d{2}-[A-Z]{3}-\d{2})</span>',
    re.IGNORECASE,
)
RE_FL    = re.compile(r"FL\s*0*(\d{2,3})", re.IGNORECASE)


def fetch(url, cache_dir=None):
    """GET url, opcionalmente cacheando en disco para iteracion local."""
    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)
        cache = os.path.join(cache_dir, url.rsplit("/", 1)[-1])
        if os.path.exists(cache):
            with io.open(cache, "r", encoding="utf-8") as f:
                return f.read()
    req = urllib.request.Request(url, headers={"User-Agent": "TSAgestor-AIP-bot/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read().decode("utf-8", errors="replace")
    if cache_dir:
        with io.open(cache, "w", encoding="utf-8") as f:
            f.write(body)
    return body


def dms_to_dec(d, m, s, hemi):
    val = float(d) + float(m) / 60.0 + float(s) / 3600.0
    if hemi in ("S", "W"):
        val = -val
    return round(val, 5)


def parse_coord(text):
    """Extrae primera lat/lon DDMMSS de un bloque de texto. None si no hay."""
    if not text:
        return None
    m = RE_COORD.search(text)
    if not m:
        return None
    lat = dms_to_dec(m.group(1), m.group(2), m.group(3), m.group(4))
    lon = dms_to_dec(m.group(5), m.group(6), m.group(7), m.group(8))
    return lat, lon


def text_of(node):
    """innerText con saltos de linea preservados (br -> \\n)."""
    if node is None:
        return ""
    parts = []
    for el in node.descendants:
        if isinstance(el, NavigableString):
            parts.append(str(el))
        elif el.name == "br":
            parts.append("\n")
    s = "".join(parts)
    return re.sub(r"[ \t]+", " ", s).strip()


def find_airac(html):
    """Devuelve el AIRAC actual. Prefiere <span class="nuevo">WEF...</span>
    (es el ciclo que entra en vigor); si no existe cae al primer WEF que
    encuentre, salvo el "WEF 10-OCT-74" que aparece como id legacy."""
    m = RE_AIRAC_NUEVO.search(html)
    if m:
        return m.group(1).upper()
    for m in RE_AIRAC.finditer(html):
        s = m.group(0).upper()
        if s != "WEF 10-OCT-74":
            return s
    return None


# ---------------------------------------------------------------------------
# ENR 4.1 - NAVAIDs (VOR/DME/TACAN/NDB)
# ---------------------------------------------------------------------------

def parse_enr_4_1(html):
    """{id: {lat, lon, type, name}} para NAVAIDs."""
    soup = BeautifulSoup(html, "html.parser")
    out = {}
    for table in soup.select("table.ENR41"):
        for tr in table.select("tbody tr"):
            name_cell  = tr.find(class_=re.compile(r"\bcelNAME\b"))
            ident_cell = tr.find(class_=re.compile(r"\bcelIDENT\b"))
            coord_cell = tr.find(class_=re.compile(r"\bcelCOORD\b"))
            if not (name_cell and ident_cell and coord_cell):
                continue
            wid  = text_of(ident_cell)
            full = text_of(name_cell)
            coord = parse_coord(text_of(coord_cell))
            if not wid or not coord or not re.match(r"^[A-Z]{2,5}$", wid):
                continue
            # name = primera linea de celNAME (la siguiente es el TIPO)
            lines = [ln.strip() for ln in full.split("\n") if ln.strip()]
            name = lines[0] if lines else wid
            if wid not in out:
                out[wid] = {"lat": coord[0], "lon": coord[1], "type": "NAVAID", "name": name}
    return out


# ---------------------------------------------------------------------------
# ENR 4.4 - Designadores RNAV
# ---------------------------------------------------------------------------

def parse_enr_4_4(html):
    """{id: {lat, lon, type:'RNAV', name=id}}"""
    soup = BeautifulSoup(html, "html.parser")
    out = {}
    for table in soup.select("table.ENR44"):
        for tr in table.select("tbody tr"):
            ident = tr.find(class_=re.compile(r"\bcelIDENT\b"))
            coord = tr.find(class_=re.compile(r"\bcelCOORDS\b"))
            if not (ident and coord):
                continue
            wid = text_of(ident).strip()
            if not re.match(r"^[A-Z]{5}$", wid):
                continue
            c = parse_coord(text_of(coord))
            if not c:
                continue
            if wid not in out:
                out[wid] = {"lat": c[0], "lon": c[1], "type": "RNAV", "name": wid}
    return out


# ---------------------------------------------------------------------------
# ENR 3.2 - Aerovias
# ---------------------------------------------------------------------------

# El nombre del waypoint en ENR 3.2 suele aparecer como:
#   "VILLANUEVA NDB (VNV)"     -> id VNV, type NAVAID, name VILLANUEVA NDB
#   "POPUL"                    -> id POPUL, type RNAV (5 letras puras)
RE_PUNTO_NAVAID = re.compile(r"\(([A-Z]{2,5})\)")
RE_PUNTO_RNAV   = re.compile(r"\b([A-Z]{5})\b")


RE_AIRWAY_NAME = re.compile(
    r"^(?:[ABGHJLMNQRTVWYZ]\d{1,4}[A-Z]?|U[A-Z]\d{1,4}[A-Z]?)$"
)


def parse_enr_3_2(html):
    """Lista de aerovias con name + waypoints[ids] + lowerFL/upperFL.
    Tambien devuelve un diccionario complementario de waypoints (con coords
    extraidas inline) por si alguno no aparece en ENR 4.1/4.4.

    En el HTML real, TODAS las aerovias estan dentro de una unica
    <table class="ENR3X"> y se separan por una fila cabecera
    <th class="celNomRuta">{NOMBRE}</th>. Iteramos filas y abrimos un nuevo
    bloque cada vez que vemos una de esas cabeceras.
    """
    soup = BeautifulSoup(html, "html.parser")
    airways = []
    extra_wps = {}

    def finalize(cur):
        if not cur or not cur["waypoints"]:
            return
        clean = []
        for w in cur["waypoints"]:
            if not clean or clean[-1] != w:
                clean.append(w)
        if len(clean) < 2:
            return
        flow = cur["lowerFL"]
        fhi  = cur["upperFL"]
        cat = "upper" if (flow is not None and flow >= 195) else "lower"
        airways.append({
            "name":      cur["name"],
            "category":  cat,
            "waypoints": clean,
            "lowerFL":   flow,
            "upperFL":   fhi,
        })

    cur = None
    for table in soup.select("table.ENR3X"):
        for tr in table.select("tbody > tr"):
            # Fila de cabecera de aerovia? <th class="celNomRuta">L14</th>
            head_th = tr.find("th", class_=re.compile(r"\bcelNomRuta\b"))
            if head_th:
                txt = text_of(head_th).strip()
                if RE_AIRWAY_NAME.match(txt):
                    finalize(cur)
                    cur = {"name": txt, "waypoints": [], "lowerFL": None, "upperFL": None}
                    continue
                # cabecera "Designador de ruta" del thead, ignorar
                continue

            if cur is None:
                continue

            # Fila de waypoint: celTipoPunto (▲/∆) + celPuntosNombre
            tipo = tr.find(class_=re.compile(r"\bcelTipoPunto\b"))
            if tipo:
                puntos = tr.find(class_=re.compile(r"\bcelPuntosNombre\b"))
                if not puntos:
                    continue
                txt = text_of(puntos)
                coord = parse_coord(txt)
                wid = None; wtype = None; wname = None
                m = RE_PUNTO_NAVAID.search(txt)
                if m:
                    wid = m.group(1); wtype = "NAVAID"
                    wname = txt[: m.start()].strip().splitlines()[0].strip()
                else:
                    for tok in re.findall(r"[A-Z]{5}", txt):
                        wid = tok; wtype = "RNAV"; wname = tok; break
                if wid:
                    cur["waypoints"].append(wid)
                    if coord and wid not in extra_wps:
                        extra_wps[wid] = {
                            "lat": coord[0], "lon": coord[1],
                            "type": wtype or "RNAV",
                            "name": wname or wid,
                        }
                continue

            # Fila de segmento: celRNP + celVL (FL min/max del tramo)
            rnp = tr.find(class_=re.compile(r"\bcelRNP\b"))
            if rnp:
                vl = tr.find(class_=re.compile(r"\bcelVL\b"))
                if vl:
                    fls = [int(m.group(1)) for m in RE_FL.finditer(text_of(vl))]
                    if fls:
                        up = max(fls); lo = min(fls)
                        cur["lowerFL"] = lo if cur["lowerFL"] is None else min(cur["lowerFL"], lo)
                        cur["upperFL"] = up if cur["upperFL"] is None else max(cur["upperFL"], up)

    finalize(cur)
    return airways, extra_wps


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache-dir", default=None,
                    help="Si se da, usa/escribe HTML cacheado para no rebajar ENAIRE en cada iteracion.")
    ap.add_argument("--out", default=OUT_JSON)
    args = ap.parse_args()

    print("[scrape] descargando ENR 3.2 / 4.1 / 4.4 de ENAIRE...", file=sys.stderr)
    try:
        htmls = {k: fetch(u, args.cache_dir) for k, u in URLS.items()}
    except Exception as e:
        # Errores HTTP / DNS / timeouts: salimos limpiamente con codigo no
        # cero para que el workflow falle el step y no comitee nada.
        print(f"[scrape] FALLO descargando eAIP: {e}", file=sys.stderr)
        sys.exit(1)
    airac = find_airac(htmls["ENR_3_2"]) or find_airac(htmls["ENR_4_1"]) or find_airac(htmls["ENR_4_4"])
    print(f"[scrape] AIRAC: {airac}", file=sys.stderr)

    waypoints = {}
    waypoints.update(parse_enr_4_1(htmls["ENR_4_1"]))
    print(f"[scrape] NAVAIDs ENR 4.1: {len(waypoints)}", file=sys.stderr)
    rnav = parse_enr_4_4(htmls["ENR_4_4"])
    print(f"[scrape] RNAV fixes ENR 4.4: {len(rnav)}", file=sys.stderr)
    for k, v in rnav.items():
        if k not in waypoints:
            waypoints[k] = v

    airways, extra = parse_enr_3_2(htmls["ENR_3_2"])
    for k, v in extra.items():
        if k not in waypoints:
            waypoints[k] = v
    print(f"[scrape] aerovias ENR 3.2: {len(airways)} (waypoints inline extra: {len(extra)})", file=sys.stderr)

    by_cat = {}
    for a in airways:
        by_cat[a["category"]] = by_cat.get(a["category"], 0) + 1
    print(f"[scrape] por categoria: {by_cat}", file=sys.stderr)

    out = {
        "source":   "AIP Espana - eAIP ENAIRE (ENR 3.2 + 4.1 + 4.4) [scraper]",
        "airac":    airac,
        "generated_from": list(URLS.values()),
        "waypoints": waypoints,
        "airways":  airways,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1, sort_keys=False)
    size_kb = os.path.getsize(args.out) / 1024
    print(f"[scrape] escrito {args.out} ({size_kb:.1f} KB)", file=sys.stderr)


if __name__ == "__main__":
    main()
