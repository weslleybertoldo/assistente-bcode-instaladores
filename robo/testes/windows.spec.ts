// Robô do Windows (W7): testa o Assistente · B Code instalado de um release deste repositório, de fora
// pra dentro, como um cliente. Roda no GitHub Actions (windows-2025) pelo .github/workflows/robo-windows.yml:
//   @teste        instala, abre em 1366x768 e 1920x1080, confere fusíveis e integridade e desinstala
//   @atualizacao  instala a versão anterior (N) e atualiza pelo próprio app até a nova (N+1)
//   @oficial      instala o oficial, confere os fusíveis, abre sem o Playwright, integridade e desinstala
// Entradas pelo ambiente: ROBO_TIPO (teste | oficial), ROBO_TAG (v<versão>) e ROBO_ANTERIOR (só no teste).
// Prints em robo/prints (o workflow guarda como 'prints-windows'). O registro é público: o app abre com
// a pasta de dados vazia (sem nome e sem chave) e o log só leva versão e estado.
// Os textos da seção Atualizações são os da tela do app (renderer/fluxos/atualizacao/textos.ts no
// repositório do app): mudou lá, muda aqui.
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
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

/** Textos da seção Ajustes › Atualizações. */
const TEXTO = {
  emDia: 'Você está na versão mais nova.',
  pronta: 'Pronta pra instalar',
  encontrada: 'encontrada.',
  recusada: 'A versão nova foi recusada',
  semAtualizacao: 'Sem atualização agora',
  desligada: 'não procura versão nova sozinha',
} as const
/** Algum estado já desenhado na seção (antes disso ela mostra o esqueleto). */
const ALGUM_ESTADO =
  /Ainda não procurei versão nova|Você está na versão mais nova|Procurando versão nova|encontrada\.|Baixando a versão|Conferindo o arquivo|Pronta pra instalar|Fechando o app pra instalar|A versão nova foi recusada|Sem atualização agora|não procura versão nova sozinha/
/** Estados parados (não mudam sozinhos por 1 h ou mais): se aparecerem no lugar do esperado, falha na hora. */
const PARADOS = [TEXTO.recusada, TEXTO.semAtualizacao, TEXTO.desligada]

const caminhoDoPrint = (nome: string): string => join(PASTA_DOS_PRINTS, `${nome}.png`)
const instalador = (variante: Variante, versao: string): string => join(PASTA_DOS_INSTALADORES, nomeDoInstalador(variante, versao))

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

/** Ajustes › Atualizações: a seção à vista, já com algum estado, e o atualizador ligado. */
async function abrirAtualizacoes(janela: Page): Promise<Locator> {
  await janela.getByRole('navigation', { name: 'Menu principal' }).getByRole('link', { name: 'Ajustes' }).click()
  const secao = janela.getByRole('region', { name: 'Atualizações', exact: true })
  await expect(secao).toBeVisible()
  await secao.scrollIntoViewIfNeeded()
  await expect(secao).toContainText(ALGUM_ESTADO)
  await expect(secao, 'o atualizador está desligado nesta cópia do app').not.toContainText(TEXTO.desligada)
  return secao
}

/** "Procurar agora". A 1ª busca sozinha (1 minuto depois de abrir) pode já ter começado: aí o botão some e ela segue. */
async function procurarAgora(secao: Locator): Promise<void> {
  const botao = secao.getByRole('button', { name: 'Procurar agora', exact: true })
  if (await botao.isVisible()) await botao.click({ timeout: 10_000 }).catch(() => undefined)
  await esperar(1_000)
}

/** Espera o texto na seção; outro estado parado no lugar falha na hora, com o que a seção mostra. */
async function esperarNaSecao(secao: Locator, alvo: string, falhas: readonly string[], limiteMs: number): Promise<void> {
  const prazo = Date.now() + limiteMs
  for (;;) {
    const texto = (await secao.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
    if (texto.includes(alvo)) return
    if (falhas.some((falha) => texto.includes(falha))) throw new Error(`esperava "${alvo}", mas a seção Atualizações mostra: ${texto}`)
    if (Date.now() > prazo) throw new Error(`"${alvo}" não apareceu em ${limiteMs / 1000} s. A seção Atualizações mostra: ${texto}`)
    await esperar(2_000)
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

test('instala, abre em 1366x768 e 1920x1080, confere a integridade e desinstala', { tag: '@teste' }, async () => {
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
  await conferirRotaDoCanalTeste(tag)

  limparDadosDoApp(variante)
  await instalar(instalador(variante, anterior.versao))
  const registroDaAnterior = await esperarRegistro(variante, anterior.versao)
  const exe = conferirInstalacao(variante, registroDaAnterior, anterior.versao)

  await mudarResolucao(1366, 768)
  await minimizarTudo()
  const velho = await abrirPeloPlaywright(exe, registroDaAnterior.pasta)
  let fechouPraInstalar = false
  try {
    expect(await versaoDoApp(velho.app)).toBe(anterior.versao)
    await esperarOInicio(velho.janela)
    const secao = await abrirAtualizacoes(velho.janela)
    await procurarAgora(secao)
    // Acha a N+1 na rota, confere a assinatura, baixa (~142 MB) e confere o sha512.
    await esperarNaSecao(secao, TEXTO.pronta, [...PARADOS, TEXTO.emDia], 8 * 60_000)
    await expect(secao).toContainText(`Versão ${nova}`)
    await velho.janela.screenshot({ path: caminhoDoPrint('windows_atualizacao_pronta') })
    await secao.getByRole('button', { name: 'Ver as notas e instalar', exact: true }).click()
    const instalarAgora = velho.janela.getByRole('dialog').getByRole('button', { name: 'Instalar agora', exact: true })
    await expect(instalarAgora).toBeEnabled()
    const fechou = velho.app.waitForEvent('close', { timeout: 60_000 })
    // O app fecha logo depois do clique: o clique pode terminar com "alvo fechado", e tudo bem.
    await instalarAgora.click().catch(() => undefined)
    await fechou
    fechouPraInstalar = true
  } finally {
    if (!fechouPraInstalar) await velho.fechar()
  }

  // O instalador da N+1 troca os arquivos e reabre o app sozinho (--force-run), com --updated.
  const registro = await esperarRegistro(variante, nova, 3 * 60_000)
  const reaberto = await esperarProcessoPrincipal(registro.pasta, exe, 3 * 60_000)
  expect(reaberto.linha, 'o app reaberto pelo instalador leva --updated').toContain('--updated')
  // O reaberto segura a instância única: fecha ele pra abrir de novo pelo Playwright.
  await fecharProcessosDaPasta(registro.pasta)

  const novo = await abrirPeloPlaywright(exe, registro.pasta)
  try {
    expect(await versaoDoApp(novo.app)).toBe(nova)
    await esperarOInicio(novo.janela)
    const secao = await abrirAtualizacoes(novo.janela)
    await procurarAgora(secao)
    await esperarNaSecao(secao, TEXTO.emDia, [...PARADOS, TEXTO.pronta, TEXTO.encontrada], 2 * 60_000)
    await novo.janela.screenshot({ path: caminhoDoPrint('windows_atualizou') })
  } finally {
    await novo.fechar()
  }
  await desinstalar(variante, registro)
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
