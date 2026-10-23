import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { CodexWebClient, buildResponsesRequest, operationPrompt, responsesEndpoint } = await import("../lib/codex-web.ts");

function sse(events) {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

function responseFor(events) {
  return new Response(sse(events), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function withAuth(document, callback) {
  const directory = await mkdtemp(join(tmpdir(), "pi-codex-web-"));
  const authPath = join(directory, "auth.json");
  await writeFile(authPath, `${JSON.stringify(document, null, 2)}\n`);
  try {
    return await callback(authPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("builds the Responses request using Codex's native web_search tool", () => {
  const request = buildResponsesRequest(
    { kind: "search_query", q: "latest TypeScript release", domains: ["typescriptlang.org"] },
    "gpt-test",
    "session-test",
  );

  assert.equal(request.model, "gpt-test");
  assert.deepEqual(request.tools, [{ type: "web_search", external_web_access: true }]);
  assert.equal(request.tool_choice, "auto");
  assert.equal(request.stream, true);
  assert.equal(request.prompt_cache_key, "session-test");
  assert.equal(request.input[0].type, "message");
  assert.match(request.input[0].content[0].text, /latest TypeScript release/);
  assert.match(request.input[0].content[0].text, /typescriptlang\.org/);
});

test("uses Codex web action prompts for open and find_in_page", () => {
  assert.match(
    operationPrompt({ kind: "open", url: "https://example.com/docs" }),
    /open_page action/,
  );
  assert.match(
    operationPrompt({ kind: "find_in_page", url: "https://example.com/docs", pattern: "install" }),
    /find_in_page action/,
  );
  assert.equal(responsesEndpoint("https://example.test/backend-api/codex/"), "https://example.test/backend-api/codex/responses");
});

test("sends a ChatGPT auth request and parses streamed web actions, text, and citations", async () => {
  await withAuth(
    {
      auth_mode: "chatgpt",
      tokens: {
        access_token: "access-test",
        refresh_token: "refresh-test",
        account_id: "account-test",
      },
    },
    async (authPath) => {
      const calls = [];
      const client = new CodexWebClient({
        authPath,
        baseUrl: "https://example.test/backend-api/codex",
        model: "gpt-test",
        fetchImpl: async (input, init) => {
          calls.push({ input: String(input), init });
          return responseFor([
            { type: "response.created", response: { id: "resp-test" } },
            {
              type: "response.output_item.done",
              item: {
                type: "web_search_call",
                status: "completed",
                action: { type: "search", query: "latest TypeScript release" },
              },
            },
            {
              type: "response.output_item.done",
              item: {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: "TypeScript 6 is available.",
                    annotations: [{ type: "url_citation", url: "https://example.com/typescript", title: "TypeScript" }],
                  },
                ],
              },
            },
            { type: "response.completed", response: { id: "resp-test" } },
          ]);
        },
      });

      const result = await client.run({ kind: "search_query", q: "latest TypeScript release" });
      const body = JSON.parse(calls[0].init.body);
      const headers = calls[0].init.headers;

      assert.equal(calls[0].input, "https://example.test/backend-api/codex/responses");
      assert.equal(headers.authorization, "Bearer access-test");
      assert.equal(headers["chatgpt-account-id"], "account-test");
      assert.equal(headers.originator, "codex_cli_rs");
      assert.match(headers.session_id, /^[0-9a-f-]{36}$/);
      assert.deepEqual(body.tools, [{ type: "web_search", external_web_access: true }]);
      assert.equal(result.responseId, "resp-test");
      assert.equal(result.actions[0].type, "search");
      assert.match(result.text, /TypeScript 6 is available/);
      assert.deepEqual(result.citations, [{ url: "https://example.com/typescript", title: "TypeScript" }]);
    },
  );
});

test("refreshes auth.json once after a 401 and retries the Responses request", async () => {
  await withAuth(
    {
      auth_mode: "chatgpt",
      tokens: {
        access_token: "old-access",
        refresh_token: "old-refresh",
        account_id: "account-test",
      },
    },
    async (authPath) => {
      const calls = [];
      const client = new CodexWebClient({
        authPath,
        baseUrl: "https://example.test/backend-api/codex",
        fetchImpl: async (input, init) => {
          calls.push({ input: String(input), init });
          if (String(input) === "https://auth.openai.com/oauth/token") {
            return new Response(JSON.stringify({
              access_token: "new-access",
              refresh_token: "new-refresh",
            }), { status: 200, headers: { "content-type": "application/json" } });
          }
          if (calls.length === 1) return new Response("expired", { status: 401 });
          return responseFor([{ type: "response.completed", response: { id: "resp-retried" } }]);
        },
      });

      const result = await client.run({ kind: "open", url: "https://example.com" });
      const persisted = JSON.parse(await readFile(authPath, "utf8"));

      assert.equal(calls.length, 3);
      assert.equal(calls[0].init.headers.authorization, "Bearer old-access");
      assert.equal(calls[2].init.headers.authorization, "Bearer new-access");
      assert.equal(calls[1].init.body.includes("old-refresh"), true);
      assert.equal(persisted.tokens.access_token, "new-access");
      assert.equal(persisted.tokens.refresh_token, "new-refresh");
      assert.equal(result.responseId, "resp-retried");
    },
  );
});
