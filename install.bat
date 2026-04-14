@echo off
rem ============================================================
rem  PJeIA - instalacao de dependencias
rem ============================================================
rem  Usa o Node.js portatil do workspace para rodar "npm install"
rem  na pasta pjeia. Rode UMA vez antes do primeiro build.
rem ============================================================

setlocal
cd /d "%~dp0"

call "%~dp0env.bat"
if errorlevel 1 (
    endlocal
    exit /b 1
)

echo [PJeIA] Instalando dependencias...
call npm install
if errorlevel 1 (
    echo [PJeIA] ERRO: npm install falhou.
    endlocal
    exit /b 1
)

echo [PJeIA] Dependencias instaladas com sucesso.
endlocal
