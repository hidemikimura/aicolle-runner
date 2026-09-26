import type { Options, SDKMessage, SessionStore } from '@anthropic-ai/claude-agent-sdk';
import type { AicolleClient } from './client.js';
import { aicolleMcpServer } from './mcp-bridge.js';
import type { RunSpec } from './spec.js';

/** Agent SDK の query（テストで差し替える） */
export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

/** 1回の query の結果 */
export interface AgentResult {
	sessionId: string;
	resultText: string;
	/** Agent SDK が数えた累計の原価（USD）。再開したセッションでは前回までを含む */
	totalCostUsd: number;
	inputTokens: number;
	outputTokens: number;
	isError: boolean;
	subtype: string;
}

/**
 * セッションの写しをサーバーに置く（別のサンドボックスで再開するため）
 */
export function sessionStore(client: AicolleClient): SessionStore {
	return {
		async append(key, entries) {
			await client.appendSession(key.sessionId, key.subpath ?? '', entries);
		},
		async load(key) {
			return (await client.loadSession(key.sessionId, key.subpath ?? '')) as Awaited<ReturnType<SessionStore['load']>>;
		},
	};
}

/**
 * エージェントを1回動かす
 */
export async function runAgent(
	spec: RunSpec,
	client: AicolleClient,
	cwd: string,
	input: { prompt: string; resume?: string },
	queryFn: QueryFn,
	abortController: AbortController,
): Promise<AgentResult> {
	// aiColle のツールは橋渡しを通す（SDK の MCP クライアントは aiColle の版を話せない。mcp-bridge.ts）
	// 一覧を取れなければここで投げて、ツールの無いまま動かさない
	const aicolle = await aicolleMcpServer(client.mcp(spec.mcp.url));

	const options: Options = {
		cwd,
		abortController,
		// リポジトリの CLAUDE.md と .claude/skills/ を読む（ナレッジの正本）
		settingSources: ['project'],
		systemPrompt: {
			type: 'preset',
			preset: 'claude_code',
			append:
				'あなたは aiColle のサンドボックスの中で動いている。人との連絡は MCP の aicolle のツールだけで行う。' +
				'git のコミット・push・PR 作成はランナーが行うので、あなたはしない。',
		},
		// サンドボックスの中なので確認なしで道具を使う（外への通信は Sandbox 側で絞る）
		permissionMode: 'bypassPermissions',
		allowDangerouslySkipPermissions: true,
		mcpServers: { aicolle },
		sessionStore: sessionStore(client),
		...(spec.ai.model ? { model: spec.ai.model } : {}),
		...(spec.ai.max_budget_usd != null ? { maxBudgetUsd: Math.max(0.01, spec.ai.max_budget_usd) } : {}),
		...(input.resume ? { resume: input.resume } : {}),
		stderr: (data: string) => process.stderr.write(data),
	};

	const result: AgentResult = {
		sessionId: input.resume ?? '',
		resultText: '',
		totalCostUsd: 0,
		inputTokens: 0,
		outputTokens: 0,
		isError: false,
		subtype: '',
	};

	for await (const message of queryFn({ prompt: input.prompt, options })) {
		// SDK が aiColle のツールに繋げなかったら止める（ツールが無いと人に質問も成果物の登録もできない）
		if (message.type === 'system' && message.subtype === 'init') {
			const status = message.mcp_servers?.find((server) => server.name === 'aicolle')?.status;
			if (status && status !== 'connected') {
				abortController.abort();
				throw new Error(`aiColle のツールに繋がりませんでした（${status}）`);
			}
		}

		if ('session_id' in message && typeof message.session_id === 'string' && message.session_id) {
			result.sessionId = message.session_id;
		}

		if (message.type === 'assistant') {
			for (const block of message.message.content) {
				if (block.type === 'tool_use') {
					client.event('tool', describeTool(block.name, block.input), { tool: block.name });
				}
			}
		}

		if (message.type === 'result') {
			result.totalCostUsd = message.total_cost_usd ?? 0;
			result.inputTokens = (message.usage?.input_tokens ?? 0) + (message.usage?.cache_read_input_tokens ?? 0)
				+ (message.usage?.cache_creation_input_tokens ?? 0);
			result.outputTokens = message.usage?.output_tokens ?? 0;
			result.isError = message.is_error;
			result.subtype = message.subtype;
			result.resultText = message.subtype === 'success' ? message.result : '';
		}
	}

	return result;
}

/** 道具の呼び出しを人が読める1行にする */
export function describeTool(name: string, input: unknown): string {
	const args = (input ?? {}) as Record<string, unknown>;
	const pick = (key: string) => (typeof args[key] === 'string' ? String(args[key]) : '');
	switch (name) {
		case 'Bash':
			return `実行: ${pick('command').slice(0, 200)}`;
		case 'Read':
			return `読む: ${pick('file_path')}`;
		case 'Write':
			return `書く: ${pick('file_path')}`;
		case 'Edit':
		case 'MultiEdit':
			return `直す: ${pick('file_path')}`;
		case 'Grep':
		case 'Glob':
			return `探す: ${pick('pattern')}`;
		default:
			return name.startsWith('mcp__aicolle__') ? `aiColle: ${name.slice('mcp__aicolle__'.length)}` : name;
	}
}
