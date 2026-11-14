@echo off
title TIENDA 1 - App
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo   Abriendo TIENDA 1 ... espere un momento
echo.

rem ============================================================
rem  Busca Edge o Chrome
rem ============================================================
set "NAV="
for %%c in (
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%LocalAppData%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do if exist %%c set "NAV=%%~c"

if not defined NAV (
  echo   No se encontro Edge ni Chrome en este equipo.
  echo   Abriendo el archivo en el navegador por defecto...
  start "" "%~dp0index.html"
  goto :done
)

rem ============================================================
rem  Si existe Node.js usa el servidor (permite instalar la app
rem  como PWA y sirve el autollenado de fotos). Si no existe,
rem  abre el archivo directo: la app funciona igual completa,
rem  solo sin autollenado de imagenes.
rem ============================================================
set "HASNODE="
where node >nul 2>nul && set "HASNODE=1"

if defined HASNODE (
  start "TIENDA 1 - Servidor" /min node "%~dp0server.js"
  timeout /t 2 /nobreak >nul
  start "" "%NAV%" --app=http://localhost:8765
  goto :done
)

rem Sin Node: abre el archivo directo en ventana de app
set "BASE=%~dp0"
set "BASE=%BASE:\=/%"
start "" "%NAV%" --app="file:///%BASE%index.html"

:done
echo.
echo   La app abre en su propia ventana. Cierra esta ventana si quieres.
echo.
timeout /t 6 /nobreak >nul