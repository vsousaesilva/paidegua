/**
 * Checkpoints persistentes da varredura "Prazos na Fita".
 *
 * Unidades de 10k-20k processos podem demorar 10-15 minutos mesmo com
 * concorrencia alta. Se o Chrome fechar, se o token Keycloak expirar
 * sem ser renovado em 60s, ou se o usuario cancelar a aba — sem
 * checkpoint, todo o trabalho anterior e perdido.
 *
 * Este modulo encapsula o ciclo de vida do checkpoint em
 * `chrome.storage.local`:
 *   - `computeScanId` deriva um id deterministico de (host, nomes,
 *     filtros). Relancar a mesma selecao reaproveita o checkpoint.
 *   - `salvar`/`ler`/`apagar` operam sobre uma chave indexada por id.
 *   - `consultarPorAssinatura` responde a pergunta do painel:
 *     "existe um scan incompleto para esta selecao?"
 *   - `expirarAntigos` descarta checkpoints com >24h (evita lixo).
 *
 * Conteudo: processos + expedientes ja coletados. NUNCA vai para a
 * LLM nem sai do dispositivo — o dashboard le deste storage apenas
 * quando o usuario retoma.
 */

import { STORAGE_KEYS } from '../../shared/constants';
import type {
  PrazosFitaScanState,
  PrazosFitaScanStateInfo
} from '../../shared/types';

const TTL_MS = 24 * 60 * 60 * 1000; // 24h

function chaveDoScan(scanId: string): string {
  return `${STORAGE_KEYS.PRAZOS_FITA_SCAN_STATE_PREFIX}${scanId}`;
}

/**
 * Hash SHA-256 hex (primeiros 16 bytes) de uma string. Determinismo:
 * mesma entrada -> mesmo id em qualquer execucao. Webcrypto esta
 * disponivel em content scripts (isolated world).
 */
async function sha256Hex32(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest).slice(0, 16);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export async function computeScanId(params: {
  host: string;
  nomes: string[];
  filtros: {
    diasMinNaTarefa: number | null;
    maxProcessosTotal: number | null;
  };
}): Promise<string> {
  const nomesOrdenados = [...params.nomes].map((n) => n.trim()).sort();
  const payload = JSON.stringify({
    host: params.host,
    nomes: nomesOrdenados,
    dias: params.filtros.diasMinNaTarefa ?? 0,
    max: params.filtros.maxProcessosTotal ?? 0
  });
  return sha256Hex32(payload);
}

/**
 * Le um checkpoint pelo id. Retorna null se nao existir ou estiver
 * expirado (passa no GC e apaga o expirado de passagem).
 */
export async function lerEstado(
  scanId: string
): Promise<PrazosFitaScanState | null> {
  try {
    const chave = chaveDoScan(scanId);
    const out = await chrome.storage.local.get(chave);
    const raw = out[chave] as PrazosFitaScanState | undefined;
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.updatedAt !== 'number' || Date.now() - raw.updatedAt > TTL_MS) {
      await chrome.storage.local.remove(chave);
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export async function salvarEstado(state: PrazosFitaScanState): Promise<void> {
  try {
    await chrome.storage.local.set({
      [chaveDoScan(state.scanId)]: state
    });
  } catch (err) {
    console.warn('[pAIdegua] salvarEstado falhou:', err);
  }
}

export async function apagarEstado(scanId: string): Promise<void> {
  try {
    await chrome.storage.local.remove(chaveDoScan(scanId));
  } catch (err) {
    console.warn('[pAIdegua] apagarEstado falhou:', err);
  }
}

/**
 * Remove checkpoints com updatedAt > TTL_MS. Chamado no inicio de
 * qualquer consulta por assinatura — GC oportunista, sem job dedicado.
 */
export async function expirarAntigos(): Promise<void> {
  try {
    const all = await chrome.storage.local.get(null);
    const prefix = STORAGE_KEYS.PRAZOS_FITA_SCAN_STATE_PREFIX;
    const paraApagar: string[] = [];
    const agora = Date.now();
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith(prefix)) continue;
      const st = v as PrazosFitaScanState | undefined;
      if (!st || typeof st.updatedAt !== 'number' || agora - st.updatedAt > TTL_MS) {
        paraApagar.push(k);
      }
    }
    if (paraApagar.length > 0) {
      await chrome.storage.local.remove(paraApagar);
    }
  } catch (err) {
    console.warn('[pAIdegua] expirarAntigos falhou:', err);
  }
}

/**
 * Consulta a existencia de um checkpoint compativel com a assinatura
 * informada. Usada pela aba-painel no clique de "Iniciar varredura":
 * se houver state, pergunta ao usuario se deseja retomar.
 */
export async function consultarPorAssinatura(params: {
  host: string;
  nomes: string[];
  filtros: {
    diasMinNaTarefa: number | null;
    maxProcessosTotal: number | null;
  };
}): Promise<PrazosFitaScanStateInfo> {
  await expirarAntigos();
  const scanId = await computeScanId(params);
  const st = await lerEstado(scanId);
  if (!st) return { hasState: false };
  const concluidos = st.consolidados.filter((c) => c != null).length;
  const total = st.unicos.length;
  if (total > 0 && concluidos >= total) {
    // checkpoint saturado (nao deveria ocorrer — o coordinator apaga
    // no sucesso) — trata como ausente.
    await apagarEstado(scanId);
    return { hasState: false };
  }
  return {
    hasState: true,
    scanId,
    concluidos,
    total,
    startedAt: st.startedAt,
    updatedAt: st.updatedAt
  };
}
