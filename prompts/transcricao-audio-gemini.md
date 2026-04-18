---
arquivo-fonte: src/background/providers/gemini.ts
linhas: 195
tipo: string literal em chamada `generateContent` multimodal
variáveis: nenhuma (o áudio é anexado como `inlineData` base64 na mesma `parts`)
uso: fluxo STT (speech-to-text) — botão de ditado do chat quando o provedor ativo é Gemini. Para OpenAI, o STT usa o endpoint dedicado `audio/transcriptions` (Whisper), sem prompt textual.
---

# Transcrição de áudio — Gemini multimodal

Transcreva fielmente este áudio em português brasileiro. Responda apenas com a transcrição, sem comentários.
