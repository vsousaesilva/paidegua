/**
 * Helper compartilhado pelos dashboards (Triagem, Gestão, Prazos na fita)
 * para abrir a tarefa do processo no PJe, replicando o comportamento do
 * link original no painel do usuário:
 *
 *   <a onclick="openPopUp('{idProcesso}popUpFluxo',
 *                         '/pje/Processo/movimentar.seam?idProcesso=X&newTaskId=Y')">
 *
 * O que o PJe faz: `openPopUp` é um wrapper ao redor de `window.open` com
 * nome de janela determinístico (`{idProcesso}popUpFluxo`). Como os nossos
 * dashboards rodam fora do origin do PJe (são páginas da extensão), não
 * conseguimos chamar `openPopUp` diretamente — mas um `window.open` com o
 * mesmo nome e a mesma URL tem efeito equivalente para o usuário, desde
 * que ele já esteja autenticado no PJe (cookies de sessão entram na
 * requisição porque a URL é do próprio origin do PJe).
 *
 * O dashboard não tem o `legacyOrigin` injetado como configuração — mas
 * toda linha de processo já carrega uma URL dos autos (`listAutosDigitais.
 * seam`) construída a partir desse origin. Extrair `new URL(url).origin`
 * é a forma mais barata de reaproveitar o valor sem passar um parâmetro
 * novo por toda a cadeia payload → dashboard.
 */

export interface AbrirTarefaOpts {
  /** ID interno do processo (número no PJe, ex.: 2669589). */
  idProcesso: string;
  /** ID da TaskInstance corrente (usado como `newTaskId`). */
  idTaskInstance: string;
  /**
   * URL de referência para extrair o origin do PJe legacy. Tipicamente a
   * URL dos autos digitais já montada para a mesma linha. Se ausente ou
   * inválida, a função devolve `false` e o caller deve avisar o usuário.
   */
  referenciaUrlAutos: string | null | undefined;
}

/**
 * Monta a URL de `movimentar.seam` para a tarefa. Retorna `null` quando
 * não conseguimos derivar o origin do PJe a partir da URL de referência.
 */
export function montarUrlTarefa(opts: AbrirTarefaOpts): string | null {
  const origin = extrairOrigemPJe(opts.referenciaUrlAutos);
  if (!origin) return null;
  const params = new URLSearchParams();
  params.set('idProcesso', opts.idProcesso);
  params.set('newTaskId', opts.idTaskInstance);
  return `${origin}/pje/Processo/movimentar.seam?${params.toString()}`;
}

/**
 * Abre a tarefa em uma janela popup nomeada `{idProcesso}popUpFluxo`,
 * mesmo nome que o PJe usa. Se o usuário clicar em duas linhas do mesmo
 * processo, a segunda reaproveita a janela aberta — comportamento
 * idêntico ao do painel nativo. Retorna `true` se o `window.open`
 * produziu uma referência utilizável, `false` caso contrário (popup
 * bloqueado ou URL inválida).
 */
export function abrirTarefaPopup(opts: AbrirTarefaOpts): boolean {
  const url = montarUrlTarefa(opts);
  if (!url) return false;
  const nome = `${opts.idProcesso}popUpFluxo`;
  // Dimensões aproximadas à janela que o PJe usa. Sem `noopener` porque
  // o reuso da janela nomeada entre cliques depende de o navegador poder
  // manter a referência.
  const features =
    'popup=yes,width=1200,height=800,resizable=yes,scrollbars=yes,' +
    'status=yes,toolbar=no,menubar=no,location=yes';
  const w = window.open(url, nome, features);
  return Boolean(w);
}

function extrairOrigemPJe(
  urlRef: string | null | undefined
): string | null {
  if (!urlRef) return null;
  try {
    const u = new URL(urlRef);
    // Sanidade mínima: o origin precisa ser http(s). Qualquer coisa fora
    // disso (extensão, data:, blob:) indica que a URL não é um link real
    // do PJe e não adianta montar a tarefa.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * True quando a linha tem dados suficientes pra exibir o botão "Abrir
 * tarefa". Os dois IDs precisam ser strings não-vazias e distintos — no
 * fallback DOM o PJe expõe apenas um `<span id>` e nosso parser usa o
 * mesmo valor para `idProcesso` e `idTaskInstance`, caso em que a URL
 * `movimentar.seam` montada não resolveria a tarefa certa.
 */
export function podeAbrirTarefa(
  idProcesso: string | null | undefined,
  idTaskInstance: string | null | undefined
): boolean {
  if (!idProcesso || !idTaskInstance) return false;
  if (idProcesso === idTaskInstance) return false;
  return true;
}

/**
 * Ícone SVG (seta para fora de uma caixa) — mesmo estilo visual do
 * `COPY_ICON_SVG` usado pelos dashboards. Reutilizável em HTML string ou
 * em botões montados via DOM.
 */
export const OPEN_TASK_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
  '<polyline points="15 3 21 3 21 9"/>' +
  '<line x1="10" y1="14" x2="21" y2="3"/>' +
  '</svg>';
