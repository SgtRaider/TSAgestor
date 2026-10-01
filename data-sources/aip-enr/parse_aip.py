"""
Parser del AIP ESPANA - ENR 3.2 (Rutas RNAV) + ENR 4.1 (Radioayudas).
Solo dependencias de la libreria estandar de Python 3.

Entrada: ENR_3_2.txt y ENR_4_1.txt (extraidos con `pdftotext -layout`).
Salida:  aip-data.json con shape:
  {
    "airac":    "WEF 16-APR-26",
    "waypoints": { "POPUL": {"lat":43.948, "lon":-2.840, "type":"RNAV"|"NAVAID", "name":"..."}, ... },
    "airways":  [
      { "name":"L14", "category":"upper"|"lower",
        "waypoints":["POPUL","BLV","AMTOS","NEA","ZANKO","RIDAV","ADINO"],
        "lowerFL": 145, "upperFL": 660 },
      ...
    ]
  }

Nota: los segmentos individuales con track/dist/limites no se extraen porque
son derivables de las coordenadas + reglas estandar. Lo que importa para el
mapa es la geometria (waypoints en orden) y la categoria (lower/upper)
por nivel del segmento mas representativo.
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENR32_TXT = os.path.join(HERE, "ENR_3_2.txt")
ENR41_TXT = os.path.join(HERE, "ENR_4_1.txt")
OUT_JSON  = os.path.join(HERE, "aip-data.json")

# --- Patrones --------------------------------------------------------------

# Coordenada DDMMSS[N|S] DDDMMSS[E|W]  (con o sin sufijo decimal opcional).
RE_COORD = re.compile(
    r"(?P<lat>(\d{2})(\d{2})(\d{2}(?:\.\d+)?))(?P<latH>[NS])\s+"
    r"(?P<lon>(\d{3})(\d{2})(\d{2}(?:\.\d+)?))(?P<lonH>[EW])"
)

# Designador de aerovia: una linea con tan solo el codigo (L2, UN733, M601...).
# ICAO usa prefijos {A,B,G,H,J,L,M,N,Q,R,T,V,W,Y,Z} para low y U+letra para upper.
# Excluimos F* explicitamente para no confundir con "FL###" (continuacion de
# segmento) y otras palabras administrativas que puedan quedar aisladas.
RE_AIRWAY = re.compile(
    r"^\s*("
    r"[ABGHJLMNQRTVWYZ]\d{1,4}[A-Z]?"
    r"|U[ABGHJLMNRTVWYZ]\d{1,4}[A-Z]?"
    r")\s*$"
)

# Lineas de cabecera/pie a ignorar:
RE_HEADER_FOOTER = re.compile(
    r"^(AIP|ESPA|AIS|Designador de ruta|/  REP obligatorio|TR MAG|"
    r"\(NM\)|NAV\b|NAVEGACI|WEF \d|AIRAC AMDT)",
    re.IGNORECASE,
)

# Linea de tramo (NAV TR DIST FL... PRECISION ASC). Empieza por RNAV# o CNAV.
RE_SEG = re.compile(r"^\s*(RNAV\d|CNAV|RNP\d)\b")

# Niveles FL### o "12500 ft AMSL".
RE_FL = re.compile(r"\bFL(\d{2,3})\b")

# Identificador en parentesis (BLV, MHN, VJF...). 2-5 letras mayusculas.
RE_PARENS_ID = re.compile(r"\(([A-Z]{2,5})\)")

# --- Utilidades ------------------------------------------------------------

def dms_to_decimal(dms_str, hemi):
    """43°56'55"N -> 43.948..., desde texto puro."""
    if len(dms_str.split('.')[0]) == 6:  # lat: DDMMSS
        d = int(dms_str[0:2])
        m = int(dms_str[2:4])
        s = float(dms_str[4:])
    else:                                # lon: DDDMMSS
        d = int(dms_str[0:3])
        m = int(dms_str[3:5])
        s = float(dms_str[5:])
    val = d + m / 60.0 + s / 3600.0
    if hemi in ('S', 'W'):
        val = -val
    return round(val, 5)

def normalize_text(line):
    """Conservamos ASCII y rango Latin-1 (para que se mantengan tildes y N).
    Cualquier otro char (control, smart quotes, etc.) -> espacio."""
    out = []
    for ch in line:
        o = ord(ch)
        if ch == '\n' or 32 <= o < 127 or 160 <= o <= 255:
            out.append(ch)
        else:
            out.append(' ')
    return ''.join(out)

def looks_like_name_line(stripped_line):
    """Filtro: una linea es candidata a nombre de waypoint si en la zona del
    fix (primera columna) hay o bien un token mayuscula de 5 letras (RNAV
    nombrado) o bien '(XYZ)' (NAVAID con su ID). Rechazamos lineas que solo
    contienen continuaciones de segmento (AMSL, ACC, FL095, MSL, AGL...) y
    cualquier linea de observaciones (las observaciones llevan minusculas;
    los nombres de waypoint nunca)."""
    if not stripped_line:
        return False
    first = re.split(r"\s{3,}", stripped_line, maxsplit=1)[0].strip()
    if not first:
        return False
    # En la zona del fix (cols ~0-30, lo que va antes del primer hueco grande)
    # nunca hay minusculas. Las observaciones tipo "Requiere aprobacion..."
    # tienen minusculas y deben filtrarse aqui.
    if re.search(r"[a-z]", first):
        return False
    if re.search(r"\([A-Z]{2,5}\)", first):
        return True
    # 5-letras puro (no permitir 3-4 que matchean ACC, AMSL, etc.)
    for tok in first.split():
        if re.match(r"^[A-ZÑÁÉÍÓÚ]{5}$", tok):
            return True
    return False


def extract_fix_name(text_above_coord):
    """Dado el texto de las lineas arriba del coord, extrae el ID canonico
    del waypoint.

    El layout del AIP separa la columna del FIX (izquierda, ~col 5-32) de la
    columna de REFERENCIA geografica (derecha, ~col 35+). El separador es
    siempre un hueco de 3+ espacios.

    Estrategia: para cada linea de nombre, partir por '\\s{3,}' y quedarnos
    SOLO con la primera parte (zona del fix). Despues unir todas las primeras
    partes (porque algunos nombres de navaid ocupan dos lineas).
    Sobre el resultado:
       - si aparece '(XYZ)' es un NAVAID -> ID = XYZ.
       - si no, la primera palabra alfabetica de 3-5 letras es un fix RNAV.
    """
    fix_parts = []
    for ln in text_above_coord:
        # Quitar indentacion delante para que el split por hueco interior sea fiable.
        stripped = ln.lstrip()
        if not stripped:
            continue
        first = re.split(r"\s{3,}", stripped, maxsplit=1)[0].strip()
        if first:
            fix_parts.append(first)

    if not fix_parts:
        return None, None, None
    fix_text = ' '.join(fix_parts)

    # Navaid: contiene '(XYZ)' en el bloque del fix.
    m = RE_PARENS_ID.search(fix_text)
    if m:
        wid = m.group(1)
        full = fix_text[:m.start()].strip()
        full = re.sub(
            r"\s+(D?VOR(?:/DME)?|DME|TACAN|NDB|VOR/DME|L)\s*$",
            "",
            full,
        )
        return wid, full.strip() or wid, "NAVAID"

    # Fix RNAV: primera palabra de 3-5 letras mayusculas (puras).
    for tok in fix_text.split():
        if re.match(r"^[A-Z]{3,5}$", tok):
            return tok, tok, "RNAV"
    return None, None, None


# --- Parser principal ENR 3.2 ----------------------------------------------

def parse_enr_3_2():
    with open(ENR32_TXT, "r", encoding="utf-8", errors="replace") as f:
        raw_lines = f.readlines()

    lines = [normalize_text(ln).rstrip() for ln in raw_lines]

    waypoints = {}  # id -> {lat, lon, type, name}
    airways = []    # [{name, waypoints:[id], lowerFL, upperFL, segments:[{lowerFL,upperFL}]}]
    airac = None

    # Buscar fecha AIRAC en las primeras lineas:
    for ln in lines[:30]:
        m = re.search(r"(WEF \d{2}-[A-Z]{3}-\d{2})", ln)
        if m:
            airac = m.group(1)
            break

    cur_airway = None              # objeto airway en construccion
    pending_name_lines = []        # lineas vistas que pueden contener el nombre del proximo waypoint
    last_segment = None            # ultimo segmento parseado, para asociarlo al siguiente waypoint

    def flush_airway():
        nonlocal cur_airway
        if cur_airway and cur_airway["waypoints"]:
            # Calcular lower/upper FL globales como min(lowerFL) / max(upperFL) de los segmentos.
            segs = cur_airway.get("segments", [])
            if segs:
                lows = [s["lowerFL"] for s in segs if s.get("lowerFL") is not None]
                highs = [s["upperFL"] for s in segs if s.get("upperFL") is not None]
                cur_airway["lowerFL"] = min(lows) if lows else None
                cur_airway["upperFL"] = max(highs) if highs else None
            airways.append(cur_airway)
        cur_airway = None

    for raw_ln in lines:
        ln = raw_ln

        if RE_HEADER_FOOTER.match(ln):
            pending_name_lines = []
            continue

        # Salto de linea vacia: no resetea el contexto pero avisa de cambio de bloque.
        if not ln.strip():
            continue

        # Designador de aerovia? Solo cuando NO hay otra cosa en la linea.
        am = RE_AIRWAY.match(ln)
        if am:
            flush_airway()
            cur_airway = {
                "name": am.group(1),
                "waypoints": [],
                "segments": [],
                "lowerFL": None, "upperFL": None,
            }
            pending_name_lines = []
            last_segment = None
            continue

        # Linea de coordenadas?
        cm = RE_COORD.search(ln)
        if cm:
            lat = dms_to_decimal(cm.group("lat"), cm.group("latH"))
            lon = dms_to_decimal(cm.group("lon"), cm.group("lonH"))
            wid, name, kind = extract_fix_name(pending_name_lines)
            pending_name_lines = []
            if not wid:
                # No supimos extraer nombre - probable continuacion de pagina.
                continue
            # Registramos waypoint global (la primera vez que aparece).
            if wid not in waypoints:
                waypoints[wid] = {"lat": lat, "lon": lon, "type": kind, "name": name}
            else:
                # Si la version anterior tenia coords distintas (p.ej. mismo
                # ID en distintos paises), preferimos las primeras.
                pass
            if cur_airway is not None:
                cur_airway["waypoints"].append(wid)
                if last_segment is not None:
                    cur_airway["segments"].append(last_segment)
                    last_segment = None
            continue

        # Linea de segmento?
        if RE_SEG.match(ln):
            fls = RE_FL.findall(ln)
            seg = {"lowerFL": None, "upperFL": None}
            if len(fls) == 1:
                # El otro FL viene en la siguiente linea no vacia (continuacion).
                seg["upperFL"] = int(fls[0])
            elif len(fls) >= 2:
                seg["upperFL"] = int(fls[0])
                seg["lowerFL"] = int(fls[1])
            last_segment = seg
            pending_name_lines = []
            continue

        # Linea de continuacion del segmento previo: contiene FL de cierre.
        if last_segment is not None and last_segment.get("lowerFL") is None:
            fls = RE_FL.findall(ln)
            if fls:
                last_segment["lowerFL"] = int(fls[0])
                continue

        # Linea de observacion "(1) Tramo ...": ignorar.
        if re.match(r"^\s*\(\d+\)\s", ln):
            pending_name_lines = []
            continue

        # Cualquier otra linea con texto: posible parte del nombre del proximo waypoint.
        # Filtramos para descartar continuaciones de segmento (AMSL, ACC, ...).
        if looks_like_name_line(ln.lstrip()):
            pending_name_lines.append(ln)
            if len(pending_name_lines) > 3:
                pending_name_lines = pending_name_lines[-3:]

    flush_airway()

    return airac, waypoints, airways


# --- Refuerzo opcional con ENR 4.1 (mejora nombres de NAVAIDs) -------------

def parse_enr_4_1(waypoints):
    """Pasada complementaria sobre ENR 4.1 para enriquecer/corregir
    coordenadas de NAVAIDs (suelen estar mas precisas en 4.1)."""
    if not os.path.exists(ENR41_TXT):
        return
    with open(ENR41_TXT, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    text = normalize_text(text)
    # En 4.1 cada navaid tiene un ID tipo "TAB", "VAB", "VES" cerca de freq y
    # coords debajo. Hacemos una pasada burda: por cada coord, buscamos el ID
    # mas cercano arriba.
    lines = text.splitlines()
    enriched = 0
    for i, ln in enumerate(lines):
        # Coordenada?
        cm = RE_COORD.search(ln)
        if cm:
            # Buscamos un ID conocido en las 4 lineas previas.
            for j in range(max(0, i - 4), i + 1):
                # ID candidato: 2-5 letras mayusculas aisladas (con espacios alrededor).
                for tok in re.findall(r"\b([A-Z]{2,5})\b", lines[j]):
                    # Filtrar palabras comunes que no son IDs.
                    if tok in {"AIP", "ESPA", "ENR", "MHz", "kHz", "AIS", "FREQ", "COORD",
                               "VAR", "NDB", "VOR", "DME", "TACAN", "DVOR", "OBSERVA",
                               "FRA", "IAD", "HR", "ID", "KM"}:
                        continue
                    if tok in waypoints and waypoints[tok]["type"] == "NAVAID":
                        lat = dms_to_decimal(cm.group("lat"), cm.group("latH"))
                        lon = dms_to_decimal(cm.group("lon"), cm.group("lonH"))
                        # Solo refrescamos si hay diferencia <1 grado (mismo navaid).
                        cur = waypoints[tok]
                        if abs(cur["lat"] - lat) < 1.0 and abs(cur["lon"] - lon) < 1.0:
                            cur["lat"] = lat
                            cur["lon"] = lon
                            enriched += 1
                        break
    print(f"  ENR 4.1: refinadas {enriched} coordenadas de navaids", file=sys.stderr)


# --- Categorizacion lower/upper --------------------------------------------

def categorize(airway):
    """upper si lowerFL >= 195 (FL195 = base del UTA en Espana), lower si no."""
    low = airway.get("lowerFL")
    if low is None:
        return "unknown"
    return "upper" if low >= 195 else "lower"


# --- Main ------------------------------------------------------------------

def main():
    print("Parseando ENR 3.2...", file=sys.stderr)
    airac, waypoints, airways = parse_enr_3_2()
    print(f"  Aerovias: {len(airways)}, waypoints unicos: {len(waypoints)}", file=sys.stderr)

    print("Refinando con ENR 4.1...", file=sys.stderr)
    parse_enr_4_1(waypoints)

    # Categorizar y limpiar segmentos (no los exportamos, solo los usamos para FL).
    out_airways = []
    for aw in airways:
        # Quitar duplicados consecutivos en waypoints (pueden venir de continuaciones).
        clean = []
        for w in aw["waypoints"]:
            if not clean or clean[-1] != w:
                clean.append(w)
        if len(clean) < 2:
            continue
        out_airways.append({
            "name": aw["name"],
            "category": categorize(aw),
            "waypoints": clean,
            "lowerFL": aw.get("lowerFL"),
            "upperFL": aw.get("upperFL"),
        })

    # Estadisticas:
    by_cat = {}
    for aw in out_airways:
        by_cat[aw["category"]] = by_cat.get(aw["category"], 0) + 1
    print(f"  Por categoria: {by_cat}", file=sys.stderr)

    out = {
        "source":   "AIP Espana - ENR 3.2 + ENR 4.1 (parser propio TSAgestor)",
        "airac":    airac,
        "generated_from": ["ENR_3_2.pdf", "ENR_4_1.pdf"],
        "waypoints": waypoints,
        "airways":  out_airways,
    }

    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1, sort_keys=False)

    size_kb = os.path.getsize(OUT_JSON) / 1024
    print(f"Escrito {OUT_JSON} ({size_kb:.1f} KB)", file=sys.stderr)


if __name__ == "__main__":
    main()
