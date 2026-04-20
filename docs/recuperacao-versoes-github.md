# Recuperação de versões anteriores via GitHub

Este documento descreve como voltar o paidegua a um estado anterior utilizando o Git e o GitHub (`https://github.com/vsousaesilva/paidegua`). Serve tanto para **consultar** uma versão passada (sem alterar o repositório) quanto para **reverter de fato** o código, com diferentes graus de segurança.

> **Resumo rápido**
>
> - Só quero ver como estava o código? → [1. Ver uma versão antiga sem mexer no repositório](#1-ver-uma-versão-antiga-sem-mexer-no-repositório).
> - Quero desfazer um commit ruim preservando o histórico? → [3. Reverter um commit publicado (caminho seguro)](#3-reverter-um-commit-publicado-caminho-seguro).
> - Só mexi no meu computador e quero descartar? → [6. Descartar alterações locais não publicadas](#6-descartar-alterações-locais-não-publicadas).
> - Já enviei algo que não deveria e preciso reescrever o histórico remoto? → [4. Reescrever o histórico remoto (último recurso)](#4-reescrever-o-histórico-remoto-último-recurso).

---

## Convenções

- `main` é o branch principal.
- `origin` é o remoto no GitHub.
- Os exemplos assumem terminal aberto na pasta do projeto:
  `c:/Users/<usuario>/.../Claude JF/paidegua`.
- Um **SHA** (ex.: `4cc4a42`) identifica um commit. Os 7 primeiros caracteres bastam em quase todos os comandos.

Antes de qualquer operação, confirme o estado atual:

```bash
git status
git log --oneline -20
```

---

## 1. Ver uma versão antiga sem mexer no repositório

Estas operações **não alteram** `main` nem o remoto. Servem para inspecionar.

### 1.1. Consultar no site do GitHub

1. Abra `https://github.com/vsousaesilva/paidegua/commits/main`.
2. Clique no commit desejado (ou em **Browse files** no canto direito).
3. O GitHub mostra o repositório exatamente como estava naquele commit.
4. Para baixar aquele snapshot como ZIP: **Code → Download ZIP** naquela página.

### 1.2. Conferir o conteúdo de um arquivo em um commit

```bash
git show <SHA>:caminho/do/arquivo.ts
```

Exemplo:
```bash
git show 2ff909c:src/popup/popup.ts
```

### 1.3. Entrar no estado antigo localmente (detached HEAD)

```bash
git checkout <SHA>
```

O Git avisa que está em "detached HEAD" — isto é esperado. Nada é perdido, `main` continua íntegro.

Para voltar ao estado atual:
```bash
git checkout main
```

---

## 2. Criar um branch a partir de uma versão antiga

Útil quando se quer trabalhar em cima de um estado anterior sem afetar `main`.

```bash
git checkout -b recuperacao/<descricao-curta> <SHA>
```

Exemplo:
```bash
git checkout -b recuperacao/antes-prazos-fita 4cc4a42
```

Esse branch pode ser publicado para revisão:
```bash
git push -u origin recuperacao/antes-prazos-fita
```

Depois, abra um Pull Request no GitHub para comparar com `main` com calma antes de decidir se a reversão vai para produção.

---

## 3. Reverter um commit publicado (caminho seguro)

`git revert` **não apaga** o commit problemático. Ele cria um **novo commit** que desfaz as alterações. O histórico permanece auditável — isto é o comportamento recomendado para um repositório institucional.

### 3.1. Reverter um único commit

```bash
git revert <SHA>
```

O Git abrirá o editor com uma mensagem sugerida. Salve e feche.

### 3.2. Reverter uma sequência de commits

```bash
git revert <SHA_mais_antigo>^..<SHA_mais_recente>
```

Ou individualmente, do mais recente para o mais antigo:
```bash
git revert <SHA_recente>
git revert <SHA_anterior>
```

### 3.3. Publicar a reversão

```bash
git push origin main
```

Se houver conflitos durante o `revert`, o Git pausa e pede resolução manual:
```bash
# edite os arquivos em conflito
git add <arquivos_resolvidos>
git revert --continue
```

Para abortar:
```bash
git revert --abort
```

---

## 4. Reescrever o histórico remoto (último recurso)

> **Atenção — operação destrutiva.** Só usar quando o `revert` não serve (por exemplo, commit com dado sensível que precisa sumir do histórico). Avise a equipe antes, pois quem já tiver o repositório clonado precisará resincronizar.

### 4.1. Voltar `main` para um commit anterior, localmente

```bash
git reset --hard <SHA_alvo>
```

Isso move `main` para `<SHA_alvo>` e **descarta** localmente tudo que estava depois.

### 4.2. Forçar a publicação

O GitHub só aceita sobrescrever com `--force-with-lease`, que protege contra sobrescrever trabalho que alguém publicou em paralelo.

```bash
git push --force-with-lease origin main
```

> Nunca use `git push --force` cego no `main`. Use `--force-with-lease`.

### 4.3. Se o repositório tiver proteção de branch

Repositórios com **branch protection rules** para `main` podem rejeitar o force push mesmo com `--force-with-lease`. Nesse caso:
1. Abrir temporariamente a proteção em **Settings → Branches → main → Edit**.
2. Fazer o force push.
3. **Reativar a proteção imediatamente** depois.

---

## 5. Recuperar um commit que parecia perdido

Mesmo depois de `reset --hard` ou rebase, o Git guarda um histórico local de movimentações do HEAD no `reflog` por ~90 dias por padrão.

```bash
git reflog
```

A saída lista cada ação com o SHA antes dela. Para voltar ao estado anterior à operação:

```bash
git checkout -b recuperacao/reflog <SHA_do_reflog>
```

Se o commit já existia no remoto quando foi "perdido" localmente, normalmente basta:
```bash
git fetch origin
git reset --hard origin/main
```

---

## 6. Descartar alterações locais não publicadas

Quando a bagunça está só no seu computador:

### 6.1. Descartar alterações de um arquivo específico

```bash
git restore caminho/do/arquivo.ts
```

### 6.2. Descartar tudo que está modificado (arquivos rastreados)

```bash
git restore .
```

### 6.3. Remover também arquivos novos não rastreados

Primeiro veja o que seria removido:
```bash
git clean -nd
```

Depois, se estiver tudo certo:
```bash
git clean -fd
```

### 6.4. Voltar o branch local ao que está no GitHub

```bash
git fetch origin
git reset --hard origin/main
```

Isso descarta qualquer commit local que ainda não foi publicado e alinha 100% com o remoto.

---

## 7. Baixar uma versão específica como release

Quando a intenção é distribuir ou instalar uma versão antiga fechada (por ex., uma das tags `dist v1.0.zip`, `dist v1.1.zip`, `dist v1.2.zip` já presentes no repositório):

1. Abrir `https://github.com/vsousaesilva/paidegua`.
2. Ir em **Tags** (ou **Releases**, se houver).
3. Baixar o ZIP correspondente.

Para criar uma tag agora apontando para um estado bom e poder voltar a ele no futuro:

```bash
git tag -a v1.3-estavel <SHA> -m "Estado estavel antes da migracao X"
git push origin v1.3-estavel
```

---

## 8. Tabela-resumo: qual comando para qual situação

| Situação                                                 | Comando                                          | Afeta o remoto? |
|----------------------------------------------------------|--------------------------------------------------|-----------------|
| Ver o código em um commit antigo, sem mexer em nada      | `git checkout <SHA>` (e depois `git checkout main`) | Não             |
| Consultar um arquivo específico em um commit antigo      | `git show <SHA>:caminho/arquivo`                 | Não             |
| Criar branch a partir de um estado passado               | `git checkout -b nome <SHA>`                     | Não             |
| Desfazer um commit publicado sem reescrever histórico    | `git revert <SHA>` + `git push`                  | Sim (aditivo)   |
| Alinhar branch local ao que está no GitHub               | `git fetch origin && git reset --hard origin/main` | Não             |
| Descartar mudanças locais não commitadas                 | `git restore .` / `git clean -fd`                | Não             |
| Recuperar commit "perdido" depois de reset/rebase        | `git reflog` + `git checkout <SHA>`              | Não             |
| Reescrever `main` no GitHub (último recurso)             | `git reset --hard <SHA>` + `git push --force-with-lease` | Sim (destrutivo) |

---

## 9. Recomendações institucionais

- **Preferir `git revert` a `git reset --hard` + force push.** O histórico deste repositório é material institucional; manter a cadeia de commits auditável tem valor por si só.
- **Criar tag antes de mudanças grandes** (`v1.x-pre-<descricao>`), para ter um ponto de retorno nomeado mesmo que o SHA se perca da memória.
- **Testar a versão recuperada antes de distribuir.** Basta gerar o `dist` pelo `build.bat` a partir do branch de recuperação e validar em aba de teste antes de substituir a versão em uso.
- **Nunca commitar credenciais, tokens, CPFs ou números de processo reais.** Se isso acontecer, reverter não basta — o dado continua no histórico. Nesses casos, além do `revert`, é obrigatório reescrever o histórico (seção 4) e revogar a credencial exposta.
