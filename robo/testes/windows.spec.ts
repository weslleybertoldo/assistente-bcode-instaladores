// Robô do Windows (W7): testa o Assistente · B Code instalado de um release deste repositório, de fora
// pra dentro, como um cliente. Roda no GitHub Actions (windows-2025) pelo .github/workflows/robo-windows.yml:
//   @teste        instala, passeia pelas abas do menu em 1366x768 e 1920x1080, confere fusíveis e integridade
//                 e desinstala
//   @atualizacao  instala a versão anterior (N) e atualiza pelo próprio app até a nova (N+1), pelo clique,
//                 com o print da caixa do 'Instalar agora' e o log windows_atualizacao_teste.log
//   @oficial      instala o oficial, confere os fusíveis, abre sem o Playwright, integridade e desinstala
// Entradas pelo ambiente: ROBO_TIPO (teste | oficial), ROBO_TAG (v<versão>) e ROBO_ANTERIOR (só no teste).
// Prints em robo/prints (o workflow guarda como 'prints-windows'). O registro é público: o app abre com
// a pasta de dados vazia (sem nome e sem chave) e o log só leva versão e estado.
// Os textos da seção Atualizações são os da tela do app (renderer/fluxos/atualizacao/textos.ts no
// repositório do app): mudou lá, muda aqui.
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as esperar } from 'node:timers/promises'
import {
  ARQUIVO_QUE_A_ABERTURA_NAO_LE,
  TITULO_DO_PAINEL,
  VARIANTES,
  abrirSemPlaywright,
  ambienteDoApp,
  compararVersoes,
  copiarPasta,
  desinstalar,
  esperarFimSemJanela,
  esperarJanela,
  esperarProcessoPrincipal,
  esperarRegistro,
  fecharProcessosDaPasta,
  fusiveisEsperados,
  instalar,
  lerEntradas,
  lerFusiveis,
  lerRegistro,
  limparDadosDoApp,
  mexerNoCabecalhoDoAsar,
  minimizarTudo,
  mudarResolucao,
  nomeDoInstalador,
  pastaDaInstalacao,
  printDaTela,
  semCaixaDeErroDoWindows,
  type Registro,
  type Variante,
} from '../apoio/windows'

const RAIZ = resolve(__dirname, '..')
const PASTA_DOS_PRINTS = join(RAIZ, 'prints')
/** O workflow baixa aqui os instaladores do release (da tag e da anterior). */
const PASTA_DOS_INSTALADORES = join(RAIZ, 'instaladores')

/** O app de teste procura versão nova na rota de produção, que aponta pros anexos deste repositório. */
const ROTA_DO_CANAL_TESTE = 'https://assistente.bcode.software/api/atualizacao/teste/teste.yml'
const ANEXOS = 'https://github.com/weslleybertoldo/assistente-bcode-instaladores/releases/download'

/** Desde a W5 o app abre 2 janelas (painel e barra): o painel se acha pelo endereço. */
const ENDERECO_DO_PAINEL = '/painel/index.html'

/**
 * Os estados da seção Ajustes › Atualizações pelo texto da tela, do mais forte pro mais fraco: o estado é
 * o 1º desta lista cujo texto aparece na seção.
 */
const ESTADOS = {
  desligada: 'não procura versão nova sozinha',
  recusada: 'A atualização foi recusada',
  semAtualizacao: 'Sem atualização agora',
  instalando: 'Preparando a instalação',
  pronta: 'Pronta pra instalar',
  conferindo: 'Conferindo o arquivo',
  baixando: 'Baixando a versão',
  encontrada: 'encontrada.',
  procurando: 'Procurando versão nova',
  emDia: 'Você está na versão mais nova.',
  nuncaProcurou: 'Ainda não procurei versão nova',
} as const
type Estado = keyof typeof ESTADOS
const ORDEM_DOS_ESTADOS = Object.keys(ESTADOS) as Estado[]
/** Onde começam as notas da versão na seção: texto livre, que pode repetir qualquer frase da tela. */
const NOTAS = 'O que muda'
/** Algum estado já desenhado na seção (antes disso ela mostra o esqueleto). */
const ALGUM_ESTADO = new RegExp(Object.values(ESTADOS).map((texto) => texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'))
/** Estados parados (não mudam sozinhos por 1 h ou mais): se aparecerem no lugar do esperado, falha na hora. */
const PARADOS: readonly Estado[] = ['recusada', 'semAtualizacao', 'desligada']

const caminhoDoPrint = (nome: string): string => join(PASTA_DOS_PRINTS, `${nome}.png`)
const instalador = (variante: Variante, versao: string): string => join(PASTA_DOS_INSTALADORES, nomeDoInstalador(variante, versao))
const limparTexto = (texto: string): string => texto.replace(/\s+/g, ' ').trim()

/** Anota um evento no log do teste. */
type Anotar = (evento: string) => void

/**
 * Log de um teste em robo/prints/<nome>.log (vai no artefato 'prints-windows' e sai também no registro):
 * 1 linha por evento, com a hora UTC. Só versão e estado, nada da pasta de dados do app.
 */
function abrirLog(nome: string): Anotar {
  const arquivo = join(PASTA_DOS_PRINTS, `${nome}.log`)
  mkdirSync(PASTA_DOS_PRINTS, { recursive: true })
  writeFileSync(arquivo, '')
  return (evento) => {
    const linha = `${new Date().toISOString()} ${evento}`
    appendFileSync(arquivo, `${linha}\n`)
    console.log(`[${nome}] ${linha}`)
  }
}

// ---------------------------------------------------------------- apoio dos testes

/** Por usuário, na pasta certa, com o nome do produto e o .exe de nome ASCII. Devolve o .exe. */
function conferirInstalacao(variante: Variante, registro: Registro, versao: string): string {
  expect(registro.nome, 'nome no Painel de Controle').toBe(`${variante.produto} ${versao}`)
  expect(registro.pasta.toLowerCase(), 'instalação por usuário').toBe(pastaDaInstalacao(variante).toLowerCase())
  const exe = join(registro.pasta, `${variante.nome}.exe`)
  expect(existsSync(exe), `${variante.nome}.exe na pasta instalada`).toBe(true)
  return exe
}

interface AppAberto {
  app: ElectronApplication
  janela: Page
  fechar(): Promise<void>
}

/** A janela do painel pelo endereço (a barra também nasce na abertura e às vezes chega antes). */
async function esperarOPainel(app: ElectronApplication): Promise<Page> {
  const achar = () => app.windows().find((pagina) => pagina.url().includes(ENDERECO_DO_PAINEL))
  await expect.poll(() => achar() !== undefined, { timeout: 60_000, message: 'a janela do painel não abriu' }).toBe(true)
  const janela = achar()
  if (!janela) throw new Error('a janela do painel não abriu')
  await janela.waitForLoadState('domcontentloaded')
  return janela
}

/**
 * Abre o app instalado pelo Playwright (só o teste: o oficial fecha o inspetor), sem nenhum ajuste de
 * teste do app: pasta de dados e atualizador de verdade, como um cliente.
 */
async function abrirPeloPlaywright(exe: string, pasta: string): Promise<AppAberto> {
  const app = await electron.launch({ executablePath: exe, chromiumSandbox: true, env: ambienteDoApp(), timeout: 60_000 })
  const fechar = async (): Promise<void> => {
    await app.close().catch(() => undefined)
    await fecharProcessosDaPasta(pasta)
  }
  try {
    return { app, janela: await esperarOPainel(app), fechar }
  } catch (erro) {
    await fechar()
    throw erro
  }
}

const versaoDoApp = (app: ElectronApplication): Promise<string> => app.evaluate(({ app: aplicativo }) => aplicativo.getVersion())

/** A casca e a saudação do Início na tela (e 1 s pras animações de entrada). */
async function esperarOInicio(janela: Page): Promise<void> {
  await expect(janela.getByRole('navigation', { name: 'Menu principal' })).toBeVisible({ timeout: 60_000 })
  await expect(janela.locator('[data-inicio="saudacao"] h1')).toBeVisible({ timeout: 60_000 })
  await esperar(1_000)
}

/**
 * Os avisos de erro na janela: o EstadoDeErro do app (role alert) e qualquer 'Tentar de novo' (o bloco do
 * Início que não carregou mostra o botão sem ser alert). Do botão vem o bloco dele, pra ler o que houve.
 */
const avisosDeErro = (janela: Page): Locator =>
  janela.getByRole('alert').or(janela.getByRole('button', { name: 'Tentar de novo' }).locator('..'))

/**
 * Passeio pelo 'Menu principal', na ordem do menu: cada link abre a aba dele (o link fica como a página
 * atual), com o título (h1), sem aviso de erro e sem rolagem de lado (na janela e no conteúdo da casca,
 * o [data-casca="conteudo"] do app). As conferências de cada aba são suaves: o registro mostra todas as
 * abas com problema na mesma rodada e o teste falha no fim do mesmo jeito. `prints` = aba → nome do print
 * da janela (a aba é o que vem depois do '#/' no endereço do link).
 */
async function passearPelasAbas(janela: Page, resolucao: string, prints: Readonly<Record<string, string>>): Promise<void> {
  const links = janela.getByRole('navigation', { name: 'Menu principal' }).getByRole('link')
  const conteudo = janela.locator('[data-casca="conteudo"]')
  const vistas: string[] = []
  const total = await links.count()
  for (let i = 0; i < total; i++) {
    const link = links.nth(i)
    const aba = /#\/([^/?#]+)/.exec((await link.getAttribute('href')) ?? '')?.[1]
    if (aba === undefined) throw new Error(`o ${i + 1}º link do menu não leva a uma aba`)
    await link.click()
    await expect(link, `a aba ${aba} não abriu (${resolucao})`).toHaveAttribute('aria-current', 'page')
    await expect.soft(conteudo.getByRole('heading', { level: 1 }).first(), `o título (h1) da aba ${aba} em ${resolucao}`).toBeVisible()
    await esperar(1_500) // a aba termina de carregar e de entrar (animação)
    const erros = (await avisosDeErro(janela).allInnerTexts()).map(limparTexto)
    expect.soft(erros, `aviso de erro na aba ${aba} em ${resolucao}`).toEqual([])
    const folga = await janela.evaluate(() => {
      const areaDoConteudo = document.querySelector<HTMLElement>('[data-casca="conteudo"]')
      if (areaDoConteudo === null) return null
      return {
        pagina: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        conteudo: areaDoConteudo.scrollWidth - areaDoConteudo.clientWidth,
      }
    })
    if (folga === null) throw new Error('a casca do app não tem mais a área do conteúdo ([data-casca="conteudo"])')
    expect.soft(folga.pagina, `rolagem de lado na janela, aba ${aba} em ${resolucao}`).toBeLessThanOrEqual(2)
    expect.soft(folga.conteudo, `rolagem de lado no conteúdo, aba ${aba} em ${resolucao}`).toBeLessThanOrEqual(2)
    const print = prints[aba]
    if (print !== undefined) await janela.screenshot({ path: caminhoDoPrint(print) })
    vistas.push(aba)
  }
  const faltam = Object.keys(prints).filter((aba) => !vistas.includes(aba))
  if (faltam.length > 0) throw new Error(`o menu não tem a aba ${faltam.join(', ')} (abas: ${vistas.join(', ') || 'nenhuma'})`)
  console.log(`[passeio ${resolucao}] ${vistas.length} abas: ${vistas.join(', ')}`)
}

/** Ajustes › Atualizações: a seção à vista, já com algum estado, e o atualizador ligado. */
async function abrirAtualizacoes(janela: Page): Promise<Locator> {
  await janela.getByRole('navigation', { name: 'Menu principal' }).getByRole('link', { name: 'Ajustes' }).click()
  const secao = janela.getByRole('region', { name: 'Atualizações', exact: true })
  await expect(secao).toBeVisible()
  await secao.scrollIntoViewIfNeeded()
  await expect(secao).toContainText(ALGUM_ESTADO)
  await expect(secao, 'o atualizador está desligado nesta cópia do app').not.toContainText(ESTADOS.desligada)
  return secao
}

/** "Procurar agora". A 1ª busca sozinha (1 minuto depois de abrir) pode já ter começado: aí o botão some e ela segue. */
async function procurarAgora(secao: Locator, anotar: Anotar): Promise<void> {
  const botao = secao.getByRole('button', { name: 'Procurar agora', exact: true })
  const clicou = (await botao.isVisible()) && (await botao.click({ timeout: 10_000 }).then(() => true, () => false))
  anotar(clicou ? 'clique: Procurar agora' : 'sem o Procurar agora na tela (a busca sozinha já começou)')
  await esperar(1_000)
}

const primeiroEstado = (texto: string): Estado | null => ORDEM_DOS_ESTADOS.find((estado) => texto.includes(ESTADOS[estado])) ?? null

/** O estado se lê antes das notas da versão; só se não achar lá, no texto todo. */
const estadoDaSecao = (texto: string): Estado | null => primeiroEstado(texto.split(NOTAS)[0] ?? '') ?? primeiroEstado(texto)

/** As versões que a seção mostra além da instalada (a nova que ela achou, baixa ou tem pronta), fora das notas. */
function versoesNovas(texto: string, instalada: string): string[] {
  const achadas = (texto.split(NOTAS)[0] ?? '').match(/\d+\.\d+\.\d+(?:-teste\.\d+)?/g) ?? []
  return [...new Set(achadas)].filter((versao) => versao !== instalada)
}

interface LeituraDaSecao {
  texto: string
  estado: Estado | null
}

/** Lê a seção e anota no log cada estado novo que aparece (com a versão nova, quando a tela mostra). */
function leitorDaSecao(secao: Locator, instalada: string, anotar: Anotar): () => Promise<LeituraDaSecao> {
  let ultimo = ''
  return async () => {
    const texto = limparTexto(await secao.innerText().catch(() => ''))
    const estado = estadoDaSecao(texto)
    const novas = versoesNovas(texto, instalada)
    const resumo = `${estado ?? 'sem estado'}${novas.length > 0 ? ` (${novas.join(', ')})` : ''}`
    if (resumo !== ultimo) anotar(`seção: ${resumo}`)
    ultimo = resumo
    return { texto, estado }
  }
}

/** Espera o estado na seção; outro estado parado no lugar falha na hora, com o que a seção mostra. */
async function esperarNaSecao(
  ler: () => Promise<LeituraDaSecao>,
  alvo: Estado,
  falhas: readonly Estado[],
  limiteMs: number,
): Promise<void> {
  const prazo = Date.now() + limiteMs
  for (;;) {
    const { texto, estado } = await ler()
    if (estado === alvo) return
    if (estado !== null && falhas.includes(estado)) {
      throw new Error(`esperava "${ESTADOS[alvo]}", mas a seção Atualizações mostra: ${texto}`)
    }
    if (Date.now() > prazo) throw new Error(`"${ESTADOS[alvo]}" não apareceu em ${limiteMs / 1000} s. A seção Atualizações mostra: ${texto}`)
    await esperar(1_000)
  }
}

/** O app de teste segue a rota de produção: o canal teste já tem de apontar pra tag nova. */
async function conferirRotaDoCanalTeste(tag: string): Promise<void> {
  const resposta = await fetch(ROTA_DO_CANAL_TESTE, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
  expect(resposta.status, 'a rota do canal teste respondeu sem redirecionar').toBe(302)
  expect(resposta.headers.get('location'), `o canal teste ainda não aponta pra ${tag} (a rota leva até ~6 min depois do publicar)`).toBe(
    `${ANEXOS}/${tag}/teste.yml`,
  )
}

/**
 * Integridade do app.asar ligada: copia a pasta instalada 2 vezes e, na 2ª, troca 1 caractere do hash
 * da tela da voz no cabeçalho do app.asar (mesmo tamanho). A cópia igual abre; a mexida cai sozinha,
 * sem janela (com a integridade desligada ela abriria: esse arquivo nem é lido na abertura).
 */
async function conferirIntegridade(variante: Variante, registro: Registro): Promise<void> {
  await fecharProcessosDaPasta(registro.pasta)
  await semCaixaDeErroDoWindows()
  // Caminho longo de verdade: no runner o TEMP vem curto (RUNNER~1) e os processos se acham pelo caminho.
  const copias = realpathSync.native(mkdtempSync(join(tmpdir(), 'robo-copias-')))
  try {
    const igual = join(copias, 'igual')
    const mexida = join(copias, 'mexida')
    copiarPasta(registro.pasta, igual)
    copiarPasta(registro.pasta, mexida)
    const troca = mexerNoCabecalhoDoAsar(join(mexida, 'resources', 'app.asar'), ARQUIVO_QUE_A_ABERTURA_NAO_LE)
    console.log(`[integridade] cópia mexida: hash de ${ARQUIVO_QUE_A_ABERTURA_NAO_LE.join('/')} …${troca.antes.slice(-6)} → …${troca.depois.slice(-6)}`)

    const aberta = abrirSemPlaywright(join(igual, `${variante.nome}.exe`))
    try {
      await esperarJanela(aberta, TITULO_DO_PAINEL, 30_000)
    } finally {
      await fecharProcessosDaPasta(igual)
    }
    console.log('[integridade] a cópia igual abriu a janela')

    const mexido = abrirSemPlaywright(join(mexida, `${variante.nome}.exe`))
    const fim = await esperarFimSemJanela(mexido, 20_000)
    await fecharProcessosDaPasta(mexida)
    expect(fim.janelas, 'a cópia mexida abriu janela: a integridade do app.asar não está valendo').toEqual([])
    expect(fim.saiu, 'a cópia mexida não fechou sozinha em 20 s').toBe(true)
    expect(fim.codigo, 'a cópia mexida saiu com código 0 (esperava a queda da integridade)').not.toBe(0)
    console.log(`[integridade] a cópia mexida caiu sozinha (código ${fim.codigo}), sem janela`)
  } finally {
    await fecharProcessosDaPasta(copias).catch(() => undefined)
    try {
      rmSync(copias, { recursive: true, force: true })
    } catch {
      // o runner é descartável
    }
  }
}

// ---------------------------------------------------------------- testes

test.afterEach(async ({}, testInfo) => {
  // Falhou: o print da tela inteira mostra como o Windows ficou (só dado de teste).
  if (testInfo.status !== testInfo.expectedStatus) {
    const nome = testInfo.tags.map((tag) => tag.replace('@', '')).join('_') || 'teste'
    await printDaTela(caminhoDoPrint(`windows_falha_${nome}`)).catch(() => undefined)
  }
  // Nada fica pro teste seguinte: app fechado e desinstalado.
  for (const variante of Object.values(VARIANTES)) {
    await fecharProcessosDaPasta(pastaDaInstalacao(variante)).catch(() => undefined)
    const registro = await lerRegistro(variante).catch(() => null)
    if (registro) await desinstalar(variante, registro).catch((erro: unknown) => console.log(`[limpeza] ${variante.nome}: ${String(erro)}`))
  }
})

test('instala, passeia pelas abas em 1366x768 e 1920x1080, confere a integridade e desinstala', { tag: '@teste' }, async () => {
  const entradas = lerEntradas()
  if (entradas.tipo !== 'teste') throw new Error('este teste é do tipo teste (no oficial, rode --grep @oficial)')
  const variante = VARIANTES.teste
  const { versao } = entradas

  limparDadosDoApp(variante)
  await instalar(instalador(variante, versao))
  const registro = await esperarRegistro(variante, versao)
  const exe = conferirInstalacao(variante, registro, versao)
  expect(await lerFusiveis(exe)).toEqual(fusiveisEsperados(variante))

  await mudarResolucao(1366, 768)
  await minimizarTudo()
  const primeira = await abrirPeloPlaywright(exe, registro.pasta)
  try {
    expect(await versaoDoApp(primeira.app)).toBe(versao)
    await esperarOInicio(primeira.janela)
    await primeira.janela.screenshot({ path: caminhoDoPrint('windows_1366x768_janela') })
    await printDaTela(caminhoDoPrint('windows_1366x768'))
    await passearPelasAbas(primeira.janela, '1366x768', {
      inicio: 'windows_inicio_1366x768',
      conversar: 'windows_conversar_1366x768',
      agenda: 'windows_agenda_1366x768',
      ajustes: 'windows_ajustes_1366x768',
    })
    await abrirAtualizacoes(primeira.janela)
    await primeira.janela.screenshot({ path: caminhoDoPrint('windows_ajustes_atualizacoes') })
  } finally {
    await primeira.fechar()
  }

  await mudarResolucao(1920, 1080)
  await minimizarTudo()
  const segunda = await abrirPeloPlaywright(exe, registro.pasta)
  try {
    await esperarOInicio(segunda.janela)
    await printDaTela(caminhoDoPrint('windows_1920x1080'))
    await passearPelasAbas(segunda.janela, '1920x1080', { ajustes: 'windows_ajustes_1920x1080' })
  } finally {
    await segunda.fechar()
  }

  await conferirIntegridade(variante, registro)
  await desinstalar(variante, registro)
})

test('atualiza N → N+1 pelo app', { tag: '@atualizacao' }, async () => {
  const { tipo, tag, versao: nova, anterior } = lerEntradas()
  if (tipo !== 'teste' || !anterior) throw new Error('a atualização N → N+1 é do tipo teste e precisa de ROBO_ANTERIOR')
  if (compararVersoes(anterior.versao, nova) >= 0) throw new Error(`a anterior (${anterior.versao}) tem de ser menor que a nova (${nova})`)
  const variante = VARIANTES.teste
  // O log é aberto antes de tudo: se o teste cair no meio, o artefato leva o que já aconteceu.
  const anotar = abrirLog('windows_atualizacao_teste')
  anotar(`atualização ${anterior.versao} → ${nova} pelo clique (canal teste)`)
  await conferirRotaDoCanalTeste(tag)
  anotar(`rota do canal teste aponta pra ${tag}`)

  limparDadosDoApp(variante)
  await instalar(instalador(variante, anterior.versao))
  const registroDaAnterior = await esperarRegistro(variante, anterior.versao)
  const exe = conferirInstalacao(variante, registroDaAnterior, anterior.versao)

  await mudarResolucao(1366, 768)
  await minimizarTudo()
  const velho = await abrirPeloPlaywright(exe, registroDaAnterior.pasta)
  let fechouPraInstalar = false
  try {
    const antes = await versaoDoApp(velho.app)
    anotar(`versão antes: ${antes} (DisplayVersion ${registroDaAnterior.versao})`)
    expect(antes).toBe(anterior.versao)
    await esperarOInicio(velho.janela)
    const secao = await abrirAtualizacoes(velho.janela)
    const ler = leitorDaSecao(secao, anterior.versao, anotar)
    await ler()
    await procurarAgora(secao, anotar)
    // Acha a N+1 na rota, confere a assinatura, baixa (~142 MB) e confere o sha512.
    await esperarNaSecao(ler, 'pronta', [...PARADOS, 'emDia'], 8 * 60_000)
    await expect(secao).toContainText(`Versão ${nova}`)
    await velho.janela.screenshot({ path: caminhoDoPrint('windows_atualizacao_pronta') })
    await secao.getByRole('button', { name: 'Ver as notas e instalar', exact: true }).click()
    anotar('clique: Ver as notas e instalar')
    const instalarAgora = velho.janela.getByRole('dialog').getByRole('button', { name: 'Instalar agora', exact: true })
    await expect(instalarAgora).toBeEnabled()
    await esperar(500) // a caixa termina de entrar (animação)
    await velho.janela.screenshot({ path: caminhoDoPrint('windows_notas_instalar') })
    const fechou = velho.app.waitForEvent('close', { timeout: 60_000 })
    anotar('clique: Instalar agora')
    // O app fecha logo depois do clique: o clique pode terminar com "alvo fechado", e tudo bem.
    await instalarAgora.click().catch(() => undefined)
    await fechou
    fechouPraInstalar = true
    anotar('app fechou')
  } finally {
    if (!fechouPraInstalar) await velho.fechar()
  }

  // O instalador da N+1 troca os arquivos e reabre o app sozinho (--force-run), com --updated.
  const registro = await esperarRegistro(variante, nova, 3 * 60_000)
  anotar(`DisplayVersion depois: ${registro.versao}`)
  const reaberto = await esperarProcessoPrincipal(registro.pasta, exe, 3 * 60_000)
  anotar(`processo reaberto ${reaberto.linha.includes('--updated') ? 'com' : 'SEM'} --updated`)
  expect(reaberto.linha, 'o app reaberto pelo instalador leva --updated').toContain('--updated')
  // O reaberto segura a instância única: fecha ele pra abrir de novo pelo Playwright.
  await fecharProcessosDaPasta(registro.pasta)

  const novo = await abrirPeloPlaywright(exe, registro.pasta)
  try {
    const reaberta = await versaoDoApp(novo.app)
    anotar(`versão reaberta: ${reaberta}`)
    expect(reaberta).toBe(nova)
    await esperarOInicio(novo.janela)
    const secao = await abrirAtualizacoes(novo.janela)
    const ler = leitorDaSecao(secao, nova, anotar)
    await ler()
    await procurarAgora(secao, anotar)
    await esperarNaSecao(ler, 'emDia', [...PARADOS, 'pronta', 'encontrada'], 2 * 60_000)
    anotar(`em dia na ${reaberta}`)
    await novo.janela.screenshot({ path: caminhoDoPrint('windows_atualizou') })
  } finally {
    await novo.fechar()
  }
  await desinstalar(variante, registro)
  anotar('desinstalado')
})

test('oficial: instala, confere os fusíveis, abre sem o Playwright, confere a integridade e desinstala', { tag: '@oficial' }, async () => {
  const entradas = lerEntradas()
  if (entradas.tipo !== 'oficial') throw new Error('este teste é do tipo oficial (no teste, rode --grep @teste)')
  const variante = VARIANTES.oficial
  const { versao } = entradas

  limparDadosDoApp(variante)
  await instalar(instalador(variante, versao))
  const registro = await esperarRegistro(variante, versao)
  const exe = conferirInstalacao(variante, registro, versao)
  expect(await lerFusiveis(exe)).toEqual(fusiveisEsperados(variante))

  // O oficial fecha o inspetor e o Playwright não abre ele: abre como um clique no atalho.
  await mudarResolucao(1366, 768)
  await minimizarTudo()
  const aberto = abrirSemPlaywright(exe)
  try {
    await esperarJanela(aberto, TITULO_DO_PAINEL, 30_000)
    await esperar(3_000) // o Início termina de desenhar
    await printDaTela(caminhoDoPrint('windows_oficial_1366x768'))
  } finally {
    await fecharProcessosDaPasta(registro.pasta)
  }

  await conferirIntegridade(variante, registro)
  await desinstalar(variante, registro)
})
