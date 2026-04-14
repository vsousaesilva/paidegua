/**
 * Helper genérico para consumir respostas SSE (Server-Sent Events) do
 * fetch streaming. Compartilhado entre os provedores Anthropic e OpenAI.
 *
 * Cada evento SSE chega no formato:
 *   data: {json}\n\n
 * (com possíveis linhas de comentário começando por ":" e linhas "event:")
 */

export interface SseEvent {
  event?: string;
  data: string;
}

export async function* parseSseStream(
  response: Response,
  signal: AbortSignal
): AsyncGenerator<SseEvent, void, void> {
  if (!response.body) {
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel();
        return;
      }
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      // Normaliza CRLF→LF — o Gemini emite eventos separados por \r\n\r\n,
      // enquanto OpenAI/Anthropic usam \n\n. Sem isso, o split abaixo falha
      // no Gemini e dois eventos consecutivos são unidos no mesmo bloco,
      // gerando JSON inválido em parseEventBlock.
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      // Processa eventos completos (separados por linha em branco).
      let separatorIdx: number;
      while ((separatorIdx = buffer.indexOf('\n\n')) >= 0) {
        const rawEvent = buffer.slice(0, separatorIdx);
        buffer = buffer.slice(separatorIdx + 2);
        const event = parseEventBlock(rawEvent);
        if (event) {
          yield event;
        }
      }
    }
    // Flush final
    if (buffer.trim().length > 0) {
      const event = parseEventBlock(buffer);
      if (event) {
        yield event;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function parseEventBlock(block: string): SseEvent | null {
  const lines = block.split('\n');
  let eventName: string | undefined;
  const dataParts: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataParts.push(line.slice(5).trim());
    }
  }
  if (dataParts.length === 0) {
    return null;
  }
  return { event: eventName, data: dataParts.join('\n') };
}
