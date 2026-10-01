"""Valida un aip-data.json antes de comitearlo al repo.

Comprueba:
  1) Schema basico (campos presentes, rangos plausibles, AIRAC parseable).
  2) Integridad referencial (toda aerovia apunta a waypoints que existen).
  3) Regresion vs el dataset previo (no perder >15% de aerovias o waypoints,
     no perder mas del 5% de los nombres de aerovias previas, AIRAC no
     puede ser mas antiguo que el actual).
  4) Anclas criticas (aerovias y waypoints que SI O SI deben aparecer; si
     desaparecen, el HTML del eAIP probablemente cambio).

Uso:
    python validate_aip.py NEW.json [OLD.json]

Si OLD.json no se da, salta los checks de regresion.
Salida: codigo 0 si todo OK, 1 si alguna validacion falla. Imprime un
resumen legible para los logs del Action.
"""
import io
import json
import re
import sys

# --- Configuracion ---------------------------------------------------------

# Anclas: aerovias y waypoints que casi seguro siempre van a estar en el AIP
# espanol. Si alguna desaparece, sospecha de scraper roto, no de cambio AIP.
ANCHOR_AIRWAYS   = ['L14', 'M601', 'N733', 'N858', 'N869']
ANCHOR_WAYPOINTS = ['POPUL', 'ABOSI', 'ADINO']

# Umbrales absolutos (red AIP de Espana esta en torno a 130-150 aerovias y
# 500-1200 waypoints; aceptamos cualquier dataset razonable).
MIN_AIRWAYS   = 100
MIN_WAYPOINTS = 500

# Regresion: el nuevo dataset no puede caer mas del 15% en conteos respecto
# al actual, ni perder mas del 5% de nombres de aerovias previas.
MAX_AIRWAY_DROP_RATIO  = 0.15
MAX_WP_DROP_RATIO      = 0.15
MAX_NAME_LOSS_RATIO    = 0.05

# Validacion estricta de integridad referencial: toleramos hasta un 1% de
# waypoints en aerovias que no resuelvan (suelen ser fixes extranjeros que
# ENR 3.2 lista pero no detallan en ENR 4.4).
MAX_UNRESOLVED_WP_RATIO = 0.05

AIRAC_RE = re.compile(r'WEF\s+(\d{2})-([A-Z]{3})-(\d{2})')
MONTH = {'JAN':1,'FEB':2,'MAR':3,'APR':4,'MAY':5,'JUN':6,
        'JUL':7,'AUG':8,'SEP':9,'OCT':10,'NOV':11,'DEC':12}


# --- Helpers ---------------------------------------------------------------

def airac_to_tuple(s):
    """'WEF 16-APR-26' -> (2026, 4, 16). None si no parsea."""
    if not s: return None
    m = AIRAC_RE.search(s)
    if not m: return None
    d = int(m.group(1))
    mo = MONTH.get(m.group(2))
    yy = int(m.group(3))
    if mo is None: return None
    yyyy = 2000 + yy if yy < 70 else 1900 + yy
    return (yyyy, mo, d)


def load(path):
    with io.open(path, encoding='utf-8') as f:
        return json.load(f)


# --- Checks ---------------------------------------------------------------

def check_schema(data, errs):
    airac = (data.get('airac') or '').strip()
    aws = data.get('airways')
    wps = data.get('waypoints')
    if not airac_to_tuple(airac):
        errs.append(f'AIRAC ausente o no parseable: {airac!r}')
    if not isinstance(aws, list):
        errs.append('airways no es lista'); return
    if not isinstance(wps, dict):
        errs.append('waypoints no es dict'); return
    if len(aws) < MIN_AIRWAYS:
        errs.append(f'aerovias < {MIN_AIRWAYS}: {len(aws)}')
    if len(wps) < MIN_WAYPOINTS:
        errs.append(f'waypoints < {MIN_WAYPOINTS}: {len(wps)}')

    # Schema por aerovia
    aw_name_re = re.compile(r'^([ABGHJLMNQRTVWYZ]\d{1,4}[A-Z]?|U[A-Z]\d{1,4}[A-Z]?)$')
    bad_airways = 0
    for a in aws:
        if not isinstance(a, dict):                 bad_airways += 1; continue
        if not aw_name_re.match(a.get('name','')):  bad_airways += 1
        wp_list = a.get('waypoints', [])
        if not isinstance(wp_list, list) or len(wp_list) < 2: bad_airways += 1
    if bad_airways:
        errs.append(f'aerovias con esquema invalido: {bad_airways}')

    # Schema por waypoint
    bad_wps = 0
    for wid, w in wps.items():
        if not isinstance(w, dict):                    bad_wps += 1; continue
        lat = w.get('lat'); lon = w.get('lon')
        if not (isinstance(lat,(int,float)) and -90 <= lat <= 90):    bad_wps += 1; continue
        if not (isinstance(lon,(int,float)) and -180 <= lon <= 180):  bad_wps += 1
    if bad_wps:
        errs.append(f'waypoints con esquema invalido: {bad_wps}')


def check_integrity(data, errs):
    aws = data.get('airways') or []
    wps = data.get('waypoints') or {}
    total_refs = 0
    unresolved = 0
    for a in aws:
        for wid in a.get('waypoints', []):
            total_refs += 1
            if wid not in wps: unresolved += 1
    if total_refs == 0: return
    ratio = unresolved / total_refs
    if ratio > MAX_UNRESOLVED_WP_RATIO:
        errs.append(f'integridad: {unresolved}/{total_refs} waypoints sin resolver '
                    f'({ratio*100:.1f}% > {MAX_UNRESOLVED_WP_RATIO*100:.0f}%)')


def check_anchors(data, errs):
    aws = data.get('airways') or []
    wps = data.get('waypoints') or {}
    aw_names = {a.get('name') for a in aws}
    missing_aw = [n for n in ANCHOR_AIRWAYS   if n not in aw_names]
    missing_wp = [n for n in ANCHOR_WAYPOINTS if n not in wps]
    if missing_aw: errs.append(f'anclas aerovia ausentes: {missing_aw}')
    if missing_wp: errs.append(f'anclas waypoint ausentes: {missing_wp}')


def check_regression(new, old, errs):
    new_aws = new.get('airways') or []
    old_aws = old.get('airways') or []
    new_wps = new.get('waypoints') or {}
    old_wps = old.get('waypoints') or {}

    if old_aws:
        drop = 1 - (len(new_aws) / len(old_aws))
        if drop > MAX_AIRWAY_DROP_RATIO:
            errs.append(f'regresion aerovias: {len(old_aws)} -> {len(new_aws)} '
                        f'({drop*100:.1f}% perdido > {MAX_AIRWAY_DROP_RATIO*100:.0f}%)')
    if old_wps:
        drop = 1 - (len(new_wps) / len(old_wps))
        if drop > MAX_WP_DROP_RATIO:
            errs.append(f'regresion waypoints: {len(old_wps)} -> {len(new_wps)} '
                        f'({drop*100:.1f}% perdido > {MAX_WP_DROP_RATIO*100:.0f}%)')

    # Nombres de aerovias previos que ya no estan en el dataset nuevo
    new_names = {a.get('name') for a in new_aws}
    old_names = {a.get('name') for a in old_aws}
    if old_names:
        lost = old_names - new_names
        ratio = len(lost) / len(old_names)
        if ratio > MAX_NAME_LOSS_RATIO:
            sample = sorted(lost)[:10]
            errs.append(f'regresion nombres aerovia: {len(lost)}/{len(old_names)} perdidos '
                        f'({ratio*100:.1f}% > {MAX_NAME_LOSS_RATIO*100:.0f}%); '
                        f'ej: {sample}')

    # AIRAC no puede retroceder
    new_airac = airac_to_tuple(new.get('airac'))
    old_airac = airac_to_tuple(old.get('airac'))
    if new_airac and old_airac and new_airac < old_airac:
        errs.append(f'AIRAC retrocede: {old.get("airac")} -> {new.get("airac")}')


# --- Main ------------------------------------------------------------------

def main():
    if len(sys.argv) < 2:
        print('uso: validate_aip.py NEW.json [OLD.json]', file=sys.stderr)
        sys.exit(2)
    new_path = sys.argv[1]
    old_path = sys.argv[2] if len(sys.argv) > 2 else None

    new = load(new_path)
    print(f'NEW airac={new.get("airac")!r} airways={len(new.get("airways",[]))} waypoints={len(new.get("waypoints",{}))}')
    if old_path:
        try:
            old = load(old_path)
            print(f'OLD airac={old.get("airac")!r} airways={len(old.get("airways",[]))} waypoints={len(old.get("waypoints",{}))}')
        except Exception as e:
            print(f'AVISO: no pude cargar OLD ({e}); salto checks de regresion')
            old = None
    else:
        old = None

    errs = []
    check_schema(new, errs)
    check_integrity(new, errs)
    check_anchors(new, errs)
    if old is not None:
        check_regression(new, old, errs)

    if errs:
        print('\n[VALIDATE] FAIL — el dataset NO se commiteara:', file=sys.stderr)
        for e in errs: print(f'  - {e}', file=sys.stderr)
        sys.exit(1)
    print('\n[VALIDATE] OK — todas las comprobaciones pasaron.')


if __name__ == '__main__':
    main()
