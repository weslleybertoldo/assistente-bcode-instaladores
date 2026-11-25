// Configuração do robô do Windows. Um teste por vez (o app instalado é um só e segura a instância
// única), sem repetir teste que falhou (o registro tem de mostrar a 1ª falha) e com tempo alto: a
// atualização N → N+1 baixa ~142 MB e reinstala o app.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'testes',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  timeout: 20 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
})
