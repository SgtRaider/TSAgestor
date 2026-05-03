"""Genera js/aipData.js a partir de aip-data.json.

Carga el JSON, lo simplifica a un formato compacto (waypoints como pares
[lat,lon] en vez de objeto, para reducir bytes) y lo escribe como modulo JS
asignado a window.TSAgestor.aipData.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC  = os.path.join(HERE, "aip-data.json")
DST  = os.path.normpath(os.path.join(HERE, "..", "..", "js", "aipData.js"))

with open(SRC, "r", encoding="utf-8") as f:
    raw = json.load(f)

# Compactar: waypoints en pares [lat,lon,type,name]
compact = {
    "source":  raw.get("source"),
    "airac":   raw.get("airac"),
    "waypoints": {
        wid: [w["lat"], w["lon"], w["type"], w.get("name", wid)]
        for wid, w in raw["waypoints"].items()
    },
    "airways": [
        {
            "name":     a["name"],
            "category": a["category"],
            "waypoints": a["waypoints"],
            "lowerFL":  a["lowerFL"],
            "upperFL":  a["upperFL"],
        }
        for a in raw["airways"]
    ],
}

js = (
    "// AUTO-GENERADO desde data-sources/aip-enr/aip-data.json - NO EDITAR A MANO.\n"
    "// Fuente: AIP Espana ENR 3.2 + ENR 4.1 - " + (raw.get("airac") or "?") + ".\n"
    "// Regenerar con: py data-sources/aip-enr/parse_aip.py && py data-sources/aip-enr/embed_aip.py\n"
    "window.TSAgestor = window.TSAgestor || {};\n"
    "window.TSAgestor.aipData = "
    + json.dumps(compact, ensure_ascii=False, separators=(",", ":"))
    + ";\n"
)

with open(DST, "w", encoding="utf-8", newline="\n") as f:
    f.write(js)

size_kb = os.path.getsize(DST) / 1024
print(f"Escrito {DST} ({size_kb:.1f} KB)")
