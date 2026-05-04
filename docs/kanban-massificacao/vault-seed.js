/**
 * pAIdegua Kanban — Seed do Cofre (apenas Credenciais)
 *
 * Pacote inicial de credenciais-template. Carregado pelo botão
 * "📦 Carregar pacote inicial" do Cofre quando ele está vazio.
 *
 * IMPORTANTE: este arquivo contém TEXTO EM CLARO. É carregado em RAM no momento
 * do clique, cifrado localmente com a passphrase do usuário (AES-GCM 256), e os
 * itens cifrados são salvos no KV / localStorage. O texto-claro nunca é persistido.
 *
 * Para documentos compartilhados (manuais, pipelines, runbooks) sem cripto,
 * veja `docs-seed.js` e o modal "📚 Documentos".
 */
window.__PAIDEGUA_VAULT_SEED__ = [
  {
    tipo: 'api-key',
    label: 'Anthropic API key (Claude)',
    tags: ['ia', 'anthropic', 'claude', 'enterprise'],
    usuario: 'vsousaesilva@jfce.jus.br',
    url: 'https://console.anthropic.com/settings/keys',
    conteudo: `(SUBSTITUA PELA SUA CHAVE)
sk-ant-api03-...

Plano: Enterprise / API (vedação de uso para treino — Art. 19 II Res. 615/2025)
Renovação: anual
Onde obter: https://console.anthropic.com/settings/keys
Modelo padrão: claude-opus-4-7 (Opus 4.7)
Modelos para tool-use leve: claude-haiku-4-5-20251001
`,
  },
  {
    tipo: 'api-key',
    label: 'OpenAI API key (GPT)',
    tags: ['ia', 'openai', 'gpt', 'whisper'],
    usuario: 'vsousaesilva@jfce.jus.br',
    url: 'https://platform.openai.com/api-keys',
    conteudo: `(SUBSTITUA PELA SUA CHAVE)
sk-proj-...

Plano: Business / Enterprise
Onde obter: https://platform.openai.com/api-keys
Uso: transcrição (Whisper) + GPT
`,
  },
  {
    tipo: 'api-key',
    label: 'Google Gemini API key',
    tags: ['ia', 'gemini', 'google'],
    usuario: 'vsousaesilva@jfce.jus.br',
    url: 'https://aistudio.google.com/apikey',
    conteudo: `(SUBSTITUA PELA SUA CHAVE)
AIzaSy...

Onde obter: https://aistudio.google.com/apikey
Plano: Workspace / Education (vedação de uso para treino)
`,
  },
  {
    tipo: 'api-key',
    label: 'GitHub PAT — paidegua-kanban-worker',
    tags: ['github', 'pat', 'worker', 'integracao'],
    usuario: 'vsousaesilva',
    url: 'https://github.com/settings/tokens',
    conteudo: `(SUBSTITUA PELO SEU TOKEN)
ghp_...

Scope: repo (Full control of private repositories)
Expiração: 1 ano
Uso: criar issues automáticas no Worker quando card cai em "dev"
Onde está usado: secret GITHUB_TOKEN do Worker paidegua-kanban-api
Renovar até: (preencha após criar)
`,
  },
  {
    tipo: 'api-key',
    label: 'Cloudflare API Token — deploy',
    tags: ['cloudflare', 'wrangler', 'ci', 'deploy'],
    usuario: 'vsousaesilva',
    url: 'https://dash.cloudflare.com/profile/api-tokens',
    conteudo: `(SUBSTITUA PELO SEU TOKEN)

Nome: paidegua-kanban-deploy
Permissões: Pages:Edit, Workers Scripts:Edit, Workers KV Storage:Edit, Workers Routes:Edit, Account Settings:Read, Zone:Read, DNS:Edit
Account ID: f13a21f421661dcfb1651880a2be578e
Onde está usado: GitHub Actions secret CLOUDFLARE_API_TOKEN ou env CLOUDFLARE_API_TOKEN local
Onde obter: https://dash.cloudflare.com/profile/api-tokens
`,
  },
  {
    tipo: 'api-key',
    label: 'Resend API key',
    tags: ['resend', 'email', 'otp'],
    usuario: 'vsousaesilva@jfce.jus.br',
    url: 'https://resend.com/api-keys',
    conteudo: `(SUBSTITUA PELA SUA CHAVE)
re_...

Domínio verificado: paidegua.ia.br (sa-east-1 / São Paulo)
SPF/DKIM/DMARC: configurados no DNS de paidegua.ia.br
Uso: envio de OTP do Kanban
Onde está usado: secret RESEND_API_KEY do Worker
Limite Free: 3.000 e-mails/mês, 100/dia
`,
  },
  {
    tipo: 'senha',
    label: 'PJe TRF5 1G — login institucional',
    tags: ['pje', 'trf5', '1g', 'producao'],
    usuario: '(matricula institucional)',
    url: 'https://pje1g.trf5.jus.br',
    conteudo: `(SUBSTITUA PELA SUA SENHA)

Sistemas afetados:
- pje1g.trf5.jus.br (1º grau)
- pje2g.trf5.jus.br (2º grau)
- pjett.trf5.jus.br (turma recursal)

Política: troca a cada 90 dias
Política de complexidade: 8+ caracteres com número, letra e símbolo
Recuperação: portal de senha do TRF5 ou DTI
`,
  },
  {
    tipo: 'conexao',
    label: 'Inovajus / JFCE — backend de auth (legado GAS)',
    tags: ['inovajus', 'jfce', 'auth', 'jwt', 'legado'],
    usuario: 'service account Apps Script',
    url: 'https://script.google.com',
    conteudo: `Backend de autenticação LEGADO da extensão pAIdegua.

Tipo: Google Apps Script (script.google.com)
Endpoints:
  - request-otp: gera código de 6 dígitos
  - verify-otp: valida e emite JWT (HS256, 90 dias)
  - validate: revalida JWT
Whitelist: planilha Google Sheets em /drive/inovajus
Chave HS256: (anote o ID do segredo no GAS, não a chave em si)
Domínios autorizados: jfce.jus.br, trf5.jus.br, jfrn.jus.br, jfpb.jus.br, jfpe.jus.br, jfal.jus.br, jfse.jus.br

⚠ MIGRAÇÃO PLANEJADA: este backend será substituído pelo Worker Cloudflare
   (kanban.paidegua.ia.br/api/auth/extension-*). A planilha de whitelist será
   migrada para o KV team:members. Card no Kanban: INFRA-EXT-AUTH.
`,
  },
  {
    tipo: 'conexao',
    label: 'Cofre — passphrase mestra (lembrete, NÃO a passphrase)',
    tags: ['cofre', 'passphrase', 'mestra', 'critico'],
    usuario: 'compartilhada-equipe-inovajus',
    conteudo: `⚠️ LEIA COM ATENÇÃO

Esta entrada é apenas para anotar METADADOS sobre a passphrase do Cofre,
NÃO a passphrase em si.

NÃO ESCREVA A PASSPHRASE AQUI dentro do próprio Cofre — se você esquecer
e o cofre estiver bloqueado, esta entrada também estará indisponível.

Em vez disso, anote em GERENCIADOR DE SENHAS PESSOAL (Bitwarden, 1Password)
ou cofre físico (papel guardado em local seguro).

## Metadados

- **Estratégia**: passphrase compartilhada (todo Inovajus usa a mesma)
- **Onde está guardada**:
  - 1Password compartilhado: vault "Inovajus / pAIdegua"
  - Backup físico: (anote local)
- **Última rotação**: (preencha — ex.: 2026-05-04)
- **Próxima rotação prevista**: (preencha — ex.: 2026-11-04)
- **Quem tem acesso**: (lista de e-mails)

## Procedimento de rotação

1. Combine data e hora com a equipe
2. Cada membro abre o cofre com a passphrase atual
3. Backup do estado: \`wrangler kv:key get --binding=KANBAN_KV "vault:state" > backup-pre-rotacao.json\`
4. (Pendente automatizar) re-export plain → re-cifragem com nova passphrase → re-import
5. Distribuir nova passphrase pelo canal seguro
6. Marcar próxima rotação no calendário institucional
`,
  },
];
