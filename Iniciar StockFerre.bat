@echo off
title StockFerre - Servidor Local
echo.
echo   Iniciando StockFerre...
echo.
start "" http://localhost:8765
node "%~dp0server.js"
