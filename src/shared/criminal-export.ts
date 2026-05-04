/**
 * Auto-export do acervo criminal.
 *
 * Função compartilhada entre:
 *   - **`criminal-config`** (página): botão "Exportar agora", que tem
 *     gesto do usuário e pode chamar `requestPermission()` no handle se
 *     o navegador tiver revogado o acesso.
 *   - **`background`** (service worker): disparo via `chrome.alarms` —
 *     SW NÃO pode chamar `requestPermission()` (precisa gesto), então
 *     se a permissão estiver `'prompt'` registramos a falha e abortamos.
 *     A UI da config reflete o status para o usuário re-confirmar.
 *
 * Postura de segurança: o JSON de export é texto puro com nomes/CPFs
 * dos réus — mesmo material que está no IDB local. A pasta de destino
 * é institucional (escolhida pelo usuário, idealmente em servidor da
 * vara com backup). Sem cifragem nesta versão; alinhado ao guidance
 * em `criminal-types.ts:CriminalConfig`.
 */

import {
  getExportFolderHandle,
  listAllProcessos,
  loadCriminalConfig,
  patchCriminalConfig
} from './criminal-store';
import type { Processo, UltimoExportStatus } from './criminal-types';

export interface PayloadExport {
  meta: {
    paidegua_versao: string;
    schema_versao: number;
    gerado_em: string;
    servidor_responsavel?: string;
    vara_id?: string;
    total_processos: number;
    total_reus: number;
  };
  processos: Processo[];
}

/** Versão do payload de backup — bump ao mudar formato. */
const BACKUP_SCHEMA_VERSION = 1;

function nomeArquivoHoje(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `paidegua-backup-${yyyy}-${mm}-${dd}.json`;
}

function paideguaVersao(): string {
  // chrome.runtime.getManifest existe tanto em SW quanto em pages
  try {
    return chrome.runtime.getManifest().version ?? 'desconhecida';
  } catch {
    return 'desconhecida';
  }
}

/**
 * Monta o payload em memória. Pura — não toca em filesystem.
 * Útil também pra um futuro "Exportar para o clipboard" / download HTTP.
 */
export async function gerarPayloadExport(): Promise<PayloadExport> {
  const [config, processos] = await Promise.all([
    loadCriminalConfig(),
    listAllProcessos()
  ]);
  const totalReus = processos.reduce((acc, p) => acc + p.reus.length, 0);
  return {
    meta: {
      paidegua_versao: paideguaVersao(),
      schema_versao: BACKUP_SCHEMA_VERSION,
      gerado_em: new Date().toISOString(),
      servidor_responsavel: config.servidor_responsavel,
      vara_id: config.vara_id,
      total_processos: processos.length,
      total_reus: totalReus
    },
    processos
  };
}

export interface ExecutarAutoExportOptions {
  /**
   * Quando `true`, autoriza chamar `handle.requestPermission()` se a
   * permissão estiver em `'prompt'`. Só passe `true` quando a função
   * for invocada a partir de um **gesto do usuário** (clique de botão
   * na página de config). Em service worker, mantenha `false`.
   */
  permitirRequestPermission: boolean;
  /** Origem para registrar no `ultimo_export_status`. */
  origem: UltimoExportStatus['origem'];
}

export type ResultadoAutoExport =
  | { ok: true; arquivo: string; bytes: number }
  | { ok: false; error: string; motivoCurto: 'sem-pasta' | 'sem-permissao' | 'falha-escrita' | 'falha-permission-api' };

/**
 * Executa o auto-export: lê o handle, valida permissão, gera JSON e
 * escreve `paidegua-backup-AAAA-MM-DD.json` na pasta. Atualiza
 * `ultimo_export` + `ultimo_export_status` na config independentemente
 * do resultado.
 */
export async function executarAutoExport(
  opts: ExecutarAutoExportOptions
): Promise<ResultadoAutoExport> {
  const ts = new Date().toISOString();
  const reg = await getExportFolderHandle();
  if (!reg) {
    const status: UltimoExportStatus = {
      ts,
      ok: false,
      mensagem: 'Pasta de auto-export não configurada.',
      origem: opts.origem
    };
    await patchCriminalConfig({ ultimo_export_status: status });
    return {
      ok: false,
      error: status.mensagem!,
      motivoCurto: 'sem-pasta'
    };
  }

  // Verifica permissão. A API `queryPermission` faz parte do FileSystemHandle.
  // Tipagem ainda não está em lib.dom — usamos cast pontual.
  const handle = reg.handle as FileSystemDirectoryHandle & {
    queryPermission?: (opts: { mode: 'readwrite' }) => Promise<PermissionState>;
    requestPermission?: (opts: { mode: 'readwrite' }) => Promise<PermissionState>;
  };

  let estado: PermissionState;
  try {
    estado = (await handle.queryPermission?.({ mode: 'readwrite' })) ?? 'prompt';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status: UltimoExportStatus = {
      ts,
      ok: false,
      mensagem: `Falha consultando permissão da pasta: ${msg}`,
      origem: opts.origem
    };
    await patchCriminalConfig({ ultimo_export_status: status });
    return { ok: false, error: status.mensagem!, motivoCurto: 'falha-permission-api' };
  }

  if (estado === 'prompt') {
    if (!opts.permitirRequestPermission || !handle.requestPermission) {
      const status: UltimoExportStatus = {
        ts,
        ok: false,
        mensagem:
          'Permissão de escrita na pasta não está mais ativa — abra "Configurações" do Sigcrim e clique em "Exportar agora" para reautorizar.',
        origem: opts.origem
      };
      await patchCriminalConfig({ ultimo_export_status: status });
      return { ok: false, error: status.mensagem!, motivoCurto: 'sem-permissao' };
    }
    estado = await handle.requestPermission({ mode: 'readwrite' });
  }

  if (estado !== 'granted') {
    const status: UltimoExportStatus = {
      ts,
      ok: false,
      mensagem: 'Permissão de escrita na pasta foi negada.',
      origem: opts.origem
    };
    await patchCriminalConfig({ ultimo_export_status: status });
    return { ok: false, error: status.mensagem!, motivoCurto: 'sem-permissao' };
  }

  // Gera o payload, escreve.
  try {
    const payload = await gerarPayloadExport();
    const json = JSON.stringify(payload, null, 2);
    const arquivo = nomeArquivoHoje();
    const fileHandle = await handle.getFileHandle(arquivo, { create: true });
    const writable = await (fileHandle as FileSystemFileHandle & {
      createWritable: () => Promise<FileSystemWritableFileStream>;
    }).createWritable();
    await writable.write(json);
    await writable.close();

    const status: UltimoExportStatus = {
      ts,
      ok: true,
      mensagem: `${payload.meta.total_processos} processo(s) · ${payload.meta.total_reus} réu(s) gravados em ${arquivo}.`,
      arquivo,
      origem: opts.origem
    };
    await patchCriminalConfig({
      ultimo_export: ts,
      ultimo_export_status: status
    });
    return { ok: true, arquivo, bytes: json.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status: UltimoExportStatus = {
      ts,
      ok: false,
      mensagem: `Falha escrevendo arquivo: ${msg}`,
      origem: opts.origem
    };
    await patchCriminalConfig({ ultimo_export_status: status });
    return { ok: false, error: status.mensagem!, motivoCurto: 'falha-escrita' };
  }
}

/**
 * Calcula em quantos minutos a próxima execução deve disparar, dado
 * o horário (`HH:MM`) e a periodicidade. Sempre dispara no PRÓXIMO
 * `HH:MM` que ainda não passou hoje (diário) ou no próximo mesmo dia
 * da semana (semanal — usa a data atual como referência inicial).
 *
 * Retorna minutos a partir de "agora" (Date.now). Se passar >24h,
 * o `chrome.alarms` aceita normalmente.
 */
export function minutosAteProximoExport(
  periodicidade: 'diario' | 'semanal',
  horario: string
): number {
  const m = horario.match(/^(\d{1,2}):(\d{2})$/);
  const hh = m ? Math.min(23, Math.max(0, Number(m[1]))) : 19;
  const mm = m ? Math.min(59, Math.max(0, Number(m[2]))) : 0;

  const agora = new Date();
  const proximo = new Date(
    agora.getFullYear(),
    agora.getMonth(),
    agora.getDate(),
    hh,
    mm,
    0,
    0
  );
  if (proximo.getTime() <= agora.getTime()) {
    proximo.setDate(proximo.getDate() + 1);
  }
  if (periodicidade === 'semanal') {
    // Empurra até o mesmo dia da semana de "agora", garantindo
    // que >= próximo. Como `proximo` já está em "amanhã" no pior
    // caso, basta avançar até o dia da semana corresponder.
    const diaDestino = agora.getDay();
    while (proximo.getDay() !== diaDestino) {
      proximo.setDate(proximo.getDate() + 1);
    }
  }
  const diffMs = proximo.getTime() - agora.getTime();
  return Math.max(1, Math.round(diffMs / 60_000));
}
