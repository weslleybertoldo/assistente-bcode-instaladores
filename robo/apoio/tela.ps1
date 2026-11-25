# Tela do runner do Windows, do jeito que a sessão mediu em 25/11/2026 (runs 45547405286 e 45547750828):
# troca de resolução pela API do Windows (ChangeDisplaySettings), minimizar tudo (o console do runner fica
# na frente), print da tela inteira (CopyFromScreen) e as janelas visíveis de um processo (EnumWindows).
# Responde sempre 1 linha de JSON só com ASCII (o "·" do nome do app sai como \u00b7).
#   pwsh -File tela.ps1 -Acao resolucao -Largura 1366 -Altura 768  -> {"rc":0,"largura":1366,"altura":768}
#   pwsh -File tela.ps1 -Acao minimizar                            -> {"ok":true}
#   pwsh -File tela.ps1 -Acao print -Arquivo C:\caminho\print.png  -> {"largura":1366,"altura":768}
#   pwsh -File tela.ps1 -Acao janelas -Processo 1234               -> ["Assistente \u00b7 B Code", ...]
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('resolucao', 'minimizar', 'print', 'janelas')]
  [string] $Acao,
  [ValidateRange('NonNegative')] [int] $Largura = 0,
  [ValidateRange('NonNegative')] [int] $Altura = 0,
  [string] $Arquivo = '',
  [ValidateRange('NonNegative')] [int] $Processo = 0
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

# A troca de resolução medida no runner: lê o modo atual e troca só largura e altura
# (DM_PELSWIDTH | DM_PELSHEIGHT). rc 0 = trocou (DISP_CHANGE_SUCCESSFUL).
$codigoDaResolucao = @'
using System;
using System.Runtime.InteropServices;

public static class ResolucaoDoRobo {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion;
    public short dmDriverVersion;
    public short dmSize;
    public short dmDriverExtra;
    public int dmFields;
    public int dmPositionX;
    public int dmPositionY;
    public int dmDisplayOrientation;
    public int dmDisplayFixedOutput;
    public short dmColor;
    public short dmDuplex;
    public short dmYResolution;
    public short dmTTOption;
    public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel;
    public int dmPelsWidth;
    public int dmPelsHeight;
    public int dmDisplayFlags;
    public int dmDisplayFrequency;
    public int dmICMMethod;
    public int dmICMIntent;
    public int dmMediaType;
    public int dmDitherType;
    public int dmReserved1;
    public int dmReserved2;
    public int dmPanningWidth;
    public int dmPanningHeight;
  }

  [DllImport("user32.dll")] public static extern bool EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE devMode);
  [DllImport("user32.dll")] public static extern int ChangeDisplaySettings(ref DEVMODE devMode, int flags);

  public static int Mudar(int largura, int altura) {
    var modo = new DEVMODE();
    modo.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    EnumDisplaySettings(null, -1, ref modo);
    modo.dmPelsWidth = largura;
    modo.dmPelsHeight = altura;
    modo.dmFields = 0x80000 | 0x100000;
    return ChangeDisplaySettings(ref modo, 0);
  }
}
'@

# As janelas de primeiro nível, visíveis e sem dono, de um processo. No Electron as janelas
# são do processo principal (o que o robô abriu); os títulos voltam como o Windows mostra.
$codigoDasJanelas = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class JanelasDoRobo {
  private delegate bool AoAcharJanela(IntPtr janela, IntPtr dado);

  [DllImport("user32.dll")] private static extern bool EnumWindows(AoAcharJanela aoAchar, IntPtr dado);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr janela, out uint processo);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr janela);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr janela, uint relacao);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr janela, StringBuilder texto, int maximo);

  private const uint GW_OWNER = 4;

  public static string[] Titulos(uint processo) {
    var titulos = new List<string>();
    EnumWindows((janela, dado) => {
      uint dono;
      GetWindowThreadProcessId(janela, out dono);
      if (dono == processo && IsWindowVisible(janela) && GetWindow(janela, GW_OWNER) == IntPtr.Zero) {
        var texto = new StringBuilder(512);
        GetWindowTextW(janela, texto, texto.Capacity);
        titulos.Add(texto.ToString());
      }
      return true;
    }, IntPtr.Zero);
    return titulos.ToArray();
  }
}
'@

function Responder($valor) {
  ConvertTo-Json -InputObject $valor -Compress -Depth 4 -EscapeHandling EscapeNonAscii
}

switch ($Acao) {
  'resolucao' {
    if ($Largura -eq 0 -or $Altura -eq 0) { throw 'Informe -Largura e -Altura.' }
    Add-Type -TypeDefinition $codigoDaResolucao
    Add-Type -AssemblyName System.Windows.Forms
    $rc = [ResolucaoDoRobo]::Mudar($Largura, $Altura)
    Start-Sleep -Seconds 2
    $limites = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    Responder ([ordered]@{ rc = $rc; largura = $limites.Width; altura = $limites.Height })
  }
  'minimizar' {
    (New-Object -ComObject Shell.Application).MinimizeAll()
    Start-Sleep -Seconds 1
    Responder ([ordered]@{ ok = $true })
  }
  'print' {
    if (-not $Arquivo) { throw 'Informe -Arquivo.' }
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $limites = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $imagem = New-Object System.Drawing.Bitmap $limites.Width, $limites.Height
    $desenho = [System.Drawing.Graphics]::FromImage($imagem)
    try {
      $desenho.CopyFromScreen($limites.Location, [System.Drawing.Point]::Empty, $limites.Size)
      $imagem.Save($Arquivo, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $desenho.Dispose()
      $imagem.Dispose()
    }
    Responder ([ordered]@{ largura = $limites.Width; altura = $limites.Height })
  }
  'janelas' {
    if ($Processo -eq 0) { throw 'Informe -Processo.' }
    Add-Type -TypeDefinition $codigoDasJanelas
    Responder @([JanelasDoRobo]::Titulos([uint32]$Processo))
  }
}
