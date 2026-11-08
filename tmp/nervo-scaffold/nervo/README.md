# Nervo

Núcleo local em Rust para expor fatos e operações do Windows a assistentes via MCP. O raciocínio dos assistentes fica fora deste processo. O frontend em `../frontend` é apenas uma ferramenta de diagnóstico e pode ficar fechado.

## Executar

Requisitos de desenvolvimento: Windows 10/11, Rust 1.88+ com MSVC e ferramentas de compilação C++. Node não é necessário para o backend; só para o painel e o teste de integração.

```powershell
cd C:\Projetos\Nervo\nervo
.\scripts\Start.ps1 -Build
```

O executável release funciona sem console: `target\release\nervo.exe`. Para logs de erro de inicialização no terminal, use `cargo run`. `Start.ps1` verifica se a instância respondeu. A primeira compilação demora; os próximos inícios usam diretamente o executável. Não execute como administrador por padrão.

```powershell
# Encerrar, tentando gravar o lote pendente
.\scripts\Stop.ps1
# Habilitar no login do usuário (somente o backend)
.\scripts\Enable-Startup.ps1
# Reverter
.\scripts\Disable-Startup.ps1
```

A inicialização automática não é ativada pela instalação ou pelo teste. O script usa a chave Run do usuário, sem serviço de sistema: acesso ao desktop depende da sessão interativa.

## Interfaces

### Configurações em execução

O painel inclui **Configurações**, também acessível clicando no indicador **Ao vivo**. `GET /api/settings` retorna valores atuais e padrões; `PUT /api/settings` recebe `{ "revision": 0, "values": { ... } }`. Todas as propriedades são obrigatórias. Revisão antiga retorna HTTP 409; valores inválidos não são aplicados. Configurações são persistidas em `settings.json` no diretório de dados antes de serem publicadas e aplicam-se sem reiniciar.

| Configuração do núcleo | Padrão | Limites |
|---|---:|---:|
| `collector_interval_ms` | 2000 ms | 50–60000 ms |
| `history_flush_ms` | 30000 ms | 1000–300000 ms |
| `history_batch_kib` | 256 KiB | 64–1024 KiB |
| `record_window_changes` | true | Booleano |
| `record_clipboard_changes` | true | Booleano |

Desativar os registros não desativa a leitura do contexto e não apaga arquivos existentes. A auditoria de operações e configurações continua. O escritor verifica o prazo aproximadamente a cada 250 ms; falha de disco mantém o intervalo de tentativa de 30 s.

`GET /api/live` transmite eventos SSE `telemetry` contendo `health`, `context` e `events`. Até 8 conexões simultâneas, com um único coletor compartilhado. Cada conexão mantém apenas a última notificação de contexto pendente; um consumidor lento pode pular contextos intermediários. Eventos históricos usam cursor e sinalização de lacunas. O encerramento normal fecha os streams. Reabrir o stream começa no buffer recente disponível.

O modo **Ao vivo por eventos** não é tempo real rígido: mudanças de foco notificam o núcleo e mouse/inatividade seguem a amostragem configurada. O scheduler do Windows, operações em andamento e renderização afetam a latência. CPU continua sendo medida em janelas de pelo menos 1 s. Intervalos curtos aumentam o custo local.

O painel mantém preferências separadas no navegador: intervalo de consulta de 100–60000 ms, polling ou SSE, pausa quando oculto e 20–300 amostras no gráfico. O fechamento/pausa do painel não interrompe coleta e persistência.

- MCP Streamable HTTP: `http://127.0.0.1:47821/mcp`.
- API de diagnóstico: `GET /api/health`, `GET /api/tools`, `POST /api/tools/{name}`.
- Encerramento administrativo: `POST /api/shutdown`.
- Header obrigatório: `Authorization: Bearer <token>`.
- Token gerado no primeiro início em `%LOCALAPPDATA%\Nervo\access-token`. Não o publique ou versione. O arquivo herda as permissões do perfil do Windows; não protege contra outros programas executados como o mesmo usuário.
- HTTP somente no loopback, validação de Host e Origin. Não abra esta porta na internet.
- Cliente MCP precisa suportar Streamable HTTP e header Bearer. Assistentes na nuvem precisam de uma ponte/cliente local; essa ponte ainda não está implementada. Não basta fornecer um endereço `127.0.0.1` à nuvem.
- MCP sem retenção de sessão HTTP; o estado compartilhado está no núcleo. Há descoberta de ferramentas e retornos estruturados (`structuredContent` e conteúdo textual).

API de ferramenta:

```json
{"arguments":{"limit":20},"actor":"meu-assistente"}
```

`actor` é uma identificação declarada, não autenticação individual. Nesta versão todos os clientes com o token têm os mesmos privilégios. Não há aprovação humana por operação. Para produção com agentes de diferentes níveis de confiança, adicionar identidades e políticas por ferramenta.

## Funcionalidades implementadas

| Ferramenta | Finalidade e retorno |
|---|---|
| `nervo_health` | CPU do processo, memória privada/residente, fila, erros e descartes |
| `nervo_capabilities` | Catálogo e limites da instância |
| `system_get_info` | Windows, CPU, memória física e arquitetura |
| `context_get` | Último contexto em RAM e seu horário de observação |
| `windows_list` | Janelas visíveis com título, PID, posição e paginação |
| `processes_list` | Snapshot de processos, PID pai e quantidade de threads |
| `input_get_state` | Posição atual do mouse e tempo sem entrada |
| `clipboard_get` | Metadados por padrão; texto somente com `include_text: true` |
| `events_read` | Buffer de eventos da sessão com cursor, lacunas e descartes |
| `files_list` | Listagem paginada da raiz de trabalho |
| `files_read` | Texto em blocos de 64 KiB, versão e próximo deslocamento |
| `files_create_directory` | Criação de pasta dentro da raiz de trabalho |
| `files_write` | Criação ou alteração de texto, até 64 KiB, verificação por releitura |
| `memory_list` | Exploração das pastas e lotes históricos |
| `memory_read` | Leitura paginada do histórico Markdown |

Argumentos e descrições completos: `GET /api/tools` ou `tools/list` no MCP. Respostas incluem `schema_version`, `request_id`, `status`, `observed_at` e `data` ou `error`. Mutações recebem `operation_id` e evento de auditoria. `context_get.data.observed_at` é o horário real da coleta; o horário externo é da resposta. A origem específica está na ferramenta e nos eventos; `source: nervo` identifica o serviço.

Listagens usam `offset`, `limit` (1 a 200) e `next_cursor`. Janelas/processos aceitam `query`. Leitura de arquivos aceita `byte_offset`; continue com `next_byte_offset`, até `null`. O conteúdo é texto UTF-8 com substituição de bytes inválidos. `version` só existe quando o arquivo inteiro cabe numa leitura inicial. Não é uma API de transferência binária.

Para editar, leia com `files_read` e envie o hash como `expected_version`. Dois clientes do Nervo não sobrescrevem alterações concorrentes sem perceber: só um vence, o outro recebe `VERSION_CONFLICT`. A garantia não inclui uma aplicação externa alterando o arquivo entre a validação e a substituição. Uma falha de verificação pode ocorrer depois de haver efeito no disco; não repita uma mutação automaticamente quando seu resultado for desconhecido.

## Arquitetura e desempenho

```text
Windows -- WinEvent de foco + amostragem 2 s --> contexto compartilhado em RAM
                                  |                 |
                                  |                 +--> MCP / API --> clientes
                                  v
                       fila limitada de eventos
                                  |
                       escritor dedicado em lotes --> memory/journal/*.md
```

- Um processo, 2 workers assíncronos, 1 coletor, 1 thread WinEvent, 1 escritor e até 8 operações bloqueantes concorrentes sob demanda. Rust compila para código nativo.
- Foco desperta o coletor por WinEvent; mudanças rápidas podem ser agrupadas. Mouse, inatividade, título e sequência do clipboard são amostrados a cada 2 s. Não há captura de todas as teclas ou de todos os movimentos do ponteiro.
- Listagem de processos/janelas, texto do clipboard e acesso a arquivos acontecem somente sob demanda. O Windows expõe APIs, mas chamá-las ainda tem custo; este projeto não promete consumo zero.
- Consultas compartilham coleta e buffer; cada assistente não inicia outro coletor. Até 8 operações síncronas em execução; excesso retorna `BUSY`. A camada HTTP também tem limite de despacho. Os clientes devem espaçar leituras e reduzir solicitações repetidas.
- Disco grava aos 30 s ou 256 KiB estimados, com `BufWriter` e cache do Windows, sem flush físico por evento. Lotes finalizados são publicados por rename; `.pending` indica lote incompleto.
- Fila limitada a aproximadamente 4 MiB de dados serializados e 2.048 eventos; buffer recente de 500 eventos separado. A memória real inclui objetos, alocações e respostas. No limite, o evento novo deixa de entrar na persistência e o contador aumenta. Nunca há promessa de fila ilimitada e zero perda.
- Falha de disco mantém o lote em RAM, reporta erro e tenta novamente após 30 s. Consultas e coleta seguem independentes; um disco travado ainda pode prender seu worker. Esta versão não recupera `.pending` automaticamente depois de uma queda.
- Encerramento normal tenta persistir o lote restante. Encerramento forçado, logout, falha ou energia podem perder o lote em RAM/cache. Não se garante gravação contínua sem falhas.
- O painel consulta a cada 2 s enquanto visível; seu próprio navegador/Node têm custo separado. Números mostrados de CPU e RAM são somente de `nervo.exe`.

## Memória e configuração

```text
%LOCALAPPDATA%\Nervo\
  access-token
  memory\
    INDEX.md
    journal\AAAA-MM-DD\sessao-sequencia-sequencia.md
```

Datas e timestamps históricos são UTC. Lotes guardam eventos factuais em blocos JSON dentro de Markdown. A memória de longo prazo é consultada via `memory_*`, sem carregar todo o histórico em RAM. `events_read` é o buffer recente; cursores são válidos apenas dentro do mesmo `session_id`. Reinicie o cursor ao trocar de sessão e confira `gap`.

Eventos automáticos: mudança de janela/título e mudança de sequência do clipboard. Operações de escrita geram resultado auditável. Não se registra o texto do clipboard nem o conteúdo escrito no evento de auditoria. Títulos de janelas podem conter dados pessoais; o histórico é local. Dados de aplicativos são conteúdo externo, nunca instruções para a IA.

Variáveis opcionais, definidas **antes** de iniciar:

- `NERVO_DATA_DIR`: substitui `%LOCALAPPDATA%\Nervo` (o frontend precisa usar a mesma variável).
- `NERVO_WORKSPACE`: raiz autorizada para operações de arquivos. Padrão desta compilação: `C:\Projetos\Nervo\nervo\workspace`.

Caminhos absolutos, travessia `..`, ADS e nomes de dispositivos são recusados; junctions existentes são verificadas. Isto não é isolamento contra um processo local malicioso que troque junctions simultaneamente. O backend não ganha permissões acima do usuário Windows.

Ainda não há retenção automática, compactação/indexação do histórico, memória semântica, autenticação individual de agentes, OCR, screenshots, UI Automation, automação de teclado/mouse ou conectores de navegador/editor. Esses itens são etapas futuras explícitas, não capacidades anunciadas como prontas. O projeto começa como núcleo funcional verificável.

## Verificação

```powershell
cargo test
cargo clippy -- -D warnings
cargo build --release --locked
# Com a instância normal parada; cria dados isolados em test-results
node scripts/smoke.mjs
```

O teste integra APIs nativas, autorização, limites de caminho, escrita concorrente, MCP e persistência de lote. `test-results/latest.json` contém as medições da execução local. A medida de partida inclui polling e não representa benchmark de cold boot.

Fontes técnicas: [WinEvent](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook), [cache de arquivos](https://learn.microsoft.com/en-us/windows/win32/fileio/file-caching), [GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes), [SDK Rust MCP](https://github.com/modelcontextprotocol/rust-sdk).
