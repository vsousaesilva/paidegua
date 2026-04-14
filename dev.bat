@echo off
rem ============================================================
rem  PJeIA - modo desenvolvimento (webpack --watch)
rem ============================================================
rem  Roda o webpack em modo desenvolvimento com watch ativo.
rem  A pasta dist/ e regenerada automaticamente a cada save.
rem  No Chrome, clique em "Recarregar" na extensao apos cada
rem  alteracao para aplicar as mudancas.
rem
rem  Pressione Ctrl+C para encerrar o watcher.
rem ============================================================

setlocal
cd /d "%~dp0"

call "%~dp0env.bat"
if errorlevel 1 (
    endlocal
    exit /b 1
)

if not exist "node_modules" (
    echo [PJeIA] node_modules nao encontrado. Rodando npm install primeiro...
    call npm install
    if errorlevel 1 (
        echo [PJeIA] ERRO: npm install falhou.
        endlocal
        exit /b 1
    )
)

echo [PJeIA] Iniciando webpack em modo watch...
call npm run dev
endlocal
