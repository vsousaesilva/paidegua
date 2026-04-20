/**
 * Probe do adapter Keycloak no page world do PJe.
 *
 * Objetivo: descobrir se a aplicacao Angular do PJe expoe uma instancia
 * viva do `keycloak-js` (ou compativel) em algum caminho enumeravel do
 * `window`, de forma que um refresh proativo possa ser chamado do
 * isolated world via CustomEvent — eliminando a dependencia de interacao
 * do usuario em varreduras longas do "Prazos na Fita".
 *
 * Comportamento: PASSIVO. So inspeciona; nunca chama `updateToken`. O
 * relatorio e despachado via `CustomEvent('paidegua:kc-probe')` no
 * `document` e o bridge isolated-world (`pje-auth-interceptor.ts`)
 * persiste em `chrome.storage.local` para o painel de Diagnostico.
 *
 * Estrategia de timing: o adapter costuma inicializar junto com o bootstrap
 * Angular. Rodamos a sondagem em 3 momentos (2s, 8s, 20s apos o load) para
 * cobrir lazy-init sem atrasar resultados obvios. Guardamos apenas o melhor
 * relatorio (primeiro com `foundAny: true`, ou o ultimo se nenhum achar).
 *
 * Idempotente: guard em window global evita probe duplicado se o script
 * for re-injetado (ex.: iframe secundario).
 */

interface KeycloakCandidate {
  /** Caminho onde encontramos o objeto. Ex.: `window.keycloak`. */
  path: string;
  hasUpdateToken: boolean;
  hasToken: boolean;
  hasTokenParsed: boolean;
  hasRefreshToken: boolean;
  authServerUrl: string | null;
  realm: string | null;
  clientId: string | null;
  /** Expira (epoch s) do token atual, extraido de `tokenParsed.exp` quando disponivel. */
  tokenExp: number | null;
}

interface IframeInfo {
  src: string;
  id: string | null;
  name: string | null;
  hidden: boolean;
}

interface AngularProbe {
  /** Atributo `[ng-version]` em qualquer elemento (indica Angular 2+). */
  ngVersionAttr: string | null;
  /** `window.ng` existe? Ivy debug APIs disponiveis. */
  hasNgGlobal: boolean;
  /** Achamos root Angular elements via `ng.getAllAngularRootElements`? */
  rootCount: number;
  /** `Zone` (zone.js) em window? */
  hasZone: boolean;
}

interface KeycloakProbeReport {
  timestamp: number;
  url: string;
  angularVersion: string | null;
  foundAny: boolean;
  candidates: KeycloakCandidate[];
  attemptedPaths: string[];
  /** Quantas passagens da sondagem foram realizadas ate encontrar (ou desistir). */
  passes: number;
  /** Investigacao extra quando nenhum candidato direto e achado. */
  localStorageKeys: string[];
  sessionStorageKeys: string[];
  cookieNames: string[];
  iframes: IframeInfo[];
  angular: AngularProbe;
  /** Issuer do JWT capturado (decode passivo do payload do Bearer). */
  jwtIssuer: string | null;
  jwtExp: number | null;
  jwtAzp: string | null;
}

interface ProbeInstalledFlagWindow {
  __paideguaKcProbeInstalled?: boolean;
}

(() => {
  const LOG = '[pAIdegua][kc-probe]';
  const w = window as unknown as ProbeInstalledFlagWindow;
  if (w.__paideguaKcProbeInstalled) {
    console.log(`${LOG} ja instalado, ignorando.`);
    return;
  }
  w.__paideguaKcProbeInstalled = true;
  console.log(`${LOG} instalado em ${window.location.href}`);

  const DIRECT_PATHS = [
    'keycloak',
    'Keycloak',
    '_keycloak',
    'kc',
    'auth',
    'keycloakInstance',
    'authKeycloak'
  ];

  function inspectCandidate(path: string, obj: unknown): KeycloakCandidate | null {
    if (!obj || typeof obj !== 'object') return null;
    const o = obj as Record<string, unknown>;
    const hasUpdateToken = typeof o.updateToken === 'function';
    const hasToken = typeof o.token === 'string' && (o.token as string).length > 0;
    const hasTokenParsed = o.tokenParsed != null && typeof o.tokenParsed === 'object';
    const hasRefreshToken =
      typeof o.refreshToken === 'string' && (o.refreshToken as string).length > 0;
    // Duck-typing: precisa de pelo menos um indicio forte pra ser candidato.
    if (!hasUpdateToken && !hasToken && !hasTokenParsed && !hasRefreshToken) {
      return null;
    }
    let tokenExp: number | null = null;
    if (hasTokenParsed) {
      const tp = o.tokenParsed as Record<string, unknown>;
      if (typeof tp.exp === 'number') tokenExp = tp.exp;
    }
    return {
      path,
      hasUpdateToken,
      hasToken,
      hasTokenParsed,
      hasRefreshToken,
      authServerUrl:
        typeof o.authServerUrl === 'string' ? (o.authServerUrl as string) : null,
      realm: typeof o.realm === 'string' ? (o.realm as string) : null,
      clientId: typeof o.clientId === 'string' ? (o.clientId as string) : null,
      tokenExp
    };
  }

  function detectAngularVersion(): string | null {
    try {
      const el = document.querySelector('[ng-version]');
      return el ? el.getAttribute('ng-version') : null;
    } catch {
      return null;
    }
  }

  function probeAngular(): AngularProbe {
    const out: AngularProbe = {
      ngVersionAttr: detectAngularVersion(),
      hasNgGlobal: false,
      rootCount: 0,
      hasZone: false
    };
    try {
      const win = window as unknown as Record<string, unknown>;
      out.hasNgGlobal = typeof win.ng === 'object' && win.ng != null;
      out.hasZone = typeof win.Zone === 'object' && win.Zone != null;
      // Ivy debug: getAllAngularRootElements vive em `ng` ou `ng.probe`.
      const ng = win.ng as Record<string, unknown> | undefined;
      if (ng && typeof ng.getAllAngularRootElements === 'function') {
        const roots = (ng.getAllAngularRootElements as () => unknown[])();
        if (Array.isArray(roots)) out.rootCount = roots.length;
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  function listStorageKeys(s: Storage | null): string[] {
    if (!s) return [];
    try {
      const keys: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k != null) keys.push(k);
      }
      return keys;
    } catch {
      return [];
    }
  }

  function listCookieNames(): string[] {
    try {
      const raw = document.cookie;
      if (!raw) return [];
      return raw
        .split(';')
        .map((seg) => seg.trim().split('=')[0])
        .filter((name) => name.length > 0);
    } catch {
      return [];
    }
  }

  function listIframes(): IframeInfo[] {
    try {
      const nodes = Array.from(document.querySelectorAll('iframe'));
      return nodes.map((n) => {
        const hidden =
          n.hasAttribute('hidden') ||
          n.style.display === 'none' ||
          n.style.visibility === 'hidden' ||
          n.width === '0' ||
          n.height === '0';
        return {
          src: n.getAttribute('src') ?? '',
          id: n.getAttribute('id'),
          name: n.getAttribute('name'),
          hidden
        };
      });
    } catch {
      return [];
    }
  }

  function decodeJwtIssuer(): {
    issuer: string | null;
    exp: number | null;
    azp: string | null;
  } {
    // Olha o snapshot corrente em storage.session — mas estamos em page
    // world, sem chrome.*. Alternativa: procurar cookies ou memoria. Nao
    // temos acesso ao token do Angular aqui. Portanto extraimos do
    // nosso proprio interceptor: ele tambem ficou em page world e grava
    // `window.__paideguaLastAuth` (idempotente, sem comprometer privacidade
    // — so o proprio processo tem acesso).
    try {
      const win = window as unknown as Record<string, unknown>;
      const cached = win.__paideguaLastAuth as
        | { authorization?: string }
        | undefined;
      if (!cached?.authorization) return { issuer: null, exp: null, azp: null };
      const match = cached.authorization.match(/Bearer\s+([A-Za-z0-9._-]+)/);
      if (!match) return { issuer: null, exp: null, azp: null };
      const parts = match[1].split('.');
      if (parts.length < 2) return { issuer: null, exp: null, azp: null };
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '==='.slice(0, (4 - (b64.length % 4)) % 4);
      const json = atob(padded);
      const payload = JSON.parse(json) as Record<string, unknown>;
      return {
        issuer: typeof payload.iss === 'string' ? payload.iss : null,
        exp: typeof payload.exp === 'number' ? payload.exp : null,
        azp: typeof payload.azp === 'string' ? payload.azp : null
      };
    } catch {
      return { issuer: null, exp: null, azp: null };
    }
  }

  function runProbe(passes: number): KeycloakProbeReport {
    const jwt = decodeJwtIssuer();
    const report: KeycloakProbeReport = {
      timestamp: Date.now(),
      url: window.location.href,
      angularVersion: detectAngularVersion(),
      foundAny: false,
      candidates: [],
      attemptedPaths: [],
      passes,
      localStorageKeys: listStorageKeys(
        (() => {
          try {
            return window.localStorage;
          } catch {
            return null;
          }
        })()
      ),
      sessionStorageKeys: listStorageKeys(
        (() => {
          try {
            return window.sessionStorage;
          } catch {
            return null;
          }
        })()
      ),
      cookieNames: listCookieNames(),
      iframes: listIframes(),
      angular: probeAngular(),
      jwtIssuer: jwt.issuer,
      jwtExp: jwt.exp,
      jwtAzp: jwt.azp
    };
    const win = window as unknown as Record<string, unknown>;
    // 1) Tentativa por caminhos diretos conhecidos.
    for (const p of DIRECT_PATHS) {
      report.attemptedPaths.push(`window.${p}`);
      const c = inspectCandidate(`window.${p}`, win[p]);
      if (c) report.candidates.push(c);
    }
    // 2) Varredura rasa de chaves do `window` buscando duck-type keycloak-js.
    //    Alguns bundles Angular guardam a instancia em nomes gerados (ex.:
    //    `__NG_AUTH__`) ou em namespaces. Limite raso pra nao impactar load.
    try {
      const keys = Object.keys(win);
      for (const key of keys) {
        if (DIRECT_PATHS.includes(key)) continue;
        // Filtro de custo: ignora chaves minusculas muito genericas. Custaria
        // pouco, mas reduz falsos positivos quando algum global aleatorio
        // expoe um `.updateToken` nao relacionado.
        const val = win[key];
        if (!val || typeof val !== 'object') continue;
        const rec = val as Record<string, unknown>;
        // Duck-type estrito: precisa de `updateToken` + pelo menos `token`
        // ou `tokenParsed`. Evita capturar objetos aleatorios com
        // `updateToken` em outras bibliotecas.
        if (typeof rec.updateToken !== 'function') continue;
        if (typeof rec.token !== 'string' && rec.tokenParsed == null) continue;
        report.attemptedPaths.push(`window.${key}`);
        const c = inspectCandidate(`window.${key}`, val);
        if (c) report.candidates.push(c);
      }
    } catch {
      /* ignore: enumerar window pode lancar em alguns setups com Proxy */
    }
    report.foundAny = report.candidates.some((c) => c.hasUpdateToken);
    return report;
  }

  let melhor: KeycloakProbeReport | null = null;
  let passes = 0;

  function dispatch(report: KeycloakProbeReport): void {
    try {
      document.dispatchEvent(
        new CustomEvent('paidegua:kc-probe', { detail: report })
      );
    } catch {
      /* ignore: nunca quebrar a SPA host */
    }
  }

  function tick(): void {
    passes++;
    const r = runProbe(passes);
    // Guarda o melhor (primeiro foundAny, ou ultimo caso todos negativos).
    if (!melhor || (r.foundAny && !melhor.foundAny)) {
      melhor = r;
    } else if (!melhor.foundAny) {
      melhor = r;
    }
    dispatch(r);
  }

  // Schedule. Nao dependemos de DOMContentLoaded — setTimeout funciona em
  // `document_start` normalmente. Se a pagina ainda estiver carregando em
  // `t=20s` o probe ainda vai rodar e capturar o estado atual do window.
  setTimeout(tick, 2_000);
  setTimeout(tick, 8_000);
  setTimeout(tick, 20_000);
})();
