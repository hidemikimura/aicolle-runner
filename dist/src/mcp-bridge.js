import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
/**
 * aiColle の MCP との橋渡し（docs/design/ai-run.md「aiColle のツール」）
 *
 * aiColle（jimble-mcp）が話すのは MCP の 2026-07-28 版だけで、initialize を持たない。
 * Claude Agent SDK の MCP クライアントは 2025-11-25 版までしか話せず、最初の initialize で断られて
 * **ツールが1つも見えないままエージェントが動いてしまう**。
 *
 * そこで SDK には同じプロセスの中の MCP サーバー（type: 'sdk'）を渡し、
 * そのサーバーが一覧と呼び出しを 2026-07-28 版で aiColle に中継する。
 * SDK から見えるツール名は今までどおり `mcp__aicolle__<名前>`。
 */
/** aiColle が話す MCP の版 */
export const MCP_PROTOCOL_VERSION = '2026-07-28';
/** 本文の _meta に入れる版のキー */
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
/** 1回の呼び出しの待ち時間 */
const TIMEOUT_MS = 60_000;
/**
 * aiColle の MCP を 2026-07-28 版で呼ぶ
 *
 * 2026-07-28 版は本文の一部をヘッダにも写す（MCP-Protocol-Version / Mcp-Method / Mcp-Name）。
 * 食い違うとサーバーは 400 で断る。
 */
export class AicolleMcp {
    url;
    headers;
    fetchFn;
    seq = 0;
    constructor(url, headers, fetchFn = fetch) {
        this.url = url;
        this.headers = headers;
        this.fetchFn = fetchFn;
    }
    /** ツールの一覧（ページに分かれていれば全部読む） */
    async listTools() {
        const tools = [];
        let cursor;
        for (let page = 0; page < 100; page++) {
            const result = await this.call('tools/list', cursor ? { cursor } : {});
            tools.push(...(result.tools ?? []));
            cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
            if (!cursor) {
                break;
            }
        }
        return tools;
    }
    /** ツールを呼ぶ */
    async callTool(name, args) {
        const result = await this.call('tools/call', { name, arguments: args }, name);
        // 2026-07-28 版の印（resultType）は古い版の形には無いので落とす
        const { resultType: _resultType, ...rest } = result;
        return rest;
    }
    async call(method, params, name) {
        const id = ++this.seq;
        const body = {
            jsonrpc: '2.0',
            id,
            method,
            params: { ...params, _meta: { [META_PROTOCOL_VERSION]: MCP_PROTOCOL_VERSION } },
        };
        const response = await this.fetchFn(this.url, {
            method: 'POST',
            headers: {
                ...this.headers,
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
                'Mcp-Method': method,
                ...(name ? { 'Mcp-Name': name } : {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const text = await response.text();
        const message = parse(text, response.headers.get('content-type') ?? '', id);
        if (message?.error) {
            throw new Error(`aiColle の MCP（${method}）: ${message.error.message ?? '失敗しました'}（${response.status}）`);
        }
        if (!response.ok || !message?.result) {
            throw new Error(`aiColle の MCP（${method}）が ${response.status} を返しました: ${text.slice(0, 300)}`);
        }
        return message.result;
    }
}
/** 応答を読む（ふつうは JSON。SSE で返ってきたら同じ id のものを探す） */
function parse(text, contentType, id) {
    if (contentType.includes('text/event-stream')) {
        for (const line of text.split('\n')) {
            if (!line.startsWith('data:')) {
                continue;
            }
            try {
                const message = JSON.parse(line.slice(5).trim());
                if (message.id === id) {
                    return message;
                }
            }
            catch {
                // 読めない行は飛ばす
            }
        }
        return null;
    }
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
/**
 * SDK に渡す aiColle のツール（同じプロセスの中の MCP サーバー）
 *
 * **先に一覧を取る。**取れなければここで投げる（ツールの無いまま動かさない）。
 */
export async function aicolleMcpServer(remote) {
    const tools = await remote.listTools();
    if (tools.length === 0) {
        throw new Error('aiColle の MCP にツールがありません');
    }
    const server = new McpServer({ name: 'aicolle', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
        try {
            return await remote.callTool(request.params.name, (request.params.arguments ?? {}));
        }
        catch (error) {
            // エージェントには「失敗した」と分かる形で返す（落とすとセッションごと止まる）
            return {
                content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
                isError: true,
            };
        }
    });
    return { type: 'sdk', name: 'aicolle', instance: server };
}
//# sourceMappingURL=mcp-bridge.js.map