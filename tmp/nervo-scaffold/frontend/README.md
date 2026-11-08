# Nervo · Console de diagnóstico

Frontend React + TypeScript + Vite, separado do backend. Mostra dados reais e permite testar as ferramentas MCP usando a API local equivalente. Não precisa ficar aberto para que o Nervo funcione.

## Iniciar

Primeiro inicie `..\nervo\scripts\Start.ps1`. Depois:

```powershell
cd C:\Projetos\Nervo\frontend
npm ci
npm run dev
```

Abra **http://127.0.0.1:5177**. Ou use `Start.ps1`.

`npm run build` valida TypeScript e gera `dist`. `npm run preview` serve o resultado com o mesmo proxy local. Este painel precisa do servidor Vite/preview, não basta abrir `index.html` pelo disco.

## Áreas

- **Configurações:** acessível no menu ou pelo indicador Ao vivo. Ajusta o intervalo do painel em milissegundos, SSE por eventos, pausa quando oculto e número de amostras do gráfico. Preferências ficam em localStorage. O segundo formulário configura coleta, gravação e tipos de registro no backend, persistidos em `settings.json` e aplicados sem reiniciar. Há botões para preparar os padrões e recarregar valores salvos.

No modo por eventos o painel recebe snapshots por uma única conexão SSE e reconecta automaticamente. A coleta do mouse continua amostrada; o evento de foco pode antecipar uma atualização. Para maior fluidez, selecione o preset de coleta de 250 ms e o modo por eventos. O padrão econômico continua 2000 ms, sem ativar frequência maior automaticamente.

- **Visão geral:** memória/CPU do backend, fila, janela ativa, posição do ponteiro, inatividade e eventos recentes. Métricas não incluem o custo do próprio frontend.
- **Ferramentas:** catálogo real, contrato JSON, argumentos editáveis e execução. Escritas modificam a pasta de trabalho do backend. Para atualizar um arquivo, use a versão retornada por `files_read`.
- **Memória:** navegação pelos Markdown gravados, sem esperar a IA interpretar.
- **Conexão:** endpoint, autenticação e separação entre cliente, backend e nuvem.

O proxy lê o token de `%LOCALAPPDATA%\Nervo\access-token` no processo Node e insere o header para o backend. O segredo não é embutido no bundle. `NERVO_DATA_DIR`, quando definida, deve ser igual à usada pelo backend. O servidor escuta apenas em `127.0.0.1`. Não exponha este painel em rede pública.

Sem backend, a interface apresenta erro e marca dados antigos. Sem amostras, não inventa números. A série de CPU começa ao abrir a página e guarda até 60 amostras; o polling pausa quando a página fica oculta. Arquivos da memória podem ser lidos em blocos; respostas truncadas são sinalizadas.

As fontes têm fallback local para Segoe UI e Consolas; a importação opcional do Google Fonts exige rede. Para uso totalmente offline, remova a primeira linha de `src/style.css` ou hospede as fontes localmente.
