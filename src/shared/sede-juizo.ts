/**
 * Resolução da sede do juízo — o "Cidade/UF" que fecha toda minuta
 * ("Sousa/PB, datado eletronicamente.").
 *
 * Motivação: até a v1.9.0 a cidade era *inferida pelo LLM* a partir dos
 * documentos dos autos, e o prompt trazia "Maracanaú/CE" como primeiro
 * exemplo. Quando o modelo não achava a cidade nos autos, ele caía no
 * exemplo — usuários fora do Ceará recebiam minutas fechadas em
 * "Maracanaú/CE". A correção é tratar a sede como DADO, resolvido aqui a
 * partir de fontes estruturadas, e nunca mais como inferência.
 *
 * Ordem de confiança das fontes:
 *   1. `jurisdicao` do PJe ("CE / Fortaleza") — capa dos autos ou
 *      endpoint `processos/{id}`. Traz cidade e UF explícitas.
 *   2. `nomeVara` das settings, e só quando o usuário escreveu a UF
 *      junto ("10ª Vara Federal de Sousa/PB").
 *   3. `orgaoJulgador` ("10ª Vara Federal de Sousa"), que costuma trazer
 *      o município mas quase nunca a UF.
 *
 * Quando nenhuma fonte resolve, devolvemos `null` e o prompt emite o
 * marcador `[Cidade]/[UF]` — erro visível na revisão, preferível a um
 * chute plausível que passa despercebido.
 */

/** Marcador emitido quando a sede não pôde ser resolvida. */
export const SEDE_JUIZO_PLACEHOLDER = '[Cidade]/[UF]';

export interface SedeJuizo {
  /** Município da sede (ex.: "Sousa"). Sempre presente. */
  municipio: string;
  /** Sigla da UF (ex.: "PB"). `null` quando a fonte não a expôs. */
  uf: string | null;
}

/** Fontes brutas, na ordem em que os callers conseguem obtê-las. */
export interface FontesSedeJuizo {
  /** Campo `Jurisdição` do PJe — formato "UF / Cidade". */
  jurisdicao?: string | null;
  /** `settings.comunicacao.nomeVara`, texto livre digitado pelo usuário. */
  nomeVara?: string | null;
  /** Campo `Órgão julgador` do PJe. */
  orgaoJulgador?: string | null;
}

const UF_SIGLAS = new Set([
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS',
  'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC',
  'SP', 'SE', 'TO'
]);

/**
 * Termos que aparecem depois de "de" em nomes de vara sem serem
 * município ("Vara Federal de Execução Fiscal"). Sem esta lista, a
 * heurística de `nomeVara`/`orgaoJulgador` produziria sedes absurdas —
 * exatamente a classe de erro que este módulo existe para evitar.
 */
const TERMOS_NAO_MUNICIPAIS = [
  'execu', 'juizado', 'compet', 'fazenda', 'família', 'familia', 'infân',
  'infan', 'justiça', 'justica', 'direito', 'crime', 'criminal', 'falên',
  'falen', 'registro', 'órfãos', 'orfaos', 'sucess', 'violên', 'violen',
  'turma', 'seção', 'secao', 'subseção', 'subsecao', 'plantão', 'plantao'
];

function normalizar(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function ehUf(s: string): boolean {
  return UF_SIGLAS.has(s.trim().toUpperCase());
}

function pareceMunicipio(nome: string): boolean {
  const n = nome.toLowerCase();
  if (n.length < 3) return false;
  return !TERMOS_NAO_MUNICIPAIS.some((t) => n.includes(t));
}

/**
 * "CE / Fortaleza" → `{municipio: 'Fortaleza', uf: 'CE'}`.
 * Aceita também a ordem invertida ("Fortaleza / CE"), que aparece em
 * alguns relatórios do PJe.
 */
export function parseJurisdicao(valor: string | null | undefined): SedeJuizo | null {
  if (!valor) return null;
  const partes = normalizar(valor).split('/').map((p) => p.trim()).filter(Boolean);
  if (partes.length !== 2) return null;

  const [a, b] = partes as [string, string];
  if (ehUf(a) && !ehUf(b)) return { municipio: b, uf: a.toUpperCase() };
  if (ehUf(b) && !ehUf(a)) return { municipio: a, uf: b.toUpperCase() };
  return null;
}

/**
 * Extrai a sede de um nome de vara/órgão julgador:
 *   "10ª Vara Federal de Sousa/PB" → {municipio: 'Sousa', uf: 'PB'}
 *   "10ª Vara Federal de Sousa"    → {municipio: 'Sousa', uf: null}
 *   "32ª Vara Federal CE"          → null (UF solta não é município)
 *   "Vara Federal de Execução Fiscal" → null (termo não-municipal)
 */
export function parseNomeOrgao(valor: string | null | undefined): SedeJuizo | null {
  if (!valor) return null;
  const texto = normalizar(valor);

  // Sufixo "/UF" quando presente, destacado antes de olhar o município.
  let uf: string | null = null;
  let corpo = texto;
  const mUf = texto.match(/[\/-]\s*([A-Za-z]{2})\s*$/);
  if (mUf && mUf.index !== undefined && ehUf(mUf[1]!)) {
    uf = mUf[1]!.toUpperCase();
    corpo = texto.slice(0, mUf.index).trim();
  }

  // Município vem depois da preposição "de/do/da" final.
  const mMun = corpo.match(/\bd[eoa]s?\s+(.+)$/i);
  if (!mMun) return null;

  const municipio = normalizar(mMun[1]!).replace(/[.,;]+$/, '');
  if (!municipio || !pareceMunicipio(municipio)) return null;

  return { municipio, uf };
}

/**
 * Aplica as fontes em ordem de confiança e devolve a primeira sede
 * utilizável. Uma sede com município mas sem UF ainda é útil: o prompt
 * pede ao modelo apenas a UF correspondente ao município (conhecimento
 * estável, que não depende dos autos).
 */
export function resolverSedeJuizo(fontes: FontesSedeJuizo): SedeJuizo | null {
  const daJurisdicao = parseJurisdicao(fontes.jurisdicao);
  if (daJurisdicao) return daJurisdicao;

  // `nomeVara` das settings vem antes do `orgaoJulgador` do PJe porque é
  // preenchido pelo próprio usuário para a unidade dele.
  const candidatos = [
    parseNomeOrgao(fontes.nomeVara),
    parseNomeOrgao(fontes.orgaoJulgador)
  ].filter((s): s is SedeJuizo => s !== null);

  // Prefere um candidato que traga a UF; senão aceita o primeiro.
  return candidatos.find((s) => s.uf !== null) ?? candidatos[0] ?? null;
}

/** Renderiza "Sousa/PB". Sem UF, devolve "Sousa/[UF]". */
export function formatarSedeJuizo(sede: SedeJuizo | null): string {
  if (!sede) return SEDE_JUIZO_PLACEHOLDER;
  return `${sede.municipio}/${sede.uf ?? '[UF]'}`;
}
