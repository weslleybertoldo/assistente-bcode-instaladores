# Assistente · B Code — instaladores

Este repositório guarda só o que o cliente baixa: os instaladores do Assistente · B Code (Windows e
Linux), os arquivos assinados de cada versão, as notas da versão e o teste automático do instalador do
Windows. **O código-fonte do app não fica aqui.**

## Canais

| Canal | Versão | No GitHub | Quem recebe |
|---|---|---|---|
| **Estável** | `x.y.z` (ex.: `0.8.0`) | release marcado **Latest** | o app oficial, dos clientes |
| **Teste** | `x.y.z-teste.N` (ex.: `0.8.0-teste.131`) | release marcado **Pre-release** (pré-lançamento) | o app de teste da B Code |

Cada versão é um release com a tag `v<versão>` e 5 anexos:

| Anexo | Estável | Teste |
|---|---|---|
| Instalador do Windows (+ o `.blockmap` dele) | `assistente-bcode-<versão>-setup.exe` | `assistente-bcode-teste-<versão>-setup.exe` |
| Pacote do Linux | `assistente-bcode_<versão>_amd64.deb` | `assistente-bcode-teste_<versão>_amd64.deb` |
| Arquivos do canal, assinados | `latest.yml` e `latest-linux.yml` | `teste.yml` e `teste-linux.yml` |

- Uma versão estável só vira **Latest** depois que o robô do Windows (abaixo) passa nela.
- O `canais.json` diz qual é a versão mais nova de cada canal. Quem escreve nele é só o script de
  publicar da B Code; o servidor de atualizações (`assistente.bcode.software`) lê esse arquivo pra
  mandar o app pro release certo.
- O app nunca instala uma versão menor que a dele. Pra voltar atrás, a B Code publica uma versão nova
  (número maior) feita do código anterior.

## Como instalar

**Windows 10 ou 11 (64 bits)**

1. Abra o release marcado **Latest** e baixe `assistente-bcode-<versão>-setup.exe`.
2. Abra o arquivo. A B Code ainda não tem o certificado de assinatura de código da Microsoft, então o
   Windows mostra **"O Windows protegeu o computador"**. Clique em **Mais informações** e depois em
   **Executar assim mesmo**. Se quiser, confira o arquivo antes (veja abaixo).
3. A instalação é só pro seu usuário (não pede senha de administrador) e leva uns 20 segundos. O app
   fica em `%LOCALAPPDATA%\Programs\assistente-bcode` e ganha atalho no menu Iniciar e na Área de
   Trabalho.

Depois disso o próprio app procura versão nova (1 minuto depois de abrir e, depois, a cada 6 horas),
baixa e confere sozinho, e só instala com o seu OK: **Ajustes › Atualizações › Ver as notas e instalar**.

**Linux (Ubuntu, Debian e parecidos, 64 bits)**

Baixe `assistente-bcode_<versão>_amd64.deb` e instale com:

```sh
sudo apt install ./assistente-bcode_<versão>_amd64.deb
```

No Linux o app avisa, baixa e confere a versão nova; a instalação é você quem faz, abrindo o `.deb`
baixado (**Ajustes › Atualizações › Ver as notas › Mostrar o arquivo**).

## Como o app confere cada versão

O app não confia no servidor nem no GitHub: ele confere tudo antes de baixar e de novo antes de
instalar.

1. O arquivo do canal (`latest.yml`, `teste.yml`…) traz um manifesto assinado pela B Code com
   **Ed25519**: canal, sistema, versão, nome do instalador, **sha512**, tamanho, data e notas.
2. O app só aceita a assinatura de uma das 2 chaves públicas que já vêm dentro dele (abaixo). Se o canal
   ou o sistema não baterem, ou se a versão não for mais nova que a instalada, ele recusa sem baixar nada.
3. Depois do download, o app calcula o sha512 do instalador e compara com o assinado. Diferente =
   recusado, nada é instalado. No Windows ele calcula de novo logo antes de instalar.

Chaves públicas da B Code (Ed25519, SPKI DER em base64). A impressão é o começo (16 letras e números)
do sha256 da chave e aparece em `assinatura.chave` em cada arquivo do canal:

| Chave | Impressão | Chave pública |
|---|---|---|
| Principal (assina hoje) | `37e93bdc2164bea6` | `MCowBQYDK2VwAyEAQ5wOseWTW8upCqXccmtc8L0kkNtN2BxzRoGWdAn/5Cw=` |
| Reserva (só se a principal vazar) | `4b168a72dc01b97a` | `MCowBQYDK2VwAyEAfLaC3tweDXDtJyF6TD+orad5kaRTkcew0Zs6vexNKuw=` |

As chaves privadas nunca passam por este repositório: a cada execução, o robô procura chave privada no
histórico inteiro.

### Conferir o instalador à mão

As notas de cada versão trazem o sha512 de cada instalador (em hexadecimal) e a impressão da chave que
assinou. Calcule o do arquivo que você baixou e compare:

- Windows (PowerShell): `Get-FileHash .\assistente-bcode-<versão>-setup.exe -Algorithm SHA512`
- Linux: `sha512sum assistente-bcode_<versão>_amd64.deb`

Os 2 valores têm de ser iguais (o PowerShell mostra em letras maiúsculas; tanto faz).

## O robô do Windows

O `.github/workflows/robo-windows.yml` roda no GitHub Actions, num Windows Server 2025 limpo, só quando
alguém dispara: o script de publicar da B Code ou a aba **Actions › robo-windows › Run workflow**. Ele
baixa o instalador do release (nunca código do app) e testa de fora pra dentro, como um cliente (o teste
fica em `robo/`):

- **teste** (pré-lançamento): instala em silêncio; abre em 1366x768 e em 1920x1080 e tira os prints;
  mostra Ajustes › Atualizações; confere os fusíveis do Electron e a integridade do app (uma cópia com
  1 caractere mexido no `app.asar` não abre; a cópia igual abre); desinstala. Com a versão anterior
  informada, também instala a anterior e atualiza pelo próprio app até a nova (procura, baixa, confere,
  instala, o app reabre sozinho e diz que está em dia). Essa parte usa o servidor de atualizações de
  verdade: o canal teste já tem de apontar pra versão nova.
- **oficial** (estável): instala, confere os fusíveis ("rodar como Node" e inspetor desligados,
  integridade ligada), abre sem o Playwright, tira o print, confere a integridade e desinstala.
- Em toda execução, um 2º trabalho procura chave privada no histórico inteiro deste repositório.

Segurança: o robô só tem permissão de leitura, não usa segredo nenhum, as ações vêm fixadas pelo commit
e ele não roda em pull request. **Os registros e os prints são públicos** (os prints ficam 30 dias): o app
roda com a pasta de dados vazia (sem nome e sem chave de IA) e o registro só mostra versão e estado.

Disparar à mão (exemplo):

```sh
gh workflow run robo-windows.yml -f tipo=teste -f tag=v0.8.0-teste.131 -f anterior=v0.8.0-teste.130
```

---

O Assistente · B Code é um software proprietário da B Code. Todos os direitos reservados.
