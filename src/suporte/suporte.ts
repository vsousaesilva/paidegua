/**
 * Pagina de suporte do pAIdegua.
 *
 * Coleta os dados do usuario, monta um e-mail pre-preenchido com destinatario
 * `inovajus@jfce.jus.br` e abre no cliente de e-mail padrao do sistema via
 * link `mailto:`. Nao ha backend — toda a composicao roda no navegador.
 *
 * Campos tecnicos opcionais (versao da extensao, navegador, ultima URL do PJe
 * capturada) sao anexados ao corpo do e-mail em um bloco identificado para
 * facilitar triagem sem custo operacional.
 */

const DESTINATARIO = 'inovajus@jfce.jus.br';

interface InfoTecnica {
  versaoExtensao: string;
  navegador: string;
  sistemaOperacional: string;
  urlPJe: string;
  dataHora: string;
}

async function coletarInfoTecnica(): Promise<InfoTecnica> {
  const manifest = chrome.runtime.getManifest();
  const versaoExtensao = manifest.version ?? 'desconhecida';
  const navegador = navigator.userAgent;
  const sistemaOperacional = navigator.platform || 'desconhecido';
  const dataHora = new Date().toLocaleString('pt-BR');

  let urlPJe = 'nao detectada';
  try {
    const abas = await chrome.tabs.query({
      url: ['https://*.trf5.jus.br/*', 'https://*.jus.br/*']
    });
    const ativa = abas.find((t) => t.active) ?? abas[0];
    if (ativa?.url) {
      urlPJe = ativa.url;
    }
  } catch {
    // chrome.tabs pode nao estar disponivel em todos os contextos; seguimos sem
  }

  return { versaoExtensao, navegador, sistemaOperacional, urlPJe, dataHora };
}

function formatarInfoTecnica(info: InfoTecnica): string {
  return (
    `Versao do pAIdegua: ${info.versaoExtensao}\n` +
    `Navegador: ${info.navegador}\n` +
    `Sistema: ${info.sistemaOperacional}\n` +
    `URL do PJe no momento do contato: ${info.urlPJe}\n` +
    `Data/hora local: ${info.dataHora}`
  );
}

function montarCorpoEmail(params: {
  nome: string;
  unidade: string;
  email: string;
  tipo: string;
  descricao: string;
  incluirTecnico: boolean;
  info: InfoTecnica;
}): string {
  const partes: string[] = [];
  partes.push(`Nome: ${params.nome}`);
  partes.push(`Unidade: ${params.unidade}`);
  partes.push(`E-mail de resposta: ${params.email}`);
  partes.push(`Tipo de contato: ${params.tipo}`);
  partes.push('');
  partes.push('Descricao:');
  partes.push(params.descricao);

  if (params.incluirTecnico) {
    partes.push('');
    partes.push('--- Informacoes tecnicas (anexadas automaticamente) ---');
    partes.push(formatarInfoTecnica(params.info));
  }

  return partes.join('\n');
}

function montarAssunto(tipo: string, unidade: string): string {
  const unidadeCurta = unidade.length > 60 ? unidade.slice(0, 57) + '...' : unidade;
  return `[pAIdegua] ${tipo} - ${unidadeCurta}`;
}

function abrirMailto(assunto: string, corpo: string): void {
  const url =
    `mailto:${DESTINATARIO}` +
    `?subject=${encodeURIComponent(assunto)}` +
    `&body=${encodeURIComponent(corpo)}`;
  // `location.href = mailto:` dispara o handler de protocolo do SO (Outlook,
  // etc.) sem abrir aba intermediaria. Em contextos em que o cliente de
  // e-mail nao esta configurado, o navegador exibe o dialogo nativo
  // pedindo para escolher um aplicativo.
  window.location.href = url;
}

async function atualizarPreviewTecnico(): Promise<InfoTecnica> {
  const info = await coletarInfoTecnica();
  const pre = document.getElementById('sup-tecnico-texto');
  if (pre) {
    pre.textContent = formatarInfoTecnica(info);
  }
  return info;
}

function sincronizarVisibilidadeTecnico(): void {
  const chk = document.getElementById('sup-incluir-tecnico') as HTMLInputElement | null;
  const box = document.getElementById('sup-tecnico-preview');
  if (!chk || !box) return;
  box.hidden = !chk.checked;
}

function validarCampos(): { ok: true; valores: {
  nome: string; unidade: string; email: string; tipo: string; descricao: string;
  incluirTecnico: boolean;
} } | { ok: false; mensagem: string } {
  const nome = (document.getElementById('sup-nome') as HTMLInputElement).value.trim();
  const unidade = (document.getElementById('sup-unidade') as HTMLInputElement).value.trim();
  const email = (document.getElementById('sup-email') as HTMLInputElement).value.trim();
  const tipo = (document.getElementById('sup-tipo') as HTMLSelectElement).value;
  const descricao = (document.getElementById('sup-descricao') as HTMLTextAreaElement).value.trim();
  const incluirTecnico = (document.getElementById('sup-incluir-tecnico') as HTMLInputElement).checked;

  if (!nome) return { ok: false, mensagem: 'Informe seu nome.' };
  if (!unidade) return { ok: false, mensagem: 'Informe sua unidade.' };
  if (!email) return { ok: false, mensagem: 'Informe um e-mail para resposta.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, mensagem: 'O e-mail informado nao parece valido.' };
  }
  if (!descricao || descricao.length < 10) {
    return {
      ok: false,
      mensagem: 'Descreva com um pouco mais de detalhe (ao menos 10 caracteres).'
    };
  }

  return { ok: true, valores: { nome, unidade, email, tipo, descricao, incluirTecnico } };
}

function mostrarAjuda(msg: string, kind: 'ok' | 'erro'): void {
  const el = document.getElementById('sup-ajuda') as HTMLParagraphElement | null;
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('sup-ajuda--ok', 'sup-ajuda--erro');
  el.classList.add(kind === 'ok' ? 'sup-ajuda--ok' : 'sup-ajuda--erro');
  el.hidden = false;
}

document.addEventListener('DOMContentLoaded', () => {
  void atualizarPreviewTecnico();
  sincronizarVisibilidadeTecnico();

  const chk = document.getElementById('sup-incluir-tecnico');
  chk?.addEventListener('change', sincronizarVisibilidadeTecnico);

  const form = document.getElementById('sup-form');
  form?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const validacao = validarCampos();
    if (!validacao.ok) {
      mostrarAjuda(validacao.mensagem, 'erro');
      return;
    }
    void (async () => {
      const info = await coletarInfoTecnica();
      const corpo = montarCorpoEmail({ ...validacao.valores, info });
      const assunto = montarAssunto(validacao.valores.tipo, validacao.valores.unidade);
      abrirMailto(assunto, corpo);
      mostrarAjuda(
        'Seu cliente de e-mail foi aberto com a mensagem pronta. Revise e clique em "Enviar". Se nada abriu, confirme se o Outlook (ou outro cliente) esta configurado como padrao no seu sistema.',
        'ok'
      );
    })();
  });
});
