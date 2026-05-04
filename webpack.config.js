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
      // Bundle separado para o interceptor injetado em page-world (ver
      // segundo entry de content_scripts no manifest com `world: "MAIN"`).
      // Roda no contexto JS da SPA Angular do painel; sem chrome.* APIs.
      'pje-auth-page': './src/content/auth/pje-auth-interceptor-page.ts',
      // Probe passivo que inspeciona se o adapter Keycloak do Angular do
      // PJe esta expostao em `window`. Roda tambem em page world; relay
      // via bridge isolated-world para `chrome.storage.local`.
      'pje-auth-probe-page': './src/content/auth/pje-auth-probe-page.ts',
      // Silent SSO refresh (OIDC Authorization Code Flow com prompt=none).
      // Roda em page world do iframe Angular (frontend-prd.<tribunal>.jus.br)
      // para que o redirect_uri do iframe seja same-origin e o POST de
      // token exchange saia do Origin aceito pelo client Keycloak.
      'pje-auth-refresh-page': './src/content/auth/pje-auth-refresh-page.ts',
      // Executa o POST de vinculação de etiqueta no page world do iframe
      // Angular. O isolated world do content script é silenciosamente
      // rejeitado pelo PJe para esse endpoint específico; o page world
      // (mesmo contexto do Angular) passa normalmente.
      'pericias-etiqueta-page': './src/content/pericias/pericias-etiqueta-page.ts',
      'popup/popup': './src/popup/popup.ts',
      'options/options': './src/options/options.ts',
      'dashboard/dashboard': './src/dashboard/dashboard.ts',
      'gestao-dashboard/gestao-dashboard': './src/gestao-dashboard/gestao-dashboard.ts',
      'gestao-painel/painel': './src/gestao-painel/painel.ts',
      'pericias-painel/painel': './src/pericias-painel/painel.ts',
      'pericias-dashboard/pericias-dashboard': './src/pericias-dashboard/pericias-dashboard.ts',
      'prazos-fita-dashboard/prazos-fita-dashboard': './src/prazos-fita-dashboard/prazos-fita-dashboard.ts',
      'save-template/save': './src/save-template/save.ts',
      'diagnostico/diagnostico': './src/diagnostico/diagnostico.ts',
      'suporte/suporte': './src/suporte/suporte.ts',
      'welcome/welcome': './src/welcome/welcome.ts',
      'criminal-config/criminal-config': './src/criminal-config/criminal-config.ts',
      'criminal-painel/painel': './src/criminal-painel/painel.ts',
      'criminal-dashboard/dashboard': './src/criminal-dashboard/dashboard.ts',
      'metas-painel/painel': './src/metas-painel/painel.ts',
      'metas-dashboard/dashboard': './src/metas-dashboard/dashboard.ts',
      'comunicacao-painel/painel': './src/comunicacao-painel/painel.ts',
      'audiencia-painel/painel': './src/audiencia-painel/painel.ts'
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
        '@background': path.resolve(__dirname, 'src/background'),
        // Substitui o `regenerator-runtime/runtime` original por uma
        // versão sem o fallback `Function("r", ...)(runtime)` que
        // dispara warning de CSP no service worker MV3. Detalhes no
        // próprio arquivo do shim. Tesseract.js v5+ traz esse runtime
        // em seu bundle; sem o alias, o erro aparece em chrome://
        // extensions sempre que o content.js é carregado.
        'regenerator-runtime/runtime.js': path.resolve(
          __dirname,
          'src/shims/regenerator-runtime-csp-safe.js'
        ),
        'regenerator-runtime/runtime': path.resolve(
          __dirname,
          'src/shims/regenerator-runtime-csp-safe.js'
        )
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
          { from: 'src/gestao-dashboard/gestao-dashboard.html', to: 'gestao-dashboard/gestao-dashboard.html' },
          { from: 'src/gestao-dashboard/gestao-dashboard.css', to: 'gestao-dashboard/gestao-dashboard.css' },
          { from: 'src/gestao-painel/painel.html', to: 'gestao-painel/painel.html' },
          { from: 'src/gestao-painel/painel.css', to: 'gestao-painel/painel.css' },
          { from: 'src/pericias-painel/painel.html', to: 'pericias-painel/painel.html' },
          { from: 'src/pericias-painel/painel.css', to: 'pericias-painel/painel.css' },
          { from: 'src/pericias-dashboard/pericias-dashboard.html', to: 'pericias-dashboard/pericias-dashboard.html' },
          { from: 'src/pericias-dashboard/pericias-dashboard.css', to: 'pericias-dashboard/pericias-dashboard.css' },
          { from: 'src/prazos-fita-dashboard/prazos-fita-dashboard.html', to: 'prazos-fita-dashboard/prazos-fita-dashboard.html' },
          { from: 'src/prazos-fita-dashboard/prazos-fita-dashboard.css', to: 'prazos-fita-dashboard/prazos-fita-dashboard.css' },
          { from: 'src/save-template/save.html', to: 'save-template/save.html' },
          { from: 'src/save-template/save.css', to: 'save-template/save.css' },
          { from: 'src/diagnostico/diagnostico.html', to: 'diagnostico/diagnostico.html' },
          { from: 'src/diagnostico/diagnostico.css', to: 'diagnostico/diagnostico.css' },
          { from: 'src/suporte/suporte.html', to: 'suporte/suporte.html' },
          { from: 'src/suporte/suporte.css', to: 'suporte/suporte.css' },
          { from: 'src/welcome/welcome.html', to: 'welcome/welcome.html' },
          { from: 'src/welcome/welcome.css', to: 'welcome/welcome.css' },
          { from: 'src/criminal-config/criminal-config.html', to: 'criminal-config/criminal-config.html' },
          { from: 'src/criminal-config/criminal-config.css', to: 'criminal-config/criminal-config.css' },
          { from: 'src/criminal-painel/painel.html', to: 'criminal-painel/painel.html' },
          { from: 'src/criminal-painel/painel.css', to: 'criminal-painel/painel.css' },
          { from: 'src/criminal-dashboard/dashboard.html', to: 'criminal-dashboard/dashboard.html' },
          { from: 'src/criminal-dashboard/dashboard.css', to: 'criminal-dashboard/dashboard.css' },
          { from: 'src/metas-painel/painel.html', to: 'metas-painel/painel.html' },
          { from: 'src/metas-painel/painel.css', to: 'metas-painel/painel.css' },
          { from: 'src/metas-dashboard/dashboard.html', to: 'metas-dashboard/dashboard.html' },
          { from: 'src/metas-dashboard/dashboard.css', to: 'metas-dashboard/dashboard.css' },
          { from: 'src/comunicacao-painel/painel.html', to: 'comunicacao-painel/painel.html' },
          { from: 'src/comunicacao-painel/painel.css', to: 'comunicacao-painel/painel.css' },
          { from: 'src/audiencia-painel/painel.html', to: 'audiencia-painel/painel.html' },
          { from: 'src/audiencia-painel/painel.css', to: 'audiencia-painel/painel.css' },
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
