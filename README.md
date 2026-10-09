# Lume

Gerenciador de sessões do Claude Code, Codex e Antigravity, organizado por projeto.
O Lume não tem harness próprio: lê as sessões que cada ferramenta grava no disco e abre/continua tudo
no próprio provider.

- `src/` — interface (React + TypeScript)
- `src-tauri/` — app desktop (Tauri 2 / Rust)
- `poc/gerenciador.py` — POC original em Python (referência dos formatos de sessão e deep links)

## Desenvolver

```bash
npm install
npm run tauri dev
```

## Lançar uma versão

```bash
npm run release -- 0.2.0 "o que mudou"
```

Sobe a versão no `package.json`, commita, cria a tag e dá push. O GitHub Actions compila, assina e publica a
release privada com o `latest.json`. O app instalado detecta a versão nova ao abrir e se atualiza sozinho.

## Atualização automática (repo privado)

- O app usa o login do `gh` da conta `mnnobre` na hora da checagem (`gh auth token --user mnnobre`).
  Nenhum token fica gravado no app. Sem esse login, o app funciona, só não se atualiza.
- A chave que assina as atualizações fica em `~/.tauri/lume.key` (e no secret `TAURI_SIGNING_PRIVATE_KEY`).
  **Faça backup dela**: sem essa chave, as versões instaladas não aceitam mais atualizações.
