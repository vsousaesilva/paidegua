# Publicação do pAIdegua no Chrome Web Store e Edge Add-ons

Guia operacional para disponibilizar a extensão nas lojas oficiais e
manter o ciclo de atualização pós-publicação.

---

## 1. Chrome Web Store

### Conta de desenvolvedor

- Acesse https://chrome.google.com/webstore/devconsole
- Entre com conta Google institucional (recomendado: conta @jfce.jus.br
  ou @trf5.jus.br para vínculo institucional)
- **Taxa única de US$ 5,00** (cartão internacional) — paga uma vez por
  conta, vale para todas as extensões
- Verifique identidade (Google pode pedir documento) e e-mail

### Preparação do pacote

1. Ajuste o `manifest.json`:
   - `version`: `"1.0.0"` (obrigatório bumpar a cada upload)
   - `name`, `description`, `author`, `homepage_url`
   - Remova `"key"`, permissões não usadas, URLs de `content_scripts`
     que não forem necessárias
2. Rode o build de produção: `npm run build`
3. Compacte a pasta `dist/` em `.zip` (só o conteúdo — sem a pasta pai)

### Materiais obrigatórios

- **Ícone** 128×128 PNG
- **Pelo menos 1 screenshot** 1280×800 ou 640×400 PNG
- **Descrição curta** (até 132 caracteres) e longa
- **Política de privacidade** publicada em URL pública (exige porque a
  extensão envia dados a APIs de IA — LGPD/CWS). Pode ser página
  estática no site da JFCE/TRF5
- **Categoria** (Productivity)
- **Idioma principal** (Português – Brasil)

### Submissão

1. Dashboard → "Novo item" → upload do `.zip`
2. Preencha ficha: descrição, screenshots, categoria, país
3. **Declare "Single purpose"** — descreva o propósito único
   (assistente de IA para análise de processos PJe)
4. **Justificativas de permissão** — uma por uma (`activeTab`,
   `storage`, `scripting`, hosts `pje1g.trf5.jus.br` /
   `pje2g.trf5.jus.br`). Seja específico: *"acesso a pje1g/pje2g porque
   a extensão lê a árvore de documentos para extrair o texto
   processual"*
5. **Data handling disclosure**: declare que envia conteúdo processual
   a APIs de IA do provedor escolhido pelo usuário, com chave fornecida
   por ele
6. **Visibilidade**: considere **"Não listada"** (Unlisted) — só
   instala quem tem o link. Para uso interno institucional é o mais
   adequado; evita escrutínio público e uso externo indevido.
   Alternativa mais restrita: **"Privada"** para um Google Workspace
   específico (exige domínio Workspace da JFCE — se houver)

### Revisão

- Prazo típico: 1 a 7 dias úteis (primeira submissão costuma demorar
  mais)
- Rejeições comuns: permissões não justificadas, política de privacidade
  ausente, screenshots fora do padrão, descrição genérica

---

## 2. Microsoft Edge Add-ons

### Conta de desenvolvedor

- https://partner.microsoft.com/dashboard/microsoftedge → "Registrar"
- **Gratuito** (sem taxa)
- Conta Microsoft institucional

### Submissão

- O mesmo `.zip` do Chrome serve (MV3 é compatível)
- Materiais análogos (ícones, screenshots, política de privacidade)
- Não há "Unlisted" como no Chrome, mas há **"Hidden"** (equivalente)
- Justifique permissões igual ao Chrome

### Revisão

- Mais rápida em média (1 a 3 dias úteis), tende a seguir a aprovação
  do Chrome

---

## 3. Processo de atualização (pós-publicação)

### Chrome e Edge funcionam igual

1. Faça a alteração no código
2. **Bumpe `version`** no `manifest.json` (regra semântica:
   `1.0.0` → `1.0.1` para bugfix, `1.1.0` para feature, `2.0.0` para
   mudança quebrada). Versão é obrigatoriamente **maior que a
   anterior** — não aceita reupload com mesmo número
3. `npm run build` → gerar novo `.zip`
4. Dashboard → selecionar extensão → "Upload new version"
5. Se mudou permissões, escopo de hosts ou descrição, refazer
   justificativas
6. Passa por **nova revisão** (geralmente mais rápida que a inicial,
   horas a 1-2 dias)

### Distribuição automática

- Após aprovada, Chrome/Edge empurram a atualização para todos os
  usuários **automaticamente** em até ~24h (o navegador checa updates
  periodicamente)
- Nenhuma ação do usuário é necessária — a extensão atualiza sozinha
  em background
- Usuários podem forçar: `chrome://extensions` → ativar "Modo
  desenvolvedor" → "Atualizar"

### Estratégias úteis

- **Versões de teste**: mantenha uma listagem separada "Unlisted" com
  builds beta para equipe piloto antes de promover ao canal principal
- **Rollback**: a loja não tem botão de "rollback" — se uma versão ruim
  for ao ar, a correção é publicar **outra versão maior** com o bug
  corrigido. Por isso teste bem antes
- **Canary interno**: antes de subir, instale o `.zip` localmente para
  alguns usuários via "Carregar sem compactação" para validar em
  produção real

---

## 4. Alternativa para ambiente JFCE (recomendação)

Dado o caráter institucional e o risco de exposição de dados
processuais, **considere não publicar publicamente**:

- **Chrome Web Store "Unlisted"** + link distribuído internamente —
  instala como qualquer extensão da loja (inclusive com auto-update),
  mas não aparece em busca
- **Política de grupo (GPO) do Active Directory** — se a TI da JFCE
  gerencia os navegadores dos servidores, pode forçar instalação e
  atualização via GPO, apontando para o CRX hospedado na intranet ou
  para o ID da extensão na loja. Esse é o caminho mais controlado e
  auditável para uso institucional
- **Edge** tem mecanismo equivalente via Intune/GPO

Converse com a STI antes de publicar — a política institucional pode
exigir aprovação formal, revisão de segurança e hospedagem interna do
pacote.
