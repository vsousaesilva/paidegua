# Skills do pAIdegua para uso colaborativo

Skills no formato do **Claude Code** (Agent Skills), destilando o conhecimento
de engenharia consolidado no pAIdegua para repasse a outras equipes que
desenvolvam sobre o PJe/TRF5. Cada skill é uma pasta com um `SKILL.md`
(frontmatter YAML `name` + `description`, seguido das instruções).

| Skill | Quando o Claude a ativa |
|---|---|
| [extracao-documentos-pje](extracao-documentos-pje/SKILL.md) | Baixar/extrair texto de documentos processuais do PJe Legacy (endpoint REST, 0 bytes, ativação, pdf.js em MV3) |
| [integracao-julia-trf5](integracao-julia-trf5/SKILL.md) | Consumir a API da Júlia (jurisprudência TRF5) — pública e autenticada, contratos, armadilhas e LGPD |
| [ocr-extracao-texto-imagens](ocr-extracao-texto-imagens/SKILL.md) | Extrair texto de PDFs digitalizados/imagens — estratégia imagem-direto vs. Tesseract.js offline |
| [injecao-minuta-badon](injecao-minuta-badon/SKILL.md) | Inserir minutas no editor Badon (ProseMirror) do PJe 2.9.7+ — paste sintético e classes canônicas |

## Como instalar (para quem recebe)

Copie a(s) pasta(s) da skill para um destes locais:

- **Por projeto** (compartilhada via git com a equipe):
  `<projeto>/.claude/skills/<nome-da-skill>/SKILL.md`
- **Pessoal** (vale para todos os projetos da máquina):
  `~/.claude/skills/<nome-da-skill>/SKILL.md`
  (no Windows: `C:\Users\<usuario>\.claude\skills\...`)

O Claude Code descobre a skill automaticamente pela `description` do
frontmatter e a carrega quando a tarefa do usuário corresponder ao tema. Também
é possível invocar explicitamente digitando `/<nome-da-skill>`.

## Manutenção

A fonte de verdade técnica continua sendo os documentos de engenharia em
[docs/](../) ([extracao-conteudo-pje.md](../extracao-conteudo-pje.md),
[extracao-julia-trf5.md](../extracao-julia-trf5.md),
[injecao-minuta-editor-badon.md](../injecao-minuta-editor-badon.md)) e o
código-fonte do pAIdegua. Ao evoluir esses documentos, reflita as mudanças
relevantes nas skills antes de redistribuí-las.

## Aviso aos destinatários

Conteúdo institucional da JFCE. As técnicas descritas dependem de
comportamentos observados do PJe/Badon/Júlia (não documentados oficialmente) e
podem quebrar com atualizações dos sistemas. Observar LGPD e normas do CNJ:
nunca logar dados de partes, anonimizar antes de enviar conteúdo a provedores
de IA externos e alinhar usos em lote com a DTI do TRF5.
