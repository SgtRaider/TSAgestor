@echo off
REM Lanzador de TSAgestor: arranca un servidor HTTP local en el puerto 8000
REM y abre la app en el navegador. Necesario para que las APIs externas
REM (METAR/TAF de AWC, RainViewer, EUMETView) funcionen sin chocar con CORS.

title TSAgestor server
cd /d "%~dp0"

set PORT=8000
set URL=http://127.0.0.1:%PORT%/index.html

echo.
echo  TSAgestor servido en %URL%
echo  Cierra esta ventana o pulsa Ctrl+C para parar.
echo.

start "" "%URL%"

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  py -m http.server %PORT%
  goto :eof
)

where python >nul 2>nul
if %ERRORLEVEL%==0 (
  python -m http.server %PORT%
  goto :eof
)

echo  ERROR: no se ha encontrado Python (py / python) en el PATH.
echo  Instala Python (https://python.org) o ejecuta otro servidor:
echo    npx http-server -p %PORT%
pause
