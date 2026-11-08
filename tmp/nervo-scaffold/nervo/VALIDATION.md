# Validação inicial

## Configurações e transmissão ao vivo — atualização

- `cargo test`: **6 testes passaram**, incluindo persistência de configurações, validação de limites e rejeição de revisão antiga.
- `cargo clippy --all-targets -- -D warnings`: sem alertas.
- Build TypeScript/Vite: passou.
- Teste de integração: **12 verificações passaram**, incluindo alteração da coleta para 100 ms em execução, salvamento de `settings.json`, respostas 400/409 e três mensagens SSE sucessivas. Os padrões foram restaurados pelo teste.
- Backend final reiniciado e respondendo. Preferências econômicas de 2000 ms mantidas; frequências maiores ficam disponíveis para escolha no painel.
- A revisão visual desta nova página não foi concluída: o navegador integrado bloqueou a navegação por política da ferramenta. Os resultados visuais abaixo pertencem à versão inicial do painel.

As medições da execução mais recente ficam em `test-results/latest.json`; os números da seção inicial abaixo são registros históricos, não metas de desempenho.

Executada nesta máquina em 2026-10-11 (Fortaleza), 2026-10-12 UTC. Windows 11, Ryzen 5 5600G, 12 processadores lógicos. Build release, rmcp 3.5.1.

- `cargo test`: **5 testes passaram**: caminhos restritos, controle de versões, paginação UTF-8, publicação concorrente ordenada e falha de disco sinalizada.
- `cargo clippy --all-targets -- -D warnings`: **sem alertas**.
- `npm run build`: **TypeScript e build do painel passaram**.
- `node scripts/smoke.mjs`: **10 verificações passaram**, incluindo MCP initialize/tools/list/tools/call, autenticação, origem HTTP, APIs Windows, leitura paginada, corrida de escrita, consultas concorrentes e gravação de Markdown após 30 s.
- Verificação visual no navegador: painel conectado, dados reais, consulta `context_get`, criação de `workspace/verificacao-painel.md`, exploração da memória e layout desktop. O estado offline foi observado antes de iniciar o backend.

## Medições pontuais

Última execução isolada: resposta de saúde após aproximadamente **138 ms** desde o lançamento (inclui polling). Memória privada após chamadas: **3,16–3,56 MiB**. Amostras de CPU: **0–0,194%** do total normalizado pelos 12 processadores lógicos, com resolução limitada de amostragem. O processo com painel conectado foi observado com aproximadamente **2,5 MiB privados e 9,2 MiB residentes**.

Não é benchmark controlado de cold boot, nem limite garantido de memória. Caches do Windows, volume de eventos, concorrência e dados retornados mudam os valores. Uma amostra `0%` não significa ausência de trabalho. A memória privada difere do working set residente e do consumo do navegador/Node.

O teste de persistência registrou 7 eventos em um lote, zero descartes e nenhum erro. Relatório bruto reproduzível: `test-results/latest.json` (ignorado pelo Git; pode ser recriado pelo teste).

## Limites da validação

Não foram simuladas queda de energia, logout, disco travado, carga prolongada, UI protegida/elevada, mudança maliciosa de junction ou acesso de agentes remotos. Inicialização no login tem scripts disponíveis, mas não foi ativada nem validada após reinicialização do Windows. OCR, captura de tela, UI Automation e controle de entrada ainda não fazem parte desta versão.
