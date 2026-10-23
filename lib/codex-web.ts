import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export type WebOperation =
  | {
      kind: "search_query";
      q: string;
      queries?: string[];
      domains?: string[];
      recency?: string;
    }
  | { kind: "open"; url: string }
  | { kind: "find_in_page"; url: string; pattern: string };

export type WebSearchAction =
  | { type: "search"; query?: string; queries?: string[] }
  | { type: "open_page"; url?: string }
  | { type: "find_in_page"; url?: string; pattern?: string }
  | { type: string; [key: string]: unknown };

export interface WebCitation {
  url: string;
  title?: string;
  startIndex?: number;
  endIndex?: number;
}

export interface CodexWebResult {
  text: string;
  actions: WebSearchAction[];
  citations: WebCitation[];
  responseId?: string;
}

export interface CodexWebClientOptions {
  authPath?: string;
  baseUrl?: string;
  model?: string;
  originator?: string;
  fetchImpl?: FetchImpl;
}

export type FetchImpl = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

interface AuthDocument {
  auth_mode?: string;
  OPENAI_API_KEY?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
    id_token?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface Credentials {
  kind: "chatgpt" | "api_key";
  accessToken: string;
  refreshToken?: string;
  accountId?: string;
}

interface ParsedResponse {
  result: CodexWebResult;
  error?: string;
}

const DEFAULT_MODEL = "gpt-6-luna";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_REFRESH_URL = "https://auth.openai.com/oauth/token";
const CODEX_ORIGINATOR = "codex_cli_rs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function defaultCodexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_WEB_AUTH_PATH;
  if (configured) return resolve(expandHome(configured));

  const codexHome = env.CODEX_HOME ? expandHome(env.CODEX_HOME) : join(homedir(), ".codex");
  return resolve(codexHome, "auth.json");
}

export function responsesEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
}

export function operationPrompt(operation: WebOperation): string {
  switch (operation.kind) {
    case "search_query": {
      const queries = operation.queries?.filter(nonEmptyString) ?? [];
      const domainHint = operation.domains?.length
        ? ` Restrict results to these domains when possible: ${operation.domains.join(", ")}.`
        : "";
      const recencyHint = operation.recency
        ? ` Prefer results from the last ${operation.recency}.`
        : "";
      const batchHint = queries.length
        ? ` Also search these related queries in the same web search: ${queries.join("; ")}.`
        : "";
      return [
        "Use the built-in web_search tool to perform a live web search.",
        `Primary query: ${operation.q}`,
        `${batchHint}${domainHint}${recencyHint}`,
        "After the tool finishes, return the useful search results with source URLs and a concise factual summary.",
        "Do not answer from memory and do not describe the tool call itself.",
      ].join(" ");
    }
    case "open":
      return [
        "Use the built-in web_search tool's open_page action to open this URL:",
        operation.url,
        "Return the useful page content and source URL. Do not answer from memory or describe the tool call.",
      ].join(" ");
    case "find_in_page":
      return [
        "Use the built-in web_search tool's find_in_page action.",
        `URL: ${operation.url}`,
        `Find: ${operation.pattern}`,
        "Return the matching context and source URL. Do not answer from memory or describe the tool call.",
      ].join(" ");
  }
}

export function buildResponsesRequest(
  operation: WebOperation,
  model: string,
  sessionId: string,
): Record<string, unknown> {
  return {
    model,
    instructions:
      "You are a web retrieval adapter for Pi. Use the supplied built-in web_search tool exactly as requested and return grounded results.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: operationPrompt(operation) }],
      },
    ],
    tools: [{ type: "web_search", external_web_access: true }],
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: null,
    store: false,
    stream: true,
    include: [],
    prompt_cache_key: sessionId,
  };
}

function authDocumentCredentials(document: AuthDocument, authPath: string): Credentials {
  const tokens = document.tokens;
  if (isRecord(tokens) && nonEmptyString(tokens.access_token)) {
    return {
      kind: "chatgpt",
      accessToken: tokens.access_token,
      refreshToken: nonEmptyString(tokens.refresh_token) ? tokens.refresh_token : undefined,
      accountId: nonEmptyString(tokens.account_id) ? tokens.account_id : undefined,
    };
  }

  if (nonEmptyString(document.OPENAI_API_KEY)) {
    return { kind: "api_key", accessToken: document.OPENAI_API_KEY };
  }

  throw new Error(`Codex auth at ${authPath} has no usable tokens or OPENAI_API_KEY`);
}

async function readAuthDocument(authPath: string): Promise<AuthDocument> {
  const raw = await readFile(authPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error(`Codex auth at ${authPath} is not a JSON object`);
  return parsed as AuthDocument;
}

async function loadCredentials(authPath: string): Promise<Credentials> {
  const document = await readAuthDocument(authPath);
  return authDocumentCredentials(document, authPath);
}

async function refreshCredentials(
  authPath: string,
  credentials: Credentials,
  fetchImpl: FetchImpl,
  signal: AbortSignal | undefined,
): Promise<Credentials> {
  if (credentials.kind !== "chatgpt" || !credentials.refreshToken) {
    throw new Error("Codex web request was unauthorized and no ChatGPT refresh token is available");
  }

  const response = await fetchImpl(CODEX_REFRESH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      scope: "openid profile email",
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Codex token refresh failed with HTTP ${response.status}`);
  }

  const refreshed: unknown = await response.json();
  if (!isRecord(refreshed) || !nonEmptyString(refreshed.access_token)) {
    throw new Error("Codex token refresh returned no access token");
  }

  const document = await readAuthDocument(authPath);
  const tokens = isRecord(document.tokens) ? document.tokens : {};
  tokens.access_token = refreshed.access_token;
  if (nonEmptyString(refreshed.refresh_token)) tokens.refresh_token = refreshed.refresh_token;
  if (nonEmptyString(refreshed.id_token)) tokens.id_token = refreshed.id_token;
  document.tokens = tokens;
  document.last_refresh = new Date().toISOString();

  const temporaryPath = `${authPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, authPath);

  return authDocumentCredentials(document, authPath);
}

function textFromMessageItem(item: unknown): string[] {
  if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) return [];

  return item.content.flatMap((content) => {
    if (!isRecord(content) || content.type !== "output_text" || !nonEmptyString(content.text)) return [];
    return [content.text];
  });
}

function actionFromItem(item: unknown): WebSearchAction | undefined {
  if (!isRecord(item) || item.type !== "web_search_call" || !isRecord(item.action)) return undefined;
  if (!nonEmptyString(item.action.type)) return undefined;
  return item.action as WebSearchAction;
}

function citationFromValue(value: unknown): WebCitation | undefined {
  if (!isRecord(value) || value.type !== "url_citation" || !nonEmptyString(value.url)) return undefined;
  const citation: WebCitation = { url: value.url };
  if (nonEmptyString(value.title)) citation.title = value.title;
  if (typeof value.start_index === "number") citation.startIndex = value.start_index;
  if (typeof value.end_index === "number") citation.endIndex = value.end_index;
  return citation;
}

function collectCitations(value: unknown, output: WebCitation[]): void {
  const citation = citationFromValue(value);
  if (citation && !output.some((item) => item.url === citation.url && item.title === citation.title)) {
    output.push(citation);
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCitations(item, output);
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) collectCitations(item, output);
  }
}

function collectOutputText(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectOutputText(item, output);
    return;
  }
  if (!isRecord(value)) return;

  if (value.type === "output_text" && nonEmptyString(value.text)) output.push(value.text);
  for (const item of Object.values(value)) collectOutputText(item, output);
}

function inspectEvent(
  event: Record<string, unknown>,
  state: {
    deltas: string[];
    fallbackText: string[];
    actions: WebSearchAction[];
    citations: WebCitation[];
    responseId?: string;
  },
): string | undefined {
  if (isRecord(event.response) && nonEmptyString(event.response.id)) state.responseId = event.response.id;
  if (nonEmptyString(event.id) && event.type === "response.created") state.responseId = event.id;

  if (event.type === "response.output_text.delta" && nonEmptyString(event.delta)) {
    state.deltas.push(event.delta);
  }
  if (event.type === "response.output_text.done" && nonEmptyString(event.text)) {
    state.fallbackText.push(event.text);
  }

  const item = event.item;
  const action = actionFromItem(item);
  if (action && !state.actions.some((existing) => JSON.stringify(existing) === JSON.stringify(action))) {
    state.actions.push(action);
  }
  state.fallbackText.push(...textFromMessageItem(item));
  collectCitations(event, state.citations);

  if (event.type === "response.failed" || event.type === "error" || event.type === "response.error") {
    if (isRecord(event.error) && nonEmptyString(event.error.message)) return event.error.message;
    if (nonEmptyString(event.message)) return event.message;
    return "Codex web request failed";
  }

  if (isRecord(event.response)) {
    const responseText: string[] = [];
    collectOutputText(event.response, responseText);
    state.fallbackText.push(...responseText);
  }
  return undefined;
}

function dedupeStrings(values: string[]): string[] {
  return values.filter((value, index) => value.trim().length > 0 && values.indexOf(value) === index);
}

function finalizeParsedResponse(state: {
  deltas: string[];
  fallbackText: string[];
  actions: WebSearchAction[];
  citations: WebCitation[];
  responseId?: string;
}): CodexWebResult {
  const text = dedupeStrings(state.deltas.length ? [state.deltas.join("")] : state.fallbackText).join("\n\n");
  return {
    text: text || (state.actions.length ? JSON.stringify(state.actions, null, 2) : "Web request completed without text output."),
    actions: state.actions,
    citations: state.citations,
    responseId: state.responseId,
  };
}

async function parseSseResponse(response: Response): Promise<ParsedResponse> {
  if (!response.body) return { result: { text: await response.text(), actions: [], citations: [] } };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventData: string[] = [];
  const state = { deltas: [], fallbackText: [], actions: [], citations: [] } as {
    deltas: string[];
    fallbackText: string[];
    actions: WebSearchAction[];
    citations: WebCitation[];
    responseId?: string;
  };

  const consumeEvent = (): string | undefined => {
    if (eventData.length === 0) return undefined;
    const raw = eventData.join("\n");
    eventData = [];
    if (raw === "[DONE]") return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) return undefined;
      return inspectEvent(parsed, state);
    } catch {
      return `Codex web response contained invalid SSE JSON: ${raw.slice(0, 120)}`;
    }
  };

  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "") {
        const error = consumeEvent();
        if (error) return { result: finalizeParsedResponse(state), error };
      } else if (line.startsWith("data:")) {
        eventData.push(line.slice(5).trimStart());
      }
    }
    if (chunk.done) break;
  }

  if (buffer.startsWith("data:")) eventData.push(buffer.slice(5).trimStart());
  const error = consumeEvent();
  return { result: finalizeParsedResponse(state), error };
}

export class CodexWebClient {
  private readonly authPath: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly originator: string;
  private readonly fetchImpl: FetchImpl;

  constructor(options: CodexWebClientOptions = {}) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (!fetchImpl) throw new Error("This runtime does not provide fetch");

    this.authPath = options.authPath ?? defaultCodexAuthPath();
    this.model = options.model ?? process.env.CODEX_WEB_MODEL ?? DEFAULT_MODEL;
    this.originator = options.originator ?? process.env.CODEX_WEB_ORIGINATOR ?? CODEX_ORIGINATOR;
    this.fetchImpl = fetchImpl;
    this.baseUrl = options.baseUrl ?? process.env.CODEX_WEB_BASE_URL ?? DEFAULT_CODEX_BASE_URL;
  }

  async run(operation: WebOperation, signal?: AbortSignal): Promise<CodexWebResult> {
    let credentials = await loadCredentials(this.authPath);
    if (credentials.kind === "chatgpt" && !credentials.accountId) {
      throw new Error(`Codex auth at ${this.authPath} has no tokens.account_id`);
    }

    const sessionId = randomUUID();
    const body = buildResponsesRequest(operation, this.model, sessionId);
    const endpoint = responsesEndpoint(
      credentials.kind === "api_key" && this.baseUrl === DEFAULT_CODEX_BASE_URL
        ? process.env.CODEX_WEB_API_BASE_URL ?? DEFAULT_OPENAI_BASE_URL
        : this.baseUrl,
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const headers: Record<string, string> = {
        accept: "text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${credentials.accessToken}`,
        originator: this.originator,
        "user-agent": "pi-codex-web/0.1.0",
        session_id: sessionId,
      };
      if (credentials.accountId) headers["chatgpt-account-id"] = credentials.accountId;

      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });

      if (response.status === 401 && attempt === 0 && credentials.refreshToken) {
        credentials = await refreshCredentials(this.authPath, credentials, this.fetchImpl, signal);
        continue;
      }

      if (!response.ok) {
        const errorBody = (await response.text()).slice(0, 1_000).replace(/\s+/g, " ").trim();
        throw new Error(
          `Codex web request failed with HTTP ${response.status}${errorBody ? `: ${errorBody}` : ""}`,
        );
      }

      const parsed = await parseSseResponse(response);
      if (parsed.error) throw new Error(parsed.error);
      return parsed.result;
    }

    throw new Error("Codex web request failed after token refresh");
  }
}
