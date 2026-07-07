/**
 * Provedor Google Gemini — usa generateContent com streaming SSE em
 * `streamGenerateContent?alt=sse`. Aceita áudio nativamente como input
 * para transcrição (Gemini multimodal).
 *
 * TTS: usa `gemini-2.5-flash-preview-tts` quando disponível; em caso de
 * indisponibilidade, retorna null para que o caller use SpeechSynthesis.
 */

import { LOG_PREFIX, PROVIDER_ENDPOINTS } from '../../shared/constants';
import type { TestConnectionResult } from '../../shared/types';
import {
  type LLMProvider,
  type SendMessageParams,
  type StreamChunk
} from './base';
import { fetchWithRetry } from './retry';
import { parseSseStream } from './sse';

interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
}

interface GeminiStreamPayload {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        /** true em modelos de raciocínio (thinking mode). Esses tokens NÃO devem
         *  ser exibidos ao usuário — são pensamento interno do modelo. */
        thought?: boolean;
      }>;
    };
    finishReason?: string;
    safetyRatings?: Array<{ category: string; probability: string; blocked?: boolean }>;
  }>;
  promptFeedback?: {
    blockReason?: string;
    safetyRatings?: Array<{ category: string; probability: string }>;
  };
}

/**
 * Configurações de safety. Em contexto judicial é comum o conteúdo das peças
 * mencionar crimes, violência, dados pessoais etc., disparando os filtros
 * padrão do Gemini (que bloqueiam até MEDIUM). Para uso pelo Judiciário
 * Federal, configuramos BLOCK_NONE — a responsabilidade do uso correto é do
 * servidor, não da plataforma de IA.
 */
const SAFETY_SETTINGS_PERMISSIVE = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
];

// Capacidade máxima de tokens de saída por modelo. maxOutputTokens é um
// teto — o modelo para naturalmente quando termina de gerar, sem usar o
// limite inteiro. Usar o teto completo evita truncamento silencioso em
// tarefas longas (ex.: resumo de processo com muitos documentos).
const GEMINI_MAX_OUTPUT_TOKENS: Record<string, number> = {
  'gemini-3.5-flash': 65_536,
  'gemini-3-flash-preview': 65_536,
  'gemini-3.1-flash-lite-preview': 65_536,
  'gemini-2.5-pro': 65_536,
  'gemini-2.5-flash': 65_536
};
const GEMINI_FALLBACK_MAX_OUTPUT = 32_768;

function resolveGeminiMaxTokens(model: string): number {
  return GEMINI_MAX_OUTPUT_TOKENS[model] ?? GEMINI_FALLBACK_MAX_OUTPUT;
}

/**
 * Retorna o bloco thinkingConfig adequado para cada família de modelo Gemini.
 *
 * Famílias e seus parâmetros (documentação Firebase/Google AI Studio):
 * - Flash-Lite (qualquer versão): thinkingBudget: 0 → desabilita thinking
 * - Gemini 2.5 Flash (não-lite): thinkingBudget: 0 → aceito, desabilita thinking
 * - Gemini 2.5 Pro: thinkingBudget: 8192 → cap explícito; -1 (dinâmico) consome
 *   todos os maxOutputTokens com chaves AQ. (maior quota), gerando resposta vazia
 * - Gemini 3.x+ Flash: thinkingLevel: 'MINIMAL' → menor overhead possível
 * - Gemini 3.x+ Pro: thinkingLevel: 'LOW' → 'MINIMAL' não é suportado em Pro
 *
 * Sem thinkingConfig explícito, os modelos usam o budget padrão (sem limite
 * superior definido), consumindo todos os maxOutputTokens em tokens de
 * raciocínio interno — que são filtrados pelo código — resultando em
 * resposta vazia silenciosa.
 *
 * NOTA: o erro original "Budget 0 is invalid. This model only works in thinking
 * mode." era causado pelo regex /flash/i enviando thinkingBudget: 0 para
 * gemini-3-flash-preview, que usa a API thinkingLevel (não thinkingBudget).
 */
function buildThinkingConfig(model: string): { thinkingConfig: Record<string, unknown> } {
  // Flash-Lite: desabilita thinking completamente
  if (/flash-lite/i.test(model)) {
    return { thinkingConfig: { thinkingBudget: 0 } };
  }
  // Gemini 2.5 Flash não-lite: aceita thinkingBudget: 0
  if (/^gemini-2\.\d+-flash/i.test(model)) {
    return { thinkingConfig: { thinkingBudget: 0 } };
  }
  // Gemini 2.5 Pro: não aceita budget 0; cap explícito de 8.192 tokens.
  // thinkingBudget: -1 (dinâmico) permite pensar sem limite superior com
  // chaves AQ. (maior quota), consumindo todos os maxOutputTokens em
  // raciocínio e resultando em resposta vazia.
  if (/^gemini-2\./i.test(model)) {
    return { thinkingConfig: { thinkingBudget: 8192 } };
  }
  // Gemini 3.x+ Flash: API thinkingLevel, nível mínimo para menor latência
  if (/flash/i.test(model)) {
    return { thinkingConfig: { thinkingLevel: 'MINIMAL' } };
  }
  // Gemini 3.x+ Pro: thinkingLevel LOW ('MINIMAL' não suportado em modelos Pro)
  return { thinkingConfig: { thinkingLevel: 'LOW' } };
}

/**
 * Chaves no formato AIzaSy... são o formato legado ("Standard/Traffic keys").
 * O Google iniciou a rejeição de chaves legadas não-restringidas em 19/06/2026
 * e encerrará o suporte completo em setembro/2026. O novo formato ("Auth keys",
 * prefixo AQ.) tem acesso amplo incluindo modelos preview do Gemini 3.
 */
export function isLegacyGeminiKey(key: string): boolean {
  return key.startsWith('AIzaSy');
}

/**
 * Constrói os headers HTTP para autenticação na API Gemini.
 * Usa o header `x-goog-api-key` conforme a documentação oficial —
 * funciona para ambos os formatos de chave (AIzaSy e AQ.).
 */
function geminiAuthHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey
  };
}

export const geminiProvider: LLMProvider = {
  id: 'gemini',

  async *sendMessage(params: SendMessageParams): AsyncGenerator<StreamChunk, void, void> {
    const contents: GeminiContent[] = [];
    for (const m of params.messages) {
      if (m.role === 'system') {
        continue;
      }
      const parts: GeminiContent['parts'] = [];
      if (m.content) parts.push({ text: m.content });
      for (const img of m.images ?? []) {
        parts.push({ inlineData: { mimeType: img.mimeType, data: img.dataBase64 } });
      }
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: parts.length > 0 ? parts : [{ text: '' }]
      });
    }

    const url =
      `${PROVIDER_ENDPOINTS.gemini.base}/models/${encodeURIComponent(params.model)}` +
      `:streamGenerateContent?alt=sse`;

    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        signal: params.signal,
        headers: geminiAuthHeaders(params.apiKey),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: params.systemPrompt }] },
          contents,
          safetySettings: SAFETY_SETTINGS_PERMISSIVE,
          generationConfig: {
            temperature: params.temperature,
            maxOutputTokens: resolveGeminiMaxTokens(params.model),
            ...buildThinkingConfig(params.model),
            // JSON mode nativo: força resposta sintaticamente válida quando o
            // caller pede. Sem isso, o Gemini frequentemente devolve markdown
            // fences, aspas curvas ou vírgulas finais que quebram JSON.parse.
            ...(params.responseFormat === 'json'
              ? { responseMimeType: 'application/json' }
              : {})
          }
        })
      },
      { provider: 'gemini', model: params.model, isLegacyGeminiKey: isLegacyGeminiKey(params.apiKey) }
    );

    const t0 = performance.now();
    let ttft: number | undefined;
    let totalChunks = 0;
    let totalTextLen = 0;
    let lastFinishReason: string | undefined;
    let blockReason: string | undefined;
    let usageError: string | null = null;

    try {
      for await (const event of parseSseStream(response, params.signal)) {
        if (!event.data) {
          continue;
        }
        let payload: GeminiStreamPayload;
        try {
          payload = JSON.parse(event.data) as GeminiStreamPayload;
        } catch (err) {
          console.warn(`${LOG_PREFIX} gemini: JSON parse falhou`, event.data.slice(0, 200), err);
          continue;
        }

        // Detecta bloqueio do prompt antes de qualquer candidate
        if (payload.promptFeedback?.blockReason) {
          blockReason = payload.promptFeedback.blockReason;
        }

        const candidate = payload.candidates?.[0];
        if (candidate?.finishReason) {
          lastFinishReason = candidate.finishReason;
        }

        const parts = candidate?.content?.parts ?? [];
        for (const part of parts) {
          // Filtra tokens de raciocínio interno (thought: true) — são pensamento
          // privado do modelo, não devem aparecer na resposta ao usuário.
          if (part.thought) continue;
          if (typeof part.text === 'string' && part.text.length > 0) {
            if (ttft === undefined) {
              ttft = Math.round(performance.now() - t0);
            }
            totalChunks++;
            totalTextLen += part.text.length;
            yield { delta: part.text };
          }
        }
      }

      // Stream terminou sem nenhum texto — diagnóstico para o usuário.
      if (totalChunks === 0) {
        console.warn(
          `${LOG_PREFIX} gemini: stream encerrado sem texto. ` +
            `finishReason=${lastFinishReason ?? '(nenhum)'} ` +
            `blockReason=${blockReason ?? '(nenhum)'}`
        );
        const errMsg = blockReason
          ? `Gemini bloqueou o prompt (${blockReason}). O conteúdo dos autos disparou um filtro de segurança.`
          : lastFinishReason && lastFinishReason !== 'STOP'
          ? `Gemini encerrou sem produzir texto (finishReason=${lastFinishReason}). Pode ser bloqueio por safety, limite de tokens, ou conteúdo recitado.`
          : 'Gemini retornou resposta vazia. Verifique se a chave tem acesso ao modelo selecionado e se o processo não excedeu o context window.';
        usageError = errMsg.slice(0, 300);
        throw new Error(errMsg);
      }
      // Stream encerrado por limite de tokens: há conteúdo mas está incompleto.
      if (lastFinishReason === 'MAX_TOKENS') {
        yield {
          delta:
            '\n\n---\n⚠️ **Resposta interrompida:** o modelo atingiu o limite de tokens de saída ' +
            `(\`MAX_TOKENS\` — ${resolveGeminiMaxTokens(params.model).toLocaleString('pt-BR')} tokens). ` +
            'O conteúdo acima pode estar incompleto. Considere selecionar outro modelo ou reduzir o tamanho do contexto enviado.'
        };
      } else if (!lastFinishReason) {
        // Stream encerrado sem finishReason: o servidor fechou a conexão antes de
        // enviar o evento final. Causa mais comum: cota de tokens por minuto (TPM)
        // atingida a meio da geração (chaves de Nível 1 têm 1M TPM vs 4M do Nível 2).
        // O modelo pode ter gerado conteúdo parcialmente correto — avisamos o usuário.
        usageError = 'stream encerrado sem finishReason (cota ou conexão)';
        yield {
          delta:
            '\n\n---\n⚠️ **Resposta incompleta:** a conexão com o Gemini foi encerrada ' +
            'antes do modelo terminar a resposta. Causa provável: limite de tokens por minuto ' +
            '(cota) da chave de API. Aguarde 60 segundos e tente novamente, ou use uma chave ' +
            'de Nível 2 no Google AI Studio para limites maiores.'
        };
      } else if (lastFinishReason !== 'STOP') {
        // finishReason inesperado com texto já emitido: SAFETY, RECITATION, OTHER etc.
        usageError = `finishReason inesperado: ${lastFinishReason}`;
        yield {
          delta:
            `\n\n---\n⚠️ **Geração interrompida:** o modelo parou prematuramente ` +
            `(código: \`${lastFinishReason}\`). O conteúdo acima pode estar incompleto. ` +
            'Tente novamente ou selecione outro modelo.'
        };
      }
      console.log(
        `${LOG_PREFIX} gemini: stream OK — ${totalChunks} chunks, ${totalTextLen} chars, finishReason=${lastFinishReason ?? 'STOP'}`
      );
    } catch (err) {
      if (usageError === null) {
        usageError =
          err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
      }
      throw err;
    } finally {
      void appendGeminiUsage({
        ts: Date.now(),
        model: params.model,
        inChars: estimateInputChars(params),
        ttft: ttft ?? null,
        totalMs: Math.round(performance.now() - t0),
        outChars: totalTextLen,
        finishReason: lastFinishReason ?? null,
        ok: usageError === null,
        errorSnippet: usageError
      });
    }
  },

  async testConnection(apiKey: string, model: string): Promise<TestConnectionResult> {
    try {
      // Usa streamGenerateContent?alt=sse — o mesmo endpoint do uso real.
      // generateContent (não-streaming) pode responder 200 mesmo quando o
      // streaming está restrito para a chave/projeto (ex.: 503 em modelos
      // preview com acesso limitado), gerando falso positivo no teste.
      const url =
        `${PROVIDER_ENDPOINTS.gemini.base}/models/${encodeURIComponent(model)}` +
        `:streamGenerateContent?alt=sse`;
      const response = await fetch(url, {
        method: 'POST',
        headers: geminiAuthHeaders(apiKey),
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 64, ...buildThinkingConfig(model) }
        })
      });
      if (!response.ok) {
        const text = await safeReadText(response);
        return { ok: false, error: `${response.status}: ${text.slice(0, 200)}` };
      }
      try { await response.body?.cancel(); } catch { /* ignore */ }
      return { ok: true, modelEcho: model };
    } catch (error: unknown) {
      return { ok: false, error: errorMessage(error) };
    }
  },

  async transcribeAudio(
    apiKey: string,
    audioBytes: Uint8Array,
    mimeType: string
  ): Promise<string | null> {
    // Gemini aceita áudio inline como Base64. Usa flash para custo baixo.
    const model = 'gemini-2.5-flash';
    const url = `${PROVIDER_ENDPOINTS.gemini.base}/models/${model}:generateContent`;
    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: geminiAuthHeaders(apiKey),
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { text: 'Transcreva fielmente este áudio em português brasileiro. Responda apenas com a transcrição, sem comentários.' },
                { inlineData: { mimeType, data: bytesToBase64(audioBytes) } }
              ]
            }
          ],
          generationConfig: { temperature: 0.0, maxOutputTokens: 2048 }
        })
      },
      { provider: 'gemini', model, resourceLabel: 'transcrição de áudio', isLegacyGeminiKey: isLegacyGeminiKey(apiKey) }
    );
    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    return text ?? null;
  },

  async synthesizeSpeech(): Promise<null> {
    // A API pública estável de TTS do Gemini ainda varia por região e
    // exige formato preview. Para garantir robustez, devolvemos null e o
    // caller usa SpeechSynthesis local (voz pt-BR feminina do Edge).
    return null;
  }
};

// =====================================================================
// Log de uso real — persistido em chrome.storage.local
// =====================================================================

export interface GeminiUsageEntry {
  ts: number;
  model: string;
  /** Chars totais do systemPrompt + messages (proxy do tamanho do prompt). */
  inChars: number;
  /** Tempo até o primeiro token de texto, em ms. null = nenhum token recebido. */
  ttft: number | null;
  /** Tempo total da operação, em ms. */
  totalMs: number;
  /** Chars de texto gerado. */
  outChars: number;
  /** finishReason da API, ou null se não houve candidates. */
  finishReason: string | null;
  /** true = stream concluído com pelo menos um token de texto. */
  ok: boolean;
  /** Primeiros 300 chars do erro, ou null se ok. */
  errorSnippet: string | null;
}

const GEMINI_USAGE_LOG_KEY = 'paidegua.gemini.usageLog';
const GEMINI_USAGE_LOG_MAX = 500;

async function appendGeminiUsage(entry: GeminiUsageEntry): Promise<void> {
  try {
    const data = await chrome.storage.local.get(GEMINI_USAGE_LOG_KEY);
    const log: GeminiUsageEntry[] = Array.isArray(data[GEMINI_USAGE_LOG_KEY])
      ? (data[GEMINI_USAGE_LOG_KEY] as GeminiUsageEntry[])
      : [];
    log.push(entry);
    if (log.length > GEMINI_USAGE_LOG_MAX) {
      log.splice(0, log.length - GEMINI_USAGE_LOG_MAX);
    }
    await chrome.storage.local.set({ [GEMINI_USAGE_LOG_KEY]: log });
  } catch {
    // best-effort: falha no log não deve impactar o fluxo principal
  }
}

function estimateInputChars(params: SendMessageParams): number {
  const sysLen = params.systemPrompt?.length ?? 0;
  const msgLen = params.messages.reduce((acc, m) => acc + (m.content?.length ?? 0), 0);
  return sysLen + msgLen;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<no body>';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
