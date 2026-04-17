const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

/**
 * Webpack build da extensão PJeIA.
 *
 * Gera três bundles principais em `dist/`:
 *  - background.js (service worker MV3)
 *  - content.js    (content script injetado nas páginas do PJe)
 *  - popup/popup.js (tela de configurações)
 *
 * Arquivos estáticos (manifest, ícones, HTML/CSS do popup, CSS do content)
 * são copiados para dentro de `dist/` para que a pasta seja carregável
 * diretamente no Chrome via "Carregar sem compactação".
 */
module.exports = (_env, argv) => {
  const isProd = argv.mode === 'production';

  return {
    entry: {
      background: './src/background/background.ts',
      content: './src/content/content.ts',
      'popup/popup': './src/popup/popup.ts',
      'options/options': './src/options/options.ts',
      'dashboard/dashboard': './src/dashboard/dashboard.ts'
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      clean: true
    },
    devtool: isProd ? false : 'inline-source-map',
    resolve: {
      extensions: ['.ts', '.js'],
      alias: {
        '@shared': path.resolve(__dirname, 'src/shared'),
        '@content': path.resolve(__dirname, 'src/content'),
        '@background': path.resolve(__dirname, 'src/background')
      }
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          loader: 'ts-loader',
          exclude: /node_modules/
        }
      ]
    },
    plugins: [
      new CopyPlugin({
        patterns: [
          { from: 'manifest.json', to: 'manifest.json' },
          { from: 'icons', to: 'icons' },
          { from: 'src/popup/popup.html', to: 'popup/popup.html' },
          { from: 'src/popup/popup.css', to: 'popup/popup.css' },
          { from: 'src/options/options.html', to: 'options/options.html' },
          { from: 'src/options/options.css', to: 'options/options.css' },
          { from: 'src/dashboard/dashboard.html', to: 'dashboard/dashboard.html' },
          { from: 'src/dashboard/dashboard.css', to: 'dashboard/dashboard.css' },
          { from: 'src/content/content.css', to: 'content.css' },
          // PDF.js worker precisa ser servido como arquivo acessivel via
          // chrome.runtime.getURL. Listado em web_accessible_resources
          // (libs/*) no manifest.
          {
            from: 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
            to: 'libs/pdf.worker.min.mjs'
          },
          // Tesseract.js: worker + core (wasm) precisam ser servidos via
          // chrome.runtime.getURL porque rodam dentro de Web Workers criados
          // a partir do content script. Usamos a variante SIMD+LSTM que é
          // a mais rápida em browsers modernos.
          {
            from: 'node_modules/tesseract.js/dist/worker.min.js',
            to: 'libs/tesseract/worker.min.js'
          },
          {
            from: 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.js',
            to: 'libs/tesseract/tesseract-core-simd-lstm.js'
          },
          {
            from: 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
            to: 'libs/tesseract/tesseract-core-simd-lstm.wasm.js'
          },
          {
            from: 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm',
            to: 'libs/tesseract/tesseract-core-simd-lstm.wasm'
          },
          // Modelo português bundle-ado localmente (sem dependência de rede).
          {
            from: 'assets/tesseract/por.traineddata',
            to: 'libs/tesseract/por.traineddata'
          }
        ]
      })
    ],
    performance: {
      hints: false
    }
  };
};
