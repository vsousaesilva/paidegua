/**
 * Baixa por.traineddata (modelo OCR português) do repositório oficial tessdata
 * para assets/tesseract/. Roda apenas uma vez — o arquivo é versionado no
 * projeto para evitar dependência de rede em builds subsequentes (ambiente
 * JFCE sem internet confiável).
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

// tessdata_fast é ~1MB vs ~15MB do tessdata "best" — melhor escolha para
// OCR no browser (menor, mais rápido, precisão suficiente para peças processuais).
const URL = 'https://github.com/tesseract-ocr/tessdata_fast/raw/main/por.traineddata';
const OUT_DIR = path.join(__dirname, '..', 'assets', 'tesseract');
const OUT_FILE = path.join(OUT_DIR, 'por.traineddata');

function get(url, cb) {
  https.get(url, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      return get(res.headers.location, cb);
    }
    if (res.statusCode !== 200) {
      console.error('[PJeIA] HTTP', res.statusCode, 'on', url);
      process.exit(1);
    }
    cb(res);
  }).on('error', (err) => {
    console.error('[PJeIA] Erro de rede:', err.message);
    process.exit(1);
  });
}

fs.mkdirSync(OUT_DIR, { recursive: true });

if (fs.existsSync(OUT_FILE)) {
  const size = fs.statSync(OUT_FILE).size;
  console.log(`[PJeIA] por.traineddata já existe (${size} bytes). Pulando download.`);
  process.exit(0);
}

console.log('[PJeIA] Baixando por.traineddata de', URL);
get(URL, (res) => {
  const out = fs.createWriteStream(OUT_FILE);
  res.pipe(out);
  out.on('finish', () => {
    const size = fs.statSync(OUT_FILE).size;
    console.log(`[PJeIA] por.traineddata salvo em assets/tesseract/ (${size} bytes)`);
  });
});