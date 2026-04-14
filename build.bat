@echo off
rem ============================================================
rem  PJeIA - build de producao
rem ============================================================
rem  Gera a pasta dist/ pronta para carregar no Chrome via
rem  "Carregar sem compactacao". Rode este arquivo sempre que
rem  alterar arquivos em src/, manifest.json ou icons/.
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

echo [PJeIA] Verificando tipos (tsc --noEmit)...
call npm run typecheck
if errorlevel 1 (
    echo [PJeIA] ERRO: typecheck falhou.
    endlocal
    exit /b 1
)

echo [PJeIA] Rodando build de producao...
call npm run build
if errorlevel 1 (
    echo [PJeIA] ERRO: webpack build falhou.
    endlocal
    exit /b 1
)

echo.
echo [PJeIA] Build concluido. Carregue a pasta dist\ no Chrome:
echo         chrome://extensions -^> Modo desenvolvedor -^> Carregar sem compactacao
endlocal
