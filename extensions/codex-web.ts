import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { CodexWebClient, type CodexWebResult, type WebOperation } from "../lib/codex-web.ts";

const searchQueryParameters = Type.Object({
  q: Type.String({ description: "The primary search query" }),
  queries: Type.Optional(Type.Array(Type.String(), { description: "Optional related queries to run together" })),
  domains: Type.Optional(Type.Array(Type.String(), { description: "Optional domains to prefer" })),
  recency: Type.Optional(Type.String({ description: "Optional freshness window, for example 24h or 7d" })),
});

const openParameters = Type.Object({
  url: Type.String({ description: "The fully qualified URL to open" }),
});

const findInPageParameters = Type.Object({
  url: Type.String({ description: "The fully qualified URL to inspect" }),
  pattern: Type.String({ description: "Text or a phrase to find in the page" }),
});

type SearchQueryParams = Static<typeof searchQueryParameters>;
type OpenParams = Static<typeof openParameters>;
type FindInPageParams = Static<typeof findInPageParameters>;

type WebToolDetails = CodexWebResult | { error: string };

function resultText(result: CodexWebResult): string {
  if (result.citations.length === 0) return result.text;
  const sources = result.citations
    .map((citation) => `- ${citation.title ? `${citation.title}: ` : ""}${citation.url}`)
    .join("\n");
  return `${result.text}\n\nSources:\n${sources}`;
}

function renderCall(label: string, value: string, theme: Parameters<NonNullable<ToolDefinition["renderCall"]>>[1]) {
  return new Text(`${theme.fg("toolTitle", theme.bold(`${label} `))}${theme.fg("accent", value)}`, 0, 0);
}

function renderResult(
  result: { content: Array<{ type: string; text?: string }>; details: WebToolDetails },
  theme: Parameters<NonNullable<ToolDefinition["renderResult"]>>[2],
) {
  if ("error" in result.details) {
    return new Text(`${theme.fg("error", "✗ ")}${theme.fg("error", result.details.error)}`, 0, 0);
  }
  const text = result.content.find((item) => item.type === "text")?.text ?? result.details.text;
  return new Text(`${theme.fg("success", "→ ")}${theme.fg("text", text)}`, 0, 0);
}

function createClient(): CodexWebClient {
  return new CodexWebClient();
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
  const client = createClient();

  const execute = async (
    operation: WebOperation,
    signal: AbortSignal | undefined,
  ): Promise<{ content: [{ type: "text"; text: string }]; details: WebToolDetails; isError?: boolean }> => {
    try {
      const result = await client.run(operation, signal);
      return { content: [{ type: "text", text: resultText(result) }], details: result };
    } catch (error) {
      const message = `Codex web request failed: ${safeError(error)}`;
      return { content: [{ type: "text", text: message }], details: { error: message }, isError: true };
    }
  };

  pi.registerTool({
    name: "search_query",
    label: "Web Search",
    description: "Search the live web through Codex's Responses API web_search tool.",
    promptSnippet: "search_query: search the live web with Codex web search",
    promptGuidelines: ["Use search_query for current information and include source URLs in the answer."],
    parameters: searchQueryParameters,
    async execute(_toolCallId, params, signal) {
      return execute({ kind: "search_query", ...params }, signal);
    },
    renderCall(args, theme) {
      return renderCall("search_query", JSON.stringify(args.q), theme);
    },
    renderResult(result, _options, theme) {
      return renderResult(result, theme);
    },
  });

  pi.registerTool({
    name: "open",
    label: "Open Web Page",
    description: "Open a URL through Codex's Responses API web_search tool and return grounded page content.",
    promptSnippet: "open: open a URL with Codex web search",
    promptGuidelines: ["Use open after search_query when the contents of a specific source are needed."],
    parameters: openParameters,
    async execute(_toolCallId, params, signal) {
      return execute({ kind: "open", ...params }, signal);
    },
    renderCall(args, theme) {
      return renderCall("open", args.url, theme);
    },
    renderResult(result, _options, theme) {
      return renderResult(result, theme);
    },
  });

  pi.registerTool({
    name: "find_in_page",
    label: "Find In Web Page",
    description: "Find a phrase in a URL through Codex's Responses API web_search tool.",
    promptSnippet: "find_in_page: find text in a web page",
    promptGuidelines: ["Use find_in_page to locate a phrase in a page that has already been identified."],
    parameters: findInPageParameters,
    async execute(_toolCallId, params, signal) {
      return execute({ kind: "find_in_page", ...params }, signal);
    },
    renderCall(args, theme) {
      return renderCall("find_in_page", `${args.pattern} in ${args.url}`, theme);
    },
    renderResult(result, _options, theme) {
      return renderResult(result, theme);
    },
  });
}
