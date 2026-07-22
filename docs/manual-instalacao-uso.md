# pAIdegua — Manual de Instalação e Uso

> **Este arquivo foi descontinuado.**
>
> O manual passou a ter **fonte única**: [`docs/site/manual/index.html`](site/manual/index.html),
> publicado em <https://paidegua.ia.br/manual/>.
>
> Até julho de 2026 o manual existia em três cópias (este `.md`, um `.html` avulso e
> a página do site). As cópias divergiram — este arquivo parou na versão 1.6.1,
> enquanto a extensão já estava na 1.10.2. Para não repetir o problema, **edite
> apenas a página do site**.

## Como atualizar o manual

1. Edite `docs/site/manual/index.html`.
2. Atualize a linha de versão no topo (`<p class="manual-meta">`).
3. Se acrescentou uma seção, inclua o item correspondente no índice lateral
   (`<ul class="toc__list">`) — a numeração das seções é manual.
4. Faça push. O site republica sozinho (ver [`site/DEPLOY.md`](site/DEPLOY.md)).

## Convenção de escrita

O manual é lido por pessoas com níveis muito diferentes de familiaridade com o
PJe e com tecnologia. **Não use termos técnicos.** Prefira descrever o que o
usuário vê e faz na tela. Quando um detalhe técnico for inevitável, explique o
efeito prático em vez do mecanismo.
