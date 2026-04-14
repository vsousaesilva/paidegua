/**
 * Tipos TypeScript compartilhados entre content script, background e popup.
 * Mantém contratos explícitos — strict mode sem `any`.
 */

import type { ProviderId } from './constants';

/** Resultado da detecção de uma página do PJe. */
export interface PJeDetection {
  isPJe: boolean;
  version: 'legacy' | 'pje2' | 'unknown';
  tribunal: string;
  grau: '1g' | '2g' | 'turma_recursal' | 'unknown';
  isProcessoPage: boolean;
  numeroProcesso: string | null;
  baseUrl: string;
}

/** Documento processual extraído dos autos digitais. */
export interface ProcessoDocumento {
  id: string;
  tipo: string;
  descricao: string;
  dataMovimentacao: string;
  mimeType: string;
  url: string;
  tamanho?: number;
  isScanned?: boolean;
  textoExtraido?: string;
}

/** Mensagens no chat com a IA. */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

/** Configurações persistidas do usuário. */
export interface PAIdeguaSettings {
  activeProvider: ProviderId;
  /** Modelo selecionado por provedor. */
  models: Record<ProviderId, string>;
  temperature: number;
  maxTokens: number;
  useStreaming: boolean;
  /** Voz preferida para TTS (id depende do provedor; '' = automática). */
  ttsVoice: string;
  lgpdAccepted: boolean;
  /** Roda OCR automaticamente após extração quando há PDFs digitalizados. */
  ocrAutoRun: boolean;
  /** Máximo de páginas que o OCR processa por documento (cap de segurança). */
  ocrMaxPages: number;
}

/** Ação rápida customizável (botão de um clique). */
export interface QuickAction {
  id: string;
  label: string;
  prompt: string;
  builtin: boolean;
}

/** Envelope genérico para mensagens entre os contextos da extensão. */
export interface ExtensionMessage<T = unknown> {
  channel: string;
  payload: T;
  requestId?: string;
}

/** Payload enviado ao iniciar uma conversa via porta de chat. */
export interface ChatStartPayload {
  provider: ProviderId;
  model: string;
  messages: ChatMessage[];
  documents: ProcessoDocumento[];
  numeroProcesso: string | null;
  temperature?: number;
  maxTokens?: number;
}

/** Resultado de uma chamada de teste de conexão. */
export interface TestConnectionResult {
  ok: boolean;
  error?: string;
  modelEcho?: string;
}

/** Payload de transcrição de áudio. */
export interface TranscribeAudioPayload {
  provider: ProviderId;
  /** Áudio codificado em base64 (data URL sem prefixo). */
  audioBase64: string;
  mimeType: string;
}

/** Payload de síntese de voz. */
export interface SynthesizeSpeechPayload {
  provider: ProviderId;
  text: string;
  voice?: string;
}

/** Resposta de síntese de voz: ou audio em base64, ou flag para usar fallback local. */
export interface SynthesizeSpeechResult {
  ok: boolean;
  audioBase64?: string;
  mimeType?: string;
  useBrowserFallback?: boolean;
  error?: string;
}
