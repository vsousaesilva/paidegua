/**
 * Ofuscação leve de API keys armazenadas em chrome.storage.local.
 *
 * IMPORTANTE: isto NÃO é criptografia forte. Trata-se de ofuscação que
 * impede leitura casual de um dump do storage. Quem tiver acesso ao perfil
 * do navegador (e ao código da extensão) pode reverter. O contexto da JFCE,
 * onde a estação é institucional e exige autenticação do servidor, torna
 * esse trade-off aceitável.
 *
 * Implementação: WebCrypto AES-GCM com chave derivada via PBKDF2 a partir
 * de um segredo fixo embutido no build.
 */

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** Segredo de build — qualquer string longa serve como salt fixo. */
const BUILD_SECRET = 'paidegua/jfce/v1/k0e5p-it-s4fe-en0ugh';
const SALT = ENCODER.encode('paidegua.salt.v1.constant');
const ITERATIONS = 100_000;
const IV_BYTES = 12;

let cachedKey: CryptoKey | null = null;

async function deriveKey(): Promise<CryptoKey> {
  if (cachedKey) {
    return cachedKey;
  }
  const baseKey = await crypto.subtle.importKey(
    'raw',
    ENCODER.encode(BUILD_SECRET),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  cachedKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: SALT,
      iterations: ITERATIONS,
      hash: 'SHA-256'
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return cachedKey;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  // Aloca via ArrayBuffer puro para evitar o tipo Uint8Array<ArrayBufferLike>
  // do TS 5.7, que carrega SharedArrayBuffer no union e quebra BufferSource.
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export interface EncryptedBlob {
  iv: string;
  ct: string;
}

export async function encryptString(plain: string): Promise<EncryptedBlob> {
  const key = await deriveKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ctBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    ENCODER.encode(plain)
  );
  return {
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ctBuffer))
  };
}

export async function decryptString(blob: EncryptedBlob): Promise<string> {
  const key = await deriveKey();
  const iv = base64ToBytes(blob.iv);
  const ct = base64ToBytes(blob.ct);
  // ct.buffer pode ser SharedArrayBuffer no DOM lib do TS 5.7 — copia para ArrayBuffer puro.
  const ctBuffer = new ArrayBuffer(ct.length);
  new Uint8Array(ctBuffer).set(ct);
  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ctBuffer
  );
  return DECODER.decode(plainBuffer);
}
