# Assistente · B Code — instaladores

Este repositório guarda só o que o cliente baixa: os instaladores do Assistente · B Code
(Windows e Linux), o manifesto assinado de cada versão, as notas da versão e o teste
automático do instalador do Windows. **O código-fonte do app não fica aqui.**

- **Versões:** aba *Releases*. As marcadas como *pré-lançamento* são o canal de teste;
  as outras, o canal estável.
- **Atualização segura:** cada versão traz um manifesto assinado pela B Code (Ed25519).
  O app só instala uma versão nova se a assinatura e o sha512 do arquivo conferem.
- **Robô do Windows:** um teste no GitHub Actions instala a versão em silêncio, abre o app,
  tira os prints e confere a atualização. Os registros são públicos e usam só dados de teste.

O Assistente · B Code é um software proprietário da B Code. Todos os direitos reservados.
