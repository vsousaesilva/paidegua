@echo off
rem ============================================================
rem  kanban-massificacao - regenerar seed.js (fallback file://)
rem ============================================================
rem  Le seed.json e regrava seed.js para que o modo offline
rem  (abrir index.html clicando duas vezes) reflita as ultimas
rem  edicoes manuais ou via Claude Code.
rem
rem  Usa o env.bat do paidegua (Node portatil).
rem ============================================================

setlocal
cd /d "%~dp0"

call ..\..\env.bat
if errorlevel 1 (
    echo [kanban] ERRO: env.bat do paidegua falhou.
    endlocal
    exit /b 1
)

call node scripts\regenerar-seed-js.mjs
if errorlevel 1 (
    echo [kanban] ERRO: regenerar-seed-js.mjs falhou.
    endlocal
    exit /b 1
)

echo.
echo [kanban] Pronto. Abra (ou recarregue) index.html no navegador.
echo          Se ja tinha aberto antes, limpe o localStorage:
echo            F12 ^> Application ^> Storage ^> Clear site data
echo          ou abra em janela anonima.
endlocal
