# pi-codex-web

Pi extension that exposes Codex's native Responses API web search as Pi tools.
It talks directly to the Codex Responses endpoint and can reuse the ChatGPT
credentials stored by Codex in `auth.json`.

## Tools

- `search_query` — live web search, with optional related queries, domains, and freshness hint.
- `open` — open a URL and return grounded page content.
- `find_in_page` — find a phrase in a URL.

The implementation follows Codex's request shape: a streamed `POST` to
`/responses` with a `web_search` tool whose `external_web_access` is `true`.
It does not spawn `codex exec` or depend on the Codex CLI binary.

## Install

From this checkout:

```bash
pi -e .
```

From npm after publishing:

```bash
pi install npm:pi-codex-web
```

## Authentication

By default the extension reads `~/.codex/auth.json`, or
`$CODEX_HOME/auth.json` when `CODEX_HOME` is set. Set
`CODEX_WEB_AUTH_PATH` to use another file.

The supported Codex file shape is the normal ChatGPT token form with
`tokens.access_token`, `tokens.refresh_token`, and `tokens.account_id`. On a
401 response the extension uses the same OAuth refresh client ID and scope as
Codex, writes the rotated credentials back to the auth file, and retries once.

API-key auth files containing `OPENAI_API_KEY` are also accepted. In that case
the default endpoint is `https://api.openai.com/v1`.

## Configuration

Environment variables:

| Variable                 | Default                                 | Purpose                                    |
| ------------------------ | --------------------------------------- | ------------------------------------------ |
| `CODEX_HOME`             | `~/.codex`                              | Directory containing `auth.json`           |
| `CODEX_WEB_AUTH_PATH`    | `$CODEX_HOME/auth.json`                 | Explicit auth file path                    |
| `CODEX_WEB_MODEL`        | `gpt-6-luna`                            | Responses API model                        |
| `CODEX_WEB_BASE_URL`     | `https://chatgpt.com/backend-api/codex` | ChatGPT/Codex Responses base URL           |
| `CODEX_WEB_API_BASE_URL` | `https://api.openai.com/v1`             | Base URL used for API-key auth             |
| `CODEX_WEB_ORIGINATOR`   | `codex_cli_rs`                          | Codex-compatible request originator header |

## Source reference

The wire format was derived from the Codex Rust source at the `rust-v0.105.0`
tag:

- [`ToolSpec::WebSearch`](https://github.com/openai/codex/blob/rust-v0.105.0/codex-rs/core/src/client_common.rs)
- [`ResponsesApiRequest`](https://github.com/openai/codex/blob/rust-v0.105.0/codex-rs/codex-api/src/common.rs)
- [`WebSearchAction`](https://github.com/openai/codex/blob/rust-v0.105.0/codex-rs/protocol/src/models.rs)
- [`ResponsesClient`](https://github.com/openai/codex/blob/rust-v0.105.0/codex-rs/codex-api/src/endpoint/responses.rs)

## Development

```bash
npm install
npm run ci
```

The tests use a mocked SSE Responses endpoint, so they do not send credentials
or network requests.

## Security

This extension reads local Codex credentials and sends them to the configured
Responses endpoint. Keep `auth.json` private and review the endpoint-related
environment variables before loading third-party extensions.

See [`SECURITY.md`](SECURITY.md) for vulnerability reports.

## License

MIT
