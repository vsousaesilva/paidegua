@echo off
rem ============================================================
rem  pAIdegua - carrega credenciais Cloudflare na sessao do cmd
rem ============================================================
rem  Le CLOUDFLARE_API_TOKEN de %USERPROFILE%\.paidegua-cf-token
rem  e seta CLOUDFLARE_ACCOUNT_ID hardcoded da conta paidegua.
rem
rem  Uso a partir da raiz do paidegua:
rem      call cf-env.bat
rem      wrangler kv key list --namespace-id=... --remote
rem
rem  Para criar/renovar o token:
rem      1. https://dash.cloudflare.com/profile/api-tokens
rem      2. Token paidegua-kanban-deploy com 7 escopos:
rem         Account: Pages Edit, Workers Scripts Edit,
rem                  Workers KV Storage Edit, Account Settings Read
rem         Zone:    Workers Routes Edit, Zone Read, DNS Edit
rem      3. Salvar como UMA LINHA em:
rem         %USERPROFILE%\.paidegua-cf-token
rem
rem  Nao apagar este script - SKILL release-extensao depende dele.
rem ============================================================

set "CF_TOKEN_FILE=%USERPROFILE%\.paidegua-cf-token"

if not exist "%CF_TOKEN_FILE%" goto :sem_arquivo

for /f "usebackq delims=" %%a in ("%CF_TOKEN_FILE%") do set "CLOUDFLARE_API_TOKEN=%%a"

if "%CLOUDFLARE_API_TOKEN%"=="" goto :arquivo_vazio

set "CLOUDFLARE_ACCOUNT_ID=f13a21f421661dcfb1651880a2be578e"

echo [pAIdegua] Cloudflare carregado.
echo            Account: %CLOUDFLARE_ACCOUNT_ID%
echo            Valide com: wrangler whoami
goto :eof

:sem_arquivo
echo [pAIdegua] ERRO arquivo de token nao encontrado.
echo            Esperado em: %CF_TOKEN_FILE%
echo            Criar pelo Notepad uma linha sem espacos extras:
echo            notepad "%CF_TOKEN_FILE%"
exit /b 1

:arquivo_vazio
echo [pAIdegua] ERRO arquivo de token esta vazio: %CF_TOKEN_FILE%
exit /b 1
