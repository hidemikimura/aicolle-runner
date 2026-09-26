import { appendFile } from 'node:fs/promises';
import { AicolleClient } from './client.js';
import { execute, type Deps } from './main.js';
import type { QueryFn } from './agent.js';
import type { FinishBody, RunSpec } from './spec.js';

/**
 * GitHub Actions のジョブとして動く入口（docs/design/github-actions-runner.md）
 *
 * 1. GitHub の OIDC トークンを取る（aud = aiColle の URL）
 * 2. 合言葉と一緒に aiColle の /actions/claim に出して、中身（RunSpec）を受け取る
 * 3. 秘密をログに出さないよう ::add-mask:: する
 * 4. Claude API は aiColle の中継（/anthropic）を実行トークンで呼ぶ
 * 5. あとはサンドボックスと同じ execute
 */

/** claim が返す中身（RunSpec + Claude API の中継） */
export interface ClaimedSpec extends RunSpec {
	platform: string;
	anthropic: { base_url: string; token: string };
}

export interface ActionsInputs {
	runId: string;
	nonce: string;
	server: string;
}

/** 入力を読む（action.yml が環境変数で渡す） */
export function readInputs(env: NodeJS.ProcessEnv): ActionsInputs {
	const runId = (env.AICOLLE_RUN_ID ?? '').trim();
	const nonce = (env.AICOLLE_NONCE ?? '').trim();
	const server = (env.AICOLLE_SERVER ?? '').trim().replace(/\/+$/, '');
	if (!/^\d+$/.test(runId) || !nonce || !server) {
		throw new Error('run_id / nonce / server がありません（aiColle が起こしたジョブではありません）');
	}
	const url = new URL(server);
	if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
		throw new Error(`aiColle の URL は https にしてください: ${server}`);
	}
	return { runId, nonce, server };
}

/** GitHub の OIDC トークンを取る（ワークフローに permissions: id-token: write が要る） */
export async function requestIdToken(audience: string, env: NodeJS.ProcessEnv, fetchFn: typeof fetch = fetch): Promise<string> {
	const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
	const token = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
	if (!url || !token) {
		throw new Error('OIDC トークンを取れません。ワークフローの permissions に id-token: write を入れてください');
	}
	const response = await fetchFn(`${url}&audience=${encodeURIComponent(audience)}`, {
		headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		throw new Error(`OIDC トークンを取れませんでした（${response.status}）`);
	}
	const body = (await response.json()) as { value?: string };
	if (!body.value) {
		throw new Error('OIDC トークンが空でした');
	}
	return body.value;
}

/** 中身を受け取る */
export async function claim(inputs: ActionsInputs, idToken: string, fetchFn: typeof fetch = fetch): Promise<ClaimedSpec> {
	const response = await fetchFn(`${inputs.server}/actions/claim`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
		body: JSON.stringify({ run_id: inputs.runId, nonce: inputs.nonce, id_token: idToken }),
		signal: AbortSignal.timeout(60_000),
	});
	const text = await response.text();
	if (!response.ok) {
		let message = text.slice(0, 300);
		try {
			message = (JSON.parse(text) as { error?: string }).error ?? message;
		} catch {
			// JSON でなければそのまま
		}
		throw new Error(`aiColle から中身を受け取れませんでした（${response.status}）: ${message}`);
	}
	return (JSON.parse(text) as { spec: ClaimedSpec }).spec;
}

/** 秘密をログに出さないよう GitHub に伝える */
export function mask(values: (string | undefined)[], log: (line: string) => void = console.log): void {
	for (const value of values) {
		if (value) {
			log(`::add-mask::${value}`);
		}
	}
}

export interface ActionsDeps {
	env: NodeJS.ProcessEnv;
	queryFn: QueryFn;
	fetchFn?: typeof fetch;
	log?: (line: string) => void;
	pollMs?: number;
	workDir?: string;
}

/**
 * 受け取って、動かして、終わりを知らせる
 *
 * @returns 終わりに送ったもの
 */
export async function runInActions(deps: ActionsDeps): Promise<FinishBody> {
	const log = deps.log ?? console.log;
	const inputs = readInputs(deps.env);

	const idToken = await requestIdToken(inputs.server, deps.env, deps.fetchFn);
	mask([idToken], log);

	const spec = await claim(inputs, idToken, deps.fetchFn);
	mask([spec.callback.token, spec.github_token, spec.anthropic.token], log);
	log(`aiColle の実行 ${spec.run_id}（${spec.ticket.key}: ${spec.ticket.title}）を始めます`);

	// Claude API は aiColle の中継を通す。ジョブの環境にある別のキーは使わない
	deps.env.ANTHROPIC_BASE_URL = spec.anthropic.base_url;
	deps.env.ANTHROPIC_API_KEY = spec.anthropic.token;
	delete deps.env.ANTHROPIC_AUTH_TOKEN;

	const execDeps: Deps = { queryFn: deps.queryFn, fetchFn: deps.fetchFn, pollMs: deps.pollMs, workDir: deps.workDir };
	const body = await execute(spec, execDeps);

	await new AicolleClient(spec, deps.fetchFn).finish(body);
	log(`実行 ${spec.run_id}: ${body.status}${body.error ? `（${body.error}）` : ''}`);

	if (deps.env.GITHUB_STEP_SUMMARY) {
		const lines = [
			`### aiColle ${spec.ticket.key}: ${spec.ticket.title}`,
			'',
			`- 結果: ${body.status}${body.pr_number ? ` / PR #${body.pr_number}` : ''}`,
			body.error ? `- 理由: ${body.error}` : '',
		].filter(Boolean);
		await appendFile(deps.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n').catch(() => undefined);
	}

	return body;
}

async function main(): Promise<void> {
	const { query } = await import('@anthropic-ai/claude-agent-sdk');
	const body = await runInActions({ env: process.env, queryFn: query as unknown as QueryFn });
	// 失敗してもジョブは赤にしない（結果は aiColle に届いている）。受け取りの失敗は例外で赤になる
	if (body.status === 'failed') {
		console.log('::warning::AI の作業が失敗しました。理由は aiColle のチケットに出ています');
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
}
