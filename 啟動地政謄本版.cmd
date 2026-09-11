@echo off
setlocal
cd /d "%~dp0"
set "LAND_REGISTRY_BROWSER=--open-browser"
if /i "%~1"=="--no-browser" set "LAND_REGISTRY_BROWSER="
py -3 -u "%~dp0local_publish.py" --host 127.0.0.1 --port 8011 --html index.html %LAND_REGISTRY_BROWSER%
if errorlevel 1 pause
endlocal
