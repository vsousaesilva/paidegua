/**
 * Interface comum dos provedores de LLM suportados.
 *
 * Cada provedor concreto implementa esta interface; o background script
 * apenas seleciona o provedor pelo id e delega a chamada — UI e lógica de
 * orquestração não conhecem detalhes da API de cada vendor.
 */

import type { ProviderId } from '../../shared/constants';
import type { ChatMessage, TestConnectionResult } from '../../shared/types';

export interface SendMessageParams {
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  signal: AbortSignal;
}

/** Chunk emitido pelo gerador de streaming. */
export interface StreamChunk {
  delta: string;
}

export interface LLMProvider {
  readonly id: ProviderId;

  /**
   * Envia uma conversa e devolve um async generator de chunks de texto.
   * Implementações DEVEM respeitar `signal.aborted` e parar limpo.
   */
  sendMessage(params: SendMessageParams): AsyncGenerator<StreamChunk, void, void>;

  /** Testa credenciais com uma chamada mínima. */
  testConnection(apiKey: string, model: string): Promise<TestConnectionResult>;

  /**
   * Transcreve áudio para texto (STT). Provedores que não suportam devem
   * retornar `null` — o caller fará fallback para Web Speech API local.
   */
  transcribeAudio?(
    apiKey: string,
    audioBytes: Uint8Array,
    mimeType: string
  ): Promise<string | null>;

  /**
   * Sintetiza voz a partir de texto (TTS). Devolve áudio binário ou null
   * para indicar que o caller deve usar SpeechSynthesis do browser.
   */
  synthesizeSpeech?(
    apiKey: string,
    text: string,
    voice: string | undefined
  ): Promise<{ audio: Uint8Array; mimeType: string } | null>;
}
