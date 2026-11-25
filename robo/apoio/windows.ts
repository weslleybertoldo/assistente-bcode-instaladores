// Apoio do robô no Windows, de fora pra dentro, como um cliente (nada aqui conhece o código do app):
// instalar e desinstalar em silêncio, ler o registro de desinstalação, achar e fechar os processos do
// app, ler os fusíveis do .exe, mexer no cabeçalho do app.asar de uma cópia e falar com a tela (tela.ps1).
// Fatos medidos pela sessão no windows-2025 em 25/11/2026: instalação por usuário em
// %LOCALAPPDATA%\Programs\<nome> em ~20 s; a chave de desinstalação NÃO traz o InstallLocation (o NSIS
// grava ele em outra chave), então a pasta sai do QuietUninstallString.
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readSync, rmSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { setTimeout as esperar } from 'node:timers/promises'
import { promisify } from 'node:util'

const executar = promisify(execFile)

/** O JSON vem sempre na última linha (um aviso do PowerShell antes dele não atrapalha). */
function lerJson<T>(saida: string): T {
  const linhas = saida.trim().split(/\r?\n/)
  return JSON.parse(linhas[linhas.length - 1]) as T
}

export type Tipo = 'teste' | 'oficial'

export interface Variante {
  tipo: Tipo
  /** `name` do pacote: pasta da instalação, nome do .exe e da pasta de dados (empacotar.mjs do app). */
  nome: string
  /** Nome no Painel de Controle, sem a versão (o productName do build). */
  produto: string
  /** Formato da versão no canal da variante. */
  formatoDaVersao: RegExp
  /** O teste mantém o inspetor (o Playwright precisa); o oficial fecha. */
  inspetor: boolean
}

export const VARIANTES: Record<Tipo, Variante> = {
  teste: {
    tipo: 'teste',
    nome: 'assistente-bcode-teste',
    produto: 'Assistente · B Code (teste)',
    formatoDaVersao: /^\d+\.\d+\.\d+-teste\.\d+$/,
    inspetor: true,
  },
  oficial: {
    tipo: 'oficial',
    nome: 'assistente-bcode',
    produto: 'Assistente · B Code',
    formatoDaVersao: /^\d+\.\d+\.\d+$/,
    inspetor: false,
  },
}

/** Título da janela do painel nas 2 variantes (document.title do painel). */
export const TITULO_DO_PAINEL = 'Assistente · B Code'

// ---------------------------------------------------------------- entradas

export interface Entradas {
  tipo: Tipo
  tag: string
  versao: string
  /** Só no teste: a versão N da atualização N → N+1. */
  anterior: { tag: string; versao: string } | null
}

/** Lê ROBO_TIPO, ROBO_TAG e ROBO_ANTERIOR (o workflow já conferiu; aqui confere de novo). */
export function lerEntradas(ambiente: NodeJS.ProcessEnv = process.env): Entradas {
  const tipo = ambiente.ROBO_TIPO
  if (tipo !== 'teste' && tipo !== 'oficial') throw new Error('ROBO_TIPO tem de ser teste ou oficial.')
  const { formatoDaVersao } = VARIANTES[tipo]
  const versaoDa = (tag: string | undefined, nome: string): string => {
    const versao = tag !== undefined && tag.startsWith('v') ? tag.slice(1) : ''
    if (versao.length > 40 || !formatoDaVersao.test(versao)) {
      throw new Error(`${nome} fora do formato do tipo ${tipo} (ex.: v0.8.0-teste.130 no teste, v0.8.0 no oficial).`)
    }
    return versao
  }
  const tag = ambiente.ROBO_TAG ?? ''
  const versao = versaoDa(tag, 'ROBO_TAG')
  const tagAnterior = ambiente.ROBO_ANTERIOR ?? ''
  if (tagAnterior === '') return { tipo, tag, versao, anterior: null }
  if (tipo !== 'teste') throw new Error('ROBO_ANTERIOR só vale no tipo teste.')
  return { tipo, tag, versao, anterior: { tag: tagAnterior, versao: versaoDa(tagAnterior, 'ROBO_ANTERIOR') } }
}

/** Compara x.y.z[-teste.N] pelos números (o pré-lançamento vem antes da versão sem ele). */
export function compararVersoes(a: string, b: string): number {
  const partes = (versao: string): number[] => {
    const achado = /^(\d+)\.(\d+)\.(\d+)(?:-teste\.(\d+))?$/.exec(versao)
    if (!achado) throw new Error(`versão inválida: ${versao}`)
    const [, maior, menor, correcao, teste] = achado
    return [Number(maior), Number(menor), Number(correcao), teste === undefined ? Infinity : Number(teste)]
  }
  const [pa, pb] = [partes(a), partes(b)]
  for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  return 0
}

/** Nome do instalador no release (artifactName '${name}-${version}-setup.${ext}' do app). */
export function nomeDoInstalador(variante: Variante, versao: string): string {
  return `${variante.nome}-${versao}-setup.exe`
}

// ---------------------------------------------------------------- pastas

function pastaDoSistema(nome: 'APPDATA' | 'LOCALAPPDATA'): string {
  const pasta = process.env[nome]
  if (!pasta) throw new Error(`${nome} ausente: o robô só roda no Windows.`)
  return pasta
}

/** Onde o NSIS por usuário instala: %LOCALAPPDATA%\Programs\<nome>. */
export function pastaDaInstalacao(variante: Variante): string {
  return join(pastaDoSistema('LOCALAPPDATA'), 'Programs', variante.nome)
}

/**
 * O app abre com a pasta de dados vazia (sem nome e sem chave) e sem download velho: apaga a pasta de
 * dados da variante e o cache do atualizador. Só dado de teste do runner.
 */
export function limparDadosDoApp(variante: Variante): void {
  rmSync(join(pastaDoSistema('APPDATA'), variante.nome), { recursive: true, force: true })
  rmSync(join(pastaDoSistema('LOCALAPPDATA'), `${variante.nome}-updater`), { recursive: true, force: true })
}

/** Ambiente do app: o do runner, sem nenhum ajuste de teste do app (ASSISTENTE_*). */
export function ambienteDoApp(): Record<string, string> {
  const ambiente: Record<string, string> = {}
  for (const [chave, valor] of Object.entries(process.env)) {
    if (valor !== undefined && !chave.toUpperCase().startsWith('ASSISTENTE_')) ambiente[chave] = valor
  }
  return ambiente
}

// ---------------------------------------------------------------- PowerShell

/** Roda um script fixo no pwsh; os dados vão pelo ambiente (nunca no texto do script). Devolve o JSON lido. */
async function powershell<T>(script: string, dados: Record<string, string> = {}): Promise<T> {
  const codigo = Buffer.from(`$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n${script}`, 'utf16le')
  const { stdout } = await executar(
    'pwsh',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', codigo.toString('base64')],
    { encoding: 'utf8', env: { ...process.env, ...dados }, windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
  )
  return lerJson<T>(stdout)
}

/** Fala com o tela.ps1 (resolução, minimizar, print e janelas). */
async function tela<T>(argumentos: string[]): Promise<T> {
  const script = join(__dirname, 'tela.ps1')
  const { stdout } = await executar(
    'pwsh',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...argumentos],
    // Sem janela de console: ela apareceria no print da tela inteira.
    { encoding: 'utf8', windowsHide: true, timeout: 120_000 },
  )
  return lerJson<T>(stdout)
}

export async function mudarResolucao(largura: number, altura: number): Promise<void> {
  const resposta = await tela<{ rc: number; largura: number; altura: number }>([
    '-Acao', 'resolucao', '-Largura', String(largura), '-Altura', String(altura),
  ])
  if (resposta.rc !== 0 || resposta.largura !== largura || resposta.altura !== altura) {
    throw new Error(`não deu pra trocar a tela pra ${largura}x${altura}: ${JSON.stringify(resposta)}`)
  }
}

/** Minimiza tudo (o console do runner fica na frente). Chamar ANTES de abrir o app. */
export async function minimizarTudo(): Promise<void> {
  await tela(['-Acao', 'minimizar'])
}

/** Print da tela inteira (o que o cliente veria), em PNG. */
export async function printDaTela(arquivo: string): Promise<void> {
  mkdirSync(dirname(arquivo), { recursive: true })
  await tela(['-Acao', 'print', '-Arquivo', arquivo])
  if (!existsSync(arquivo)) throw new Error(`o print ${basename(arquivo)} não foi gravado`)
}

/** Títulos das janelas visíveis do processo, agora. */
export async function janelasDoProcesso(processo: number): Promise<string[]> {
  return tela<string[]>(['-Acao', 'janelas', '-Processo', String(processo)])
}

// ---------------------------------------------------------------- instalar e desinstalar

/** Roda um programa até o fim, sem janela de console, e devolve o código de saída. */
async function rodarAteOFim(programa: string, argumentos: string[], limiteMs: number): Promise<number> {
  const filho = spawn(programa, argumentos, { stdio: 'ignore', windowsHide: true })
  return new Promise<number>((resolver, rejeitar) => {
    const relogio = setTimeout(() => {
      filho.kill()
      rejeitar(new Error(`${basename(programa)} não terminou em ${limiteMs / 1000} s`))
    }, limiteMs)
    filho.once('error', (erro) => {
      clearTimeout(relogio)
      rejeitar(erro)
    })
    filho.once('exit', (codigo) => {
      clearTimeout(relogio)
      resolver(codigo ?? -1)
    })
  })
}

/** Espera a condição valer (de 2 em 2 s); estourou o prazo = erro com a explicação. */
async function esperarAte(condicao: () => Promise<boolean>, limiteMs: number, explicar: () => Promise<string>): Promise<void> {
  const prazo = Date.now() + limiteMs
  while (!(await condicao())) {
    if (Date.now() > prazo) throw new Error(await explicar())
    await esperar(2_000)
  }
}

/** Instalação silenciosa (/S), por usuário, sem pedir nada. */
export async function instalar(instalador: string): Promise<void> {
  if (!existsSync(instalador)) throw new Error(`instalador não encontrado: ${basename(instalador)}`)
  const codigo = await rodarAteOFim(instalador, ['/S'], 5 * 60_000)
  if (codigo !== 0) throw new Error(`o instalador ${basename(instalador)} terminou com o código ${codigo}`)
}

export interface Registro {
  /** DisplayName (ex.: 'Assistente · B Code (teste) 0.8.0-teste.130'). */
  nome: string
  /** DisplayVersion. */
  versao: string
  desinstalador: string
  argumentos: string[]
  /** Pasta da instalação (a do desinstalador). */
  pasta: string
}

// Lista as entradas de HKCU\...\Uninstall que têm QuietUninstallString (o NSIS grava '"<pasta>\Uninstall X.exe" /currentuser /S').
const SCRIPT_DO_REGISTRO = String.raw`
$raiz = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$itens = @(
  if (Test-Path -LiteralPath $raiz) {
    foreach ($chave in Get-ChildItem -LiteralPath $raiz) {
      $valores = Get-ItemProperty -LiteralPath $chave.PSPath
      if ($null -ne $valores -and $valores.PSObject.Properties['QuietUninstallString']) {
        [pscustomobject]@{
          nome = [string]$valores.DisplayName
          versao = [string]$valores.DisplayVersion
          desinstalar = [string]$valores.QuietUninstallString
        }
      }
    }
  }
)
ConvertTo-Json -InputObject $itens -Compress -Depth 3 -EscapeHandling EscapeNonAscii
`

/** A instalação da variante no registro (pela pasta do desinstalador), ou null. */
export async function lerRegistro(variante: Variante): Promise<Registro | null> {
  const itens = await powershell<{ nome: string; versao: string; desinstalar: string }[]>(SCRIPT_DO_REGISTRO)
  const achados = itens.flatMap((item): Registro[] => {
    const linha = /^"([^"]+)"\s*(.*)$/.exec(item.desinstalar)
    if (!linha) return []
    const desinstalador = linha[1]
    if (basename(dirname(desinstalador)).toLowerCase() !== variante.nome) return []
    return [{ nome: item.nome, versao: item.versao, desinstalador, argumentos: linha[2].split(/\s+/).filter(Boolean), pasta: dirname(desinstalador) }]
  })
  if (achados.length > 1) throw new Error(`${achados.length} instalações de ${variante.nome} no registro (esperava 1)`)
  return achados[0] ?? null
}

/** Espera o registro da variante mostrar a versão (o instalador grava no fim). */
export async function esperarRegistro(variante: Variante, versao: string, limiteMs = 60_000): Promise<Registro> {
  const prazo = Date.now() + limiteMs
  for (;;) {
    const atual = await lerRegistro(variante)
    if (atual?.versao === versao) return atual
    if (Date.now() > prazo) {
      throw new Error(`o registro de ${variante.nome} não chegou na versão ${versao} em ${limiteMs / 1000} s (está: ${atual?.versao ?? 'sem instalação'})`)
    }
    await esperar(2_000)
  }
}

/** Desinstalação silenciosa pelo QuietUninstallString; espera a pasta e a chave sumirem. */
export async function desinstalar(variante: Variante, registro: Registro): Promise<void> {
  await fecharProcessosDaPasta(registro.pasta)
  const codigo = await rodarAteOFim(registro.desinstalador, registro.argumentos, 5 * 60_000)
  if (codigo !== 0) throw new Error(`o desinstalador terminou com o código ${codigo}`)
  // O desinstalador do NSIS se copia pra pasta temporária e termina o serviço de lá.
  await esperarAte(
    async () => !existsSync(registro.pasta) && (await lerRegistro(variante)) === null,
    2 * 60_000,
    async () => `a desinstalação de ${variante.nome} não terminou (pasta existe: ${existsSync(registro.pasta)})`,
  )
}

// ---------------------------------------------------------------- processos

export interface Processo {
  id: number
  caminho: string
  linha: string
}

// Processos cujo .exe está dentro de ROBO_PASTA (o Electron abre vários: principal, telas, GPU…).
const SCRIPT_DOS_PROCESSOS = String.raw`
$prefixo = $env:ROBO_PASTA.TrimEnd('\') + '\'
$lista = @(Get-CimInstance -ClassName Win32_Process | Where-Object {
  $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefixo, [System.StringComparison]::OrdinalIgnoreCase)
} | ForEach-Object {
  [pscustomobject]@{ id = [int]$_.ProcessId; caminho = [string]$_.ExecutablePath; linha = [string]$_.CommandLine }
})
ConvertTo-Json -InputObject $lista -Compress -Depth 3 -EscapeHandling EscapeNonAscii
`

export async function processosDaPasta(pasta: string): Promise<Processo[]> {
  return powershell<Processo[]>(SCRIPT_DOS_PROCESSOS, { ROBO_PASTA: pasta })
}

/** Fecha à força tudo que roda de dentro da pasta e espera sumir (solta a instância única e os arquivos). */
export async function fecharProcessosDaPasta(pasta: string, limiteMs = 30_000): Promise<void> {
  let restantes: Processo[] = []
  await esperarAte(
    async () => {
      restantes = await processosDaPasta(pasta)
      for (const { id } of restantes) {
        try {
          process.kill(id)
        } catch {
          // já tinha saído
        }
      }
      return restantes.length === 0
    },
    limiteMs,
    async () => `processos que não fecharam em ${basename(pasta)}: ${restantes.map((p) => p.id).join(', ')}`,
  )
}

/** O processo principal do app (o que não tem --type=) rodando de dentro da pasta. */
export async function esperarProcessoPrincipal(pasta: string, exe: string, limiteMs: number): Promise<Processo> {
  const prazo = Date.now() + limiteMs
  for (;;) {
    const principal = (await processosDaPasta(pasta)).find(
      (p) => p.caminho.toLowerCase() === exe.toLowerCase() && !p.linha.includes('--type='),
    )
    if (principal) return principal
    if (Date.now() > prazo) throw new Error(`o app não abriu sozinho em ${limiteMs / 1000} s`)
    await esperar(2_000)
  }
}

/** Abre o .exe como um clique no atalho (sem o Playwright). */
export function abrirSemPlaywright(exe: string): ChildProcess {
  if (!existsSync(exe)) throw new Error(`executável não encontrado: ${exe}`)
  const filho = spawn(exe, [], { stdio: 'ignore', env: ambienteDoApp() })
  filho.once('error', () => undefined) // quem confere é esperarJanela/esperarFimSemJanela (pelo código de saída)
  return filho
}

const saiu = (filho: ChildProcess): boolean => filho.exitCode !== null || filho.signalCode !== null

/** Espera uma janela visível do processo com o título dado. */
export async function esperarJanela(filho: ChildProcess, titulo: string, limiteMs: number): Promise<void> {
  const processo = filho.pid
  if (processo === undefined) throw new Error('o app não abriu (sem processo)')
  const prazo = Date.now() + limiteMs
  let vistas: string[] = []
  while (Date.now() < prazo) {
    if (saiu(filho)) throw new Error(`o app fechou sozinho (código ${filho.exitCode}) antes de mostrar a janela`)
    vistas = await janelasDoProcesso(processo)
    if (vistas.includes(titulo)) return
    await esperar(1_000)
  }
  throw new Error(`a janela "${titulo}" não apareceu em ${limiteMs / 1000} s (janelas do processo: ${JSON.stringify(vistas)})`)
}

/** Espera o processo terminar sozinho, anotando qualquer janela visível que ele mostre no caminho. */
export async function esperarFimSemJanela(
  filho: ChildProcess,
  limiteMs: number,
): Promise<{ saiu: boolean; codigo: number | null; janelas: string[] }> {
  const processo = filho.pid
  if (processo === undefined) throw new Error('o app não abriu (sem processo)')
  const prazo = Date.now() + limiteMs
  const janelas = new Set<string>()
  while (!saiu(filho) && Date.now() < prazo) {
    for (const titulo of await janelasDoProcesso(processo)) janelas.add(titulo)
    await esperar(500)
  }
  return { saiu: saiu(filho), codigo: filho.exitCode, janelas: [...janelas] }
}

// Sem a caixa "parou de funcionar" do Windows: o app que cai na integridade termina na hora, sem
// ficar preso esperando um clique (só no usuário do runner).
const SCRIPT_SEM_CAIXA_DE_ERRO = String.raw`
$chave = 'HKCU:\Software\Microsoft\Windows\Windows Error Reporting'
if (-not (Test-Path -LiteralPath $chave)) { New-Item -Path $chave | Out-Null }
Set-ItemProperty -LiteralPath $chave -Name DontShowUI -Value 1 -Type DWord
Set-ItemProperty -LiteralPath $chave -Name Disabled -Value 1 -Type DWord
ConvertTo-Json -InputObject ([ordered]@{ ok = $true }) -Compress
`

export async function semCaixaDeErroDoWindows(): Promise<void> {
  await powershell(SCRIPT_SEM_CAIXA_DE_ERRO)
}

// ---------------------------------------------------------------- fusíveis e integridade

/** Os fusíveis que o empacotar.mjs do app liga ou desliga (os outros ficam no padrão do Electron). */
const FUSIVEIS = [
  'RunAsNode',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'GrantFileProtocolExtraPrivileges',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'EnableCookieEncryption',
] as const

export type Fusiveis = Record<(typeof FUSIVEIS)[number], boolean | string>

/** Lê os fusíveis do .exe: true = ligado, false = desligado (outro estado vira texto). */
export async function lerFusiveis(exe: string): Promise<Fusiveis> {
  const fio = await getCurrentFuseWire(exe)
  const lidos = {} as Fusiveis
  for (const nome of FUSIVEIS) {
    const estado = fio[FuseV1Options[nome]]
    lidos[nome] = estado === FuseState.ENABLE ? true : estado === FuseState.DISABLE ? false : `estado ${String(estado)}`
  }
  return lidos
}

/** Os mesmos do empacotar.mjs do app: só o inspetor muda entre teste e oficial. */
export function fusiveisEsperados(variante: Variante): Fusiveis {
  return {
    RunAsNode: false,
    EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: variante.inspetor,
    GrantFileProtocolExtraPrivileges: false,
    EnableEmbeddedAsarIntegrityValidation: true,
    OnlyLoadAppFromAsar: true,
    EnableCookieEncryption: true,
  }
}

/** Copia a pasta instalada inteira (o .exe leva o hash do cabeçalho do app.asar dentro dele). */
export function copiarPasta(origem: string, destino: string): void {
  cpSync(origem, destino, { recursive: true, errorOnExist: true, force: false })
}

/** A tela da voz (vazia até a W17): a abertura do app não lê esse arquivo. */
export const ARQUIVO_QUE_A_ABERTURA_NAO_LE = ['out', 'renderer', 'voz', 'index.html'] as const

interface NoDoAsar {
  files?: Record<string, NoDoAsar>
  integrity?: { hash?: unknown }
}

/**
 * Troca 1 caractere hexadecimal do 'hash' de um arquivo no JSON do cabeçalho do app.asar, sem mudar
 * o tamanho. Com a integridade ligada o Electron confere o hash do cabeçalho na abertura e o app cai
 * sem abrir janela; com ela desligada o app abriria normal (esse arquivo nem é lido na abertura).
 * Formato do asar: [4][tamanho do bloco][tamanho do conteúdo][tamanho do JSON][JSON do cabeçalho]…
 */
export function mexerNoCabecalhoDoAsar(asar: string, caminho: readonly string[]): { antes: string; depois: string } {
  const descritor = openSync(asar, 'r+')
  try {
    const topo = Buffer.alloc(16)
    if (readSync(descritor, topo, 0, 16, 0) !== 16) throw new Error('app.asar curto demais')
    const tamanhoDoJson = topo.readUInt32LE(12)
    if (topo.readUInt32LE(0) !== 4 || tamanhoDoJson === 0 || tamanhoDoJson + 4 > topo.readUInt32LE(8)) {
      throw new Error('o cabeçalho do app.asar não está no formato esperado')
    }
    const original = Buffer.alloc(tamanhoDoJson)
    if (readSync(descritor, original, 0, tamanhoDoJson, 16) !== tamanhoDoJson) throw new Error('app.asar curto demais')
    const cabecalho = JSON.parse(original.toString('utf8')) as NoDoAsar
    let no: NoDoAsar | undefined = cabecalho
    for (const parte of caminho) no = no?.files?.[parte]
    const integridade = no?.integrity
    const antes = integridade?.hash
    if (!integridade || typeof antes !== 'string' || !/^[0-9a-f]{64}$/.test(antes)) {
      throw new Error(`o cabeçalho do app.asar não tem o hash de ${caminho.join('/')}`)
    }
    const depois = antes.slice(0, -1) + (antes.endsWith('0') ? '1' : '0')
    integridade.hash = depois
    const mexido = Buffer.from(JSON.stringify(cabecalho), 'utf8')
    const diferentes: number[] = []
    for (let i = 0; i < Math.min(mexido.length, original.length); i++) if (mexido[i] !== original[i]) diferentes.push(i)
    // A prova só vale se mudar exatamente 1 byte do cabeçalho (o resto do arquivo fica igual).
    if (mexido.length !== original.length || diferentes.length !== 1) {
      throw new Error(`a troca mudaria ${diferentes.length} byte(s) e o tamanho ${original.length} → ${mexido.length}`)
    }
    writeSync(descritor, mexido, diferentes[0], 1, 16 + diferentes[0])
    return { antes, depois }
  } finally {
    closeSync(descritor)
  }
}
