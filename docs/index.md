---
title: Política de Privacidade — pAIdegua
---

# Política de Privacidade — pAIdegua

**A política de privacidade do pAIdegua passou a ser publicada em:**

## <https://paidegua.ia.br/privacidade/>

Esse é o endereço oficial, mantido pelo **Inovajus / JFCE**, e o que deve constar
do painel da Chrome Web Store.

---

## Por que este arquivo mudou

Até julho de 2026 a política vivia aqui, em markdown. A versão registrada era a
**1.2.1**, muito atrás da extensão (1.10.2), e continha duas afirmações que **não
correspondiam ao comportamento do software** — o que é grave num documento
apresentado a órgão regulador:

1. **Anonimização.** O texto afirmava que "antes do envio aos provedores, a
   extensão executa rotina de anonimização". Não é o caso: nas ações de resumo e
   de minuta a anonimização só ocorre se o usuário acionar o botão **Anonimizar
   autos**. A aplicação automática existe apenas na pesquisa de jurisprudência e
   nos indicadores de gestão/triagem.
2. **Token de sessão.** O texto afirmava que "o JWT é assinado com chave privada
   (HS256)". Isso descrevia o backend legado em Google Apps Script. A arquitetura
   atual emite um token opaco de 32 bytes aleatórios, validado por consulta ao
   registro no Cloudflare KV — não há assinatura HS256 envolvida.

Ambos os pontos estão corrigidos na versão publicada. Para evitar que a divergência
se repita, a política passou a ter **fonte única**:
`docs/site/privacidade/index.html`.

## Ao alterar a política

Edite `docs/site/privacidade/index.html`, atualize a versão e a data no topo, e
publique conforme `docs/site/DEPLOY.md`. Não recrie uma cópia em markdown.
