@echo off
rem ============================================================
rem  PJeIA - configuracao de ambiente (Node portatil)
rem ============================================================
rem  Adiciona o Node.js portatil do workspace ao PATH da sessao
rem  atual do cmd. Nao altera variaveis globais do Windows.
rem
rem  Uso: chame este arquivo com CALL a partir de outro .bat,
rem       ou execute "env.bat" e depois rode "npm" / "node"
rem       diretamente na mesma janela do cmd.
rem ============================================================

set "PJEIA_NODE_DIR=%~dp0..\Nodej\node-v24.14.1-win-x64"

if not exist "%PJEIA_NODE_DIR%\node.exe" (
    echo [PJeIA] ERRO: Node portatil nao encontrado em:
    echo         %PJEIA_NODE_DIR%
    echo         Verifique se a pasta "Nodej\node-v24.14.1-win-x64" existe
    echo         ao lado da pasta "pjeia".
    exit /b 1
)

set "PATH=%PJEIA_NODE_DIR%;%PATH%"
echo [PJeIA] Node portatil ativado nesta sessao do cmd.
"%PJEIA_NODE_DIR%\node.exe" --version
"%PJEIA_NODE_DIR%\npm.cmd" --version
