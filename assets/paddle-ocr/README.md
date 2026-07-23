# Modelos PP-OCR (OCR local do pAIdegua)

O motor de OCR local (offscreen document → PP-OCR via ONNX Runtime Web) carrega
**três arquivos locais** desta pasta. Eles NÃO estão versionados no repositório
(binários grandes) e precisam ser **baixados uma vez** antes do build. Nada é
baixado em runtime — a CSP do MV3 proíbe CDN e a imagem nunca sai da máquina
(regra CNJ/LGPD).

O offscreen (`src/offscreen/offscreen.ts`) espera **exatamente** estes nomes:

| Arquivo nesta pasta | Origem (repo `PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models`, tier tiny) |
|---------------------|-------------------------------------------------------------------------|
| `det.onnx`          | `detection/PP-OCRv6_tiny_det.onnx` (Git LFS)                             |
| `rec.onnx`          | `recognition/PP-OCRv6_tiny_rec.onnx` (Git LFS)                          |
| `dict.txt`          | `recognition/ppocrv6_tiny_dict.txt`                                     |

## Baixar (terminal cmd.exe — `curl.exe` já existe no Windows 11)

Os `.onnx` estão em **Git LFS**: baixe por `media.githubusercontent.com/media/...`
(o `raw.githubusercontent.com` devolve só o ponteiro LFS, não o binário). O
dicionário é texto normal, então vem por `raw.githubusercontent.com`.

```cmd
cd "%~dp0"  &rem  (ou: cd para esta pasta assets\paddle-ocr)

curl -L -o det.onnx  "https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main/detection/PP-OCRv6_tiny_det.onnx"
curl -L -o rec.onnx  "https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main/recognition/PP-OCRv6_tiny_rec.onnx"
curl -L -o dict.txt  "https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main/recognition/ppocrv6_tiny_dict.txt"
```

## Verificar

- `det.onnx` e `rec.onnx` devem ter **megabytes** (juntos ~6 MB). Se vierem com
  poucos **bytes**, você baixou o ponteiro LFS — refaça pela URL `media...`.
- `dict.txt` é um texto com um caractere por linha.
- Confirme os caminhos/nomes no repositório antes de baixar (podem variar por
  release); se o branch padrão não for `main`, ajuste na URL.

Depois do download, rode o build normal (`build.bat`). O `webpack.config.js` copia
esta pasta para `dist/assets/paddle-ocr/` (com `noErrorOnMissing`, então o build
passa mesmo sem os arquivos — mas o OCR só funciona com eles presentes).
