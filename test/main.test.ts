import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execute } from '../src/main.js';
import { describeTool, type QueryFn } from '../src/agent.js';
import type { RunSpec } from '../src/spec.js';

/** サーバー（aiColle と GitHub の両方のふりをする） */
async function fakeServer(handlers: {
	state?: () => object;
	/** 提出前チェックの応答（既定は通る） */
	presubmit?: (body: any) => object;
	/** レビューの指摘を受けたときの応答（既定は直すべきもの無し） */
	review?: (body: any) => object;
	/** /runner/mcp の応答を差し替える（既定は jimble-mcp と同じ確かめ方をするふり） */
	mcp?: (req: IncomingMessage, body: any) => { status: number; value: object };
}) {
	const calls: { method: string; path: string; body: any }[] = [];
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		let raw = '';
		for await (const chunk of req) raw += chunk;
		const body = raw ? JSON.parse(raw) : undefined;
		calls.push({ method: req.method!, path: req.url!, body });
		const json = (value: object, status = 200) => {
			res.writeHead(status, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(value));
		};
		if (req.url === '/runner/mcp') {
			const { status, value } = (handlers.mcp ?? fakeMcp)(req, body);
			return json(value, status);
		}
		if (req.url!.endsWith('/presubmit')) return json(handlers.presubmit?.(body) ?? { problems: [], prompt: '', pr_note: '' });
		if (req.url!.endsWith('/review')) return json(handlers.review?.(body) ?? { must: 0, prompt: '', pr_note: '' });
		if (req.url!.endsWith('/state')) return json(handlers.state?.() ?? { status: 'running', cancel_requested: false, pending_questions: 0, answers: [] });
		if (req.url!.startsWith('/repos/') && req.method === 'GET') return json([] as unknown as object);
		if (req.url!.startsWith('/repos/') && req.method === 'POST') return json({ number: 42 }, 201);
		return json({ result: 'ok' });
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as AddressInfo).port;
	return { calls, base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** aiColle の MCP のふり（2026-07-28 版。jimble-mcp と同じくヘッダと本文を突き合わせる） */
function fakeMcp(req: IncomingMessage, body: any): { status: number; value: object } {
	const error = (message: string) => ({ status: 400, value: { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32001, message } } });
	if (req.headers.authorization !== 'Bearer 7.secret') return { status: 401, value: { error: 'unauthorized' } };
	if (req.headers['mcp-protocol-version'] !== '2026-07-28') return error('MCP-Protocol-Version ヘッダがありません');
	if (body.params?._meta?.['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28') return error('プロトコルの版がありません');
	if (req.headers['mcp-method'] !== body.method) return error('Mcp-Method ヘッダが本文と一致しません');
	const ok = (result: object) => ({ status: 200, value: { jsonrpc: '2.0', id: body.id, result: { resultType: 'complete', ...result } } });
	switch (body.method) {
		case 'tools/list':
			return ok({
				tools: [
					{ name: 'get_ticket', description: 'チケットを読む', inputSchema: { type: 'object', properties: {} } },
					{ name: 'save_artifact', description: '成果物を登録する', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
				],
			});
		case 'tools/call':
			if (req.headers['mcp-name'] !== body.params.name) return error('Mcp-Name ヘッダが本文と一致しません');
			return ok({ content: [{ type: 'text', text: `${body.params.name} ${JSON.stringify(body.params.arguments)}` }] });
		default:
			return { status: 404, value: { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: '知らないメソッドです' } } };
	}
}

/** 取り出せる origin（bare リポジトリに main を1つ置いたもの） */
function origin(): string {
	const root = mkdtempSync(join(tmpdir(), 'runner-test-'));
	const bare = join(root, 'origin.git');
	const work = join(root, 'seed');
	execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
	execFileSync('git', ['init', '-b', 'main', work]);
	writeFileSync(join(work, 'README.md'), '# sample\n');
	const git = (...args: string[]) => execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
	git('add', '-A');
	git('commit', '-m', 'init');
	git('remote', 'add', 'origin', bare);
	git('push', 'origin', 'main');
	return bare;
}

function spec(base: string, cloneUrl: string, extra: Partial<RunSpec> = {}): RunSpec {
	return {
		run_id: 7,
		attempt: 1,
		target_level: 'develop',
		instructions: '',
		prompt: 'やって',
		resume: {},
		ticket: { id: 1, key: 'PM-1', title: 'ログイン画面' },
		repository: {
			owner: 'ecx',
			repo: 'sample',
			default_branch: 'main',
			branch: 'aicolle/PM-1',
			docs_root: 'docs',
			clone_url: cloneUrl,
			api_base_url: base,
		},
		github_token: 'dummy-token',
		callback: { base_url: base, token: '7.secret' },
		mcp: { url: `${base}/runner/mcp` },
		ai: { model: '', max_budget_usd: null, max_test_retries: 3, time_limit_minutes: 0, test_command: '' },
		question_wait_seconds: 1,
		...extra,
	};
}

/** エージェントのふり：cwd にファイルを書いて、結果を返す */
function fakeQuery(prompts: { prompt: string; resume?: string }[], cost = 0.1): QueryFn {
	return async function* ({ prompt, options }) {
		prompts.push({ prompt, resume: options?.resume });
		writeFileSync(join(options!.cwd!, `note-${prompts.length}.md`), prompt);
		yield {
			type: 'assistant',
			session_id: 'sess-1',
			message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'note.md' } }] },
		} as unknown as SDKMessage;
		yield {
			type: 'result',
			subtype: 'success',
			is_error: false,
			result: `まとめ ${prompts.length}`,
			session_id: 'sess-1',
			total_cost_usd: cost * prompts.length,
			usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		} as unknown as SDKMessage;
	};
}

test('変更をコミットして push し、PR を作って succeeded を返す', async () => {
	const server = await fakeServer({});
	const bare = origin();
	const prompts: { prompt: string; resume?: string }[] = [];

	const body = await execute(spec(server.base, bare), { queryFn: fakeQuery(prompts), pollMs: 50 });

	assert.equal(body.status, 'succeeded');
	assert.equal(body.pr_number, 42);
	assert.equal(body.session_id, 'sess-1');
	assert.equal(body.summary, 'まとめ 1');
	assert.ok(Math.abs(body.usage!.cost_usd - 0.1) < 1e-9);

	// origin にブランチが push されている
	const log = execFileSync('git', ['--git-dir', bare, 'log', '--oneline', 'aicolle/PM-1']).toString();
	assert.match(log, /PM-1: ログイン画面/);

	// 出来事が送られている（道具の呼び出しと PR）
	const events = server.calls.filter((c) => c.path.endsWith('/events')).flatMap((c) => c.body.events);
	assert.ok(events.some((e: any) => e.kind === 'tool' && e.message === '書く: note.md'));
	assert.ok(events.some((e: any) => e.kind === 'pr'));

	// PR は既定ブランチ宛て
	const pr = server.calls.find((c) => c.method === 'POST' && c.path === '/repos/ecx/sample/pulls');
	assert.equal(pr!.body.base, 'main');
	assert.equal(pr!.body.head, 'aicolle/PM-1');

	server.close();
});

test('待っているあいだに回答が来たら、同じセッションを resume して続ける', async () => {
	let polls = 0;
	// 本物のサーバーと同じく、ack されるまで同じ回答を返し続ける
	const acked = () => server.calls.some((c) => c.path === '/runner/runs/7/answers/ack');
	const server = await fakeServer({
		state: () => {
			polls++;
			if (polls <= 2) return { status: 'running', cancel_requested: false, pending_questions: 1, answers: [] };
			const answers = acked() ? [] : [{ question_id: 1, question: '方式は？', answer: 'メール' }];
			return { status: 'running', cancel_requested: false, pending_questions: 0, answers };
		},
	});
	const prompts: { prompt: string; resume?: string }[] = [];

	const body = await execute(spec(server.base, origin(), { question_wait_seconds: 5 }), { queryFn: fakeQuery(prompts), pollMs: 50 });

	assert.equal(body.status, 'succeeded');
	assert.equal(prompts.length, 2);
	assert.equal(prompts[1].resume, 'sess-1');
	assert.match(prompts[1].prompt, /回答: メール/);
	// 同じ回答を二重に渡さない・渡したら ack する
	assert.equal(prompts[1].prompt.match(/回答: メール/g)!.length, 1);
	assert.deepEqual(server.calls.find((c) => c.path === '/runner/runs/7/answers/ack')!.body, { question_ids: [1] });
	// 原価は累計の最後（0.2）。前回までの分は差し引く（ここでは 0）
	assert.ok(Math.abs(body.usage!.cost_usd - 0.2) < 1e-9);

	server.close();
});

test('回答が来なければ WIP を push して waiting_answer で止まる', async () => {
	const server = await fakeServer({
		state: () => ({ status: 'running', cancel_requested: false, pending_questions: 1, answers: [] }),
	});
	const bare = origin();

	const body = await execute(spec(server.base, bare, { question_wait_seconds: 0.2 }), { queryFn: fakeQuery([]), pollMs: 50 });

	assert.equal(body.status, 'waiting_answer');
	assert.equal(body.session_id, 'sess-1');
	const log = execFileSync('git', ['--git-dir', bare, 'log', '--oneline', 'aicolle/PM-1']).toString();
	assert.match(log, /作業中（回答待ち）/);

	server.close();
});

test('再開のときは回答を渡して resume し、前回までの原価を差し引く', async () => {
	const server = await fakeServer({});
	const prompts: { prompt: string; resume?: string }[] = [];

	const body = await execute(
		spec(server.base, origin(), { attempt: 2, resume: { session_id: 'sess-1', prompt: '回答: GitHub', previous_cost_usd: 0.05 } }),
		{ queryFn: fakeQuery(prompts), pollMs: 50 },
	);

	assert.equal(body.status, 'succeeded');
	assert.equal(prompts[0].resume, 'sess-1');
	assert.equal(prompts[0].prompt, '回答: GitHub');
	assert.ok(Math.abs(body.usage!.cost_usd - 0.05) < 1e-9);

	server.close();
});

test('エージェントが予算の上限で止まったら failed', async () => {
	const server = await fakeServer({});
	const queryFn: QueryFn = async function* () {
		yield { type: 'result', subtype: 'error_max_budget_usd', is_error: true, session_id: 's', total_cost_usd: 1, usage: {} } as unknown as SDKMessage;
	};

	const body = await execute(spec(server.base, origin()), { queryFn, pollMs: 50 });

	assert.equal(body.status, 'failed');
	assert.equal(body.error, '予算の上限に達しました');

	server.close();
});

test('道具の呼び出しを1行にする', () => {
	assert.equal(describeTool('Bash', { command: './gradlew test' }), '実行: ./gradlew test');
	assert.equal(describeTool('mcp__aicolle__ask_question', {}), 'aiColle: ask_question');
});

test('git のエラーの文にトークンを出さない', async () => {
	const { Git } = await import('../src/git.js');
	const s = spec('http://127.0.0.1:1', 'http://127.0.0.1:1/none.git', { github_token: 'ghs_SECRET123' });
	const git = new Git(join(mkdtempSync(join(tmpdir(), 'runner-git-')), 'repo'), s);
	await assert.rejects(git.prepare(), (error: Error) => {
		assert.doesNotMatch(error.message, /ghs_SECRET123/);
		assert.doesNotMatch(error.message, new RegExp(Buffer.from('x-access-token:ghs_SECRET123').toString('base64')));
		return true;
	});
	assert.equal(git.redact('token ghs_SECRET123 here'), 'token *** here');
});

test('aiColle のツールは橋渡しを通して SDK に渡り、呼び出しは 2026-07-28 版で aiColle に届く', async () => {
	const server = await fakeServer({});
	const seen: { tools: string[]; call: string } = { tools: [], call: '' };

	const queryFn: QueryFn = async function* ({ options }) {
		const config = options!.mcpServers!.aicolle as { type: string; instance: any };
		assert.equal(config.type, 'sdk');

		// SDK の代わりに MCP のクライアントで繋ぐ（SDK が中でしているのと同じ）
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		await config.instance.connect(serverSide);
		const mcp = new Client({ name: 'test', version: '1' });
		await mcp.connect(clientSide);
		seen.tools = (await mcp.listTools()).tools.map((t) => t.name);
		const result = await mcp.callTool({ name: 'save_artifact', arguments: { title: '要件' } });
		seen.call = (result.content as { text: string }[])[0].text;
		await mcp.close();

		yield { type: 'system', subtype: 'init', session_id: 's', mcp_servers: [{ name: 'aicolle', status: 'connected' }] } as unknown as SDKMessage;
		yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', total_cost_usd: 0, usage: {} } as unknown as SDKMessage;
	};

	const body = await execute(spec(server.base, origin()), { queryFn, pollMs: 50 });

	assert.equal(body.status, 'succeeded', body.error);
	assert.deepEqual(seen.tools, ['get_ticket', 'save_artifact']);
	assert.equal(seen.call, 'save_artifact {"title":"要件"}');

	server.close();
});

test('aiColle のツールの一覧を取れなければ、エージェントを動かさずに failed', async () => {
	const server = await fakeServer({
		mcp: (_req, body) => ({ status: 400, value: { jsonrpc: '2.0', id: body.id, error: { code: -32001, message: 'ヘッダがありません' } } }),
	});
	let started = false;
	const queryFn: QueryFn = async function* () {
		started = true;
		yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', total_cost_usd: 0, usage: {} } as unknown as SDKMessage;
	};

	const body = await execute(spec(server.base, origin()), { queryFn, pollMs: 50 });

	assert.equal(body.status, 'failed');
	assert.match(body.error!, /aiColle の MCP（tools\/list）: ヘッダがありません/);
	assert.equal(started, false);

	server.close();
});

test('SDK が aiColle のツールに繋げなかったら failed', async () => {
	const server = await fakeServer({});
	const queryFn: QueryFn = async function* () {
		yield { type: 'system', subtype: 'init', session_id: 's', mcp_servers: [{ name: 'aicolle', status: 'failed' }] } as unknown as SDKMessage;
		yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', total_cost_usd: 0, usage: {} } as unknown as SDKMessage;
	};

	const body = await execute(spec(server.base, origin()), { queryFn, pollMs: 50 });

	assert.equal(body.status, 'failed');
	assert.match(body.error!, /aiColle のツールに繋がりませんでした（failed）/);

	server.close();
});

test('回答の出た判断依頼は docs/decisions/{キー}.md に書いて、同じ PR に入れる', async () => {
	const server = await fakeServer({});
	const bare = origin();

	const body = await execute(
		spec(server.base, bare, {
			decisions: [{
				question: 'ログインの方式は\nどちらにしますか？',
				options: ['メール＋パスワード', 'GitHub OAuth'],
				recommended: 'メール＋パスワード',
				reason: 'Phase 0 の要件どおり',
				answer: 'GitHub OAuth',
				answered_at: '2026-09-26T01:02:03Z',
			}],
		}),
		{ queryFn: fakeQuery([]), pollMs: 50 },
	);

	assert.equal(body.status, 'succeeded');
	const file = execFileSync('git', ['--git-dir', bare, 'show', 'aicolle/PM-1:docs/decisions/PM-1.md']).toString();
	assert.match(file, /^---\nid: decision-PM-1\nkind: decision\nsource_tickets: \[PM-1\]\n---/);
	assert.match(file, /## ログインの方式は どちらにしますか？/);
	assert.match(file, /- 決まったこと: \*\*GitHub OAuth\*\*（2026-09-26）/);
	assert.match(file, /- AI の推奨: メール＋パスワード — Phase 0 の要件どおり/);

	const events = server.calls.filter((c) => c.path.endsWith('/events')).flatMap((c) => c.body.events);
	assert.ok(events.some((e: any) => e.message === '決まったことを docs/decisions/PM-1.md に書きました'));

	server.close();
});

test('回答が無ければ決定記録は作らない', async () => {
	const server = await fakeServer({});
	const bare = origin();

	await execute(spec(server.base, bare), { queryFn: fakeQuery([]), pollMs: 50 });

	const tree = execFileSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'aicolle/PM-1']).toString();
	assert.ok(!tree.includes('docs/decisions/'));

	server.close();
});

test('エージェントには「人に向けて書くものは日本語」を毎回（再開のときも）伝える', async () => {
	const server = await fakeServer({});
	const appends: string[] = [];
	const queryFn: QueryFn = async function* ({ options }) {
		appends.push((options!.systemPrompt as { append: string }).append);
		yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', total_cost_usd: 0, usage: {} } as unknown as SDKMessage;
	};

	await execute(spec(server.base, origin(), { attempt: 2, resume: { session_id: 's', prompt: '回答: A' } }), { queryFn, pollMs: 50 });

	assert.equal(appends.length, 1);
	assert.match(appends[0], /必ず日本語で書く/);

	server.close();
});

test('乖離の見回り（audit）はファイルを書き換える道具を渡さず、コミットも push も PR もしない', async () => {
	const server = await fakeServer({});
	const bare = origin();
	const prompts: { prompt: string; resume?: string }[] = [];
	const options: { disallowed?: string[]; append?: string }[] = [];
	const inner = fakeQuery(prompts);
	const queryFn: QueryFn = (params) => {
		options.push({
			disallowed: params.options?.disallowedTools,
			append: (params.options?.systemPrompt as { append: string }).append,
		});
		return inner(params);
	};

	const body = await execute(spec(server.base, bare, { target_level: 'audit' }), { queryFn, pollMs: 50 });

	assert.equal(body.status, 'succeeded');
	assert.equal(body.pr_number, undefined);
	assert.equal(body.summary, 'まとめ 1');
	assert.deepEqual(options[0].disallowed, ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
	assert.match(options[0].append!, /report_drift/);

	// エージェントがファイルを書いても（偽のエージェントは書く）、ブランチは push されない・PR も作らない
	assert.throws(() => execFileSync('git', ['--git-dir', bare, 'rev-parse', '--verify', 'aicolle/PM-1'], { stdio: 'pipe' }));
	assert.equal(server.calls.filter((c) => c.path === '/repos/ecx/sample/pulls').length, 0);

	server.close();
});

test('最初からやり直す（restart_from = goal）と、ブランチを既定ブランチから作り直して上書きする', async (t) => {
	const server = await fakeServer({});
	t.after(() => server.close());
	const bare = origin();

	const first = await execute(spec(server.base, bare), { queryFn: fakeQuery([]), pollMs: 50 });
	assert.equal(first.status, 'succeeded');
	const old = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'aicolle/PM-1']).toString().trim();

	const events: string[] = [];
	const body = await execute(spec(server.base, bare, { restart_from: 'goal', prompt: '最初からやり直して' }), { queryFn: fakeQuery([]), pollMs: 50 });
	assert.equal(body.status, 'succeeded');
	server.calls.filter((c) => c.path.endsWith('/events')).flatMap((c) => c.body.events).forEach((e: any) => events.push(e.message));
	assert.ok(events.some((m) => m.includes('既定ブランチから作り直しました')), events.join('\n'));

	// 新しいブランチは既定ブランチから1コミットだけ。前のコミットは残っていない
	const now = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'aicolle/PM-1']).toString().trim();
	assert.notEqual(now, old);
	const ahead = execFileSync('git', ['--git-dir', bare, 'rev-list', '--count', 'main..aicolle/PM-1']).toString().trim();
	assert.equal(ahead, '1');
	assert.throws(() => execFileSync('git', ['--git-dir', bare, 'merge-base', '--is-ancestor', old, now], { stdio: 'pipe' }));

	// 続きから（restart_from 無し）なら前のコミットの上に積む
	await execute(spec(server.base, bare), { queryFn: fakeQuery([]), pollMs: 50 });
	const next = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'aicolle/PM-1']).toString().trim();
	execFileSync('git', ['--git-dir', bare, 'merge-base', '--is-ancestor', now, next]);
});

const docsProblem = { key: 'docs', label: 'docs の直し漏れ', message: 'docs を直していません', files: ['src/A.java'] };

test('提出前チェックで見つかれば、同じセッションで直させて push し直し、通れば PR の本文には何も足さない', async () => {
	let checks = 0;
	const server = await fakeServer({
		presubmit: () => (++checks === 1 ? { problems: [docsProblem], prompt: '直して: docs', pr_note: '### 残ったもの' } : { problems: [], prompt: '', pr_note: '' }),
	});
	const bare = origin();
	const prompts: { prompt: string; resume?: string }[] = [];

	const body = await execute(spec(server.base, bare, { ai: { ...spec('', '').ai, presubmit: true, presubmit_retries: 1 } }), { queryFn: fakeQuery(prompts), pollMs: 50 });

	assert.equal(body.status, 'succeeded');
	assert.equal(checks, 2);
	assert.equal(prompts.length, 2);
	assert.equal(prompts[1].prompt, '直して: docs');
	assert.equal(prompts[1].resume, 'sess-1');
	// 直したあとのまとめが PR の本文になり、直したコミットも push されている
	assert.equal(body.summary, 'まとめ 2');
	const pr = server.calls.find((c) => c.method === 'POST' && c.path === '/repos/ecx/sample/pulls');
	assert.match(pr!.body.body, /^まとめ 2/);
	assert.doesNotMatch(pr!.body.body, /残ったもの/);
	const log = execFileSync('git', ['--git-dir', bare, 'log', '--oneline', 'aicolle/PM-1']).toString();
	assert.match(log, /提出前チェックで見つかったものを直す/);
	// 最初のチェックにはエージェントのまとめを渡す
	assert.equal(server.calls.find((c) => c.path.endsWith('/presubmit'))!.body.summary, 'まとめ 1');

	server.close();
});

test('直す回数を使い切ったら、残ったものを PR の本文に書く。チェックを頼まない古いサーバーでは呼ばない', async () => {
	const server = await fakeServer({ presubmit: () => ({ problems: [docsProblem], prompt: '直して', pr_note: '### 提出前チェックで残ったもの' }) });
	const prompts: { prompt: string; resume?: string }[] = [];

	const body = await execute(spec(server.base, origin(), { ai: { ...spec('', '').ai, presubmit: true, presubmit_retries: 0 } }), { queryFn: fakeQuery(prompts), pollMs: 50 });

	assert.equal(body.status, 'succeeded');
	assert.equal(prompts.length, 1);
	const pr = server.calls.find((c) => c.method === 'POST' && c.path === '/repos/ecx/sample/pulls');
	assert.match(pr!.body.body, /### 提出前チェックで残ったもの\n---/);
	server.close();

	// presubmit を送らない（古い）サーバーでは呼ばない
	const old = await fakeServer({});
	await execute(spec(old.base, origin()), { queryFn: fakeQuery([]), pollMs: 50 });
	assert.ok(!old.calls.some((c) => c.path.endsWith('/presubmit')));
	old.close();
});

/** 作業する側は fakeQuery、レビュー役（書き換える道具を持たない）は reviews の順に返す */
function withReviewer(prompts: { prompt: string; resume?: string }[], reviews: string[], seen: { prompt: string; options: any }[]): QueryFn {
	const work = fakeQuery(prompts);
	return async function* (params) {
		if (params.options?.disallowedTools?.includes('Write')) {
			seen.push({ prompt: params.prompt, options: params.options });
			yield {
				type: 'assistant',
				session_id: `review-${seen.length}`,
				message: { content: [{ type: 'tool_use', id: 'r1', name: 'Bash', input: { command: 'git diff origin/main...HEAD' } }] },
			} as unknown as SDKMessage;
			yield {
				type: 'result',
				subtype: 'success',
				is_error: false,
				result: reviews[seen.length - 1] ?? '',
				session_id: `review-${seen.length}`,
				total_cost_usd: 0.05,
				usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			} as unknown as SDKMessage;
			return;
		}
		yield* work(params);
	};
}

test('レビュー役の AI: 別のセッションでレビューし、直すべきものは作業したセッションに直させて、もう一度レビューする', async () => {
	const reviews: any[] = [];
	const server = await fakeServer({
		review: (body) => {
			reviews.push(body);
			return body.round === 1
				? { must: 1, prompt: '直して: レビュー', pr_note: '### AI のレビュー（1 回）' }
				: { must: 0, prompt: '', pr_note: '### AI のレビュー（別のセッション・2 回）\n\n指摘はありませんでした。' };
		},
	});
	const bare = origin();
	const prompts: { prompt: string; resume?: string }[] = [];
	const seen: { prompt: string; options: any }[] = [];
	const first = '所感です。\n\n```json\n{"findings": [{"severity": "must", "title": "空のとき落ちる", "detail": "null を見ていない", "file": "src/A.java", "line": 3}, {"severity": "nit", "title": "名前"}]}\n```';
	const second = '```json\n{"findings": []}\n```';

	const body = await execute(
		spec(server.base, bare, { ai: { ...spec('', '').ai, max_budget_usd: 5, review: { prompt: 'レビューして', retries: 1 } } }),
		{ queryFn: withReviewer(prompts, [first, second], seen), pollMs: 50 },
	);

	assert.equal(body.status, 'succeeded');
	// レビュー役は新しいセッション（resume 無し）・書き換える道具と aiColle のツールを持たない
	assert.equal(seen.length, 2);
	assert.equal(seen[0].prompt, 'レビューして');
	assert.equal(seen[0].options.resume, undefined);
	assert.equal(seen[0].options.mcpServers, undefined);
	assert.deepEqual(seen[0].options.disallowedTools, ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
	assert.equal(seen[0].options.env.AICOLLE_AGENT, 'runner');
	// 直すのは作業したセッション
	assert.equal(prompts.length, 2);
	assert.equal(prompts[1].prompt, '直して: レビュー');
	assert.equal(prompts[1].resume, 'sess-1');
	// 送った指摘
	assert.equal(reviews.length, 2);
	assert.equal(reviews[0].round, 1);
	assert.equal(reviews[0].fixed_earlier, 0);
	assert.deepEqual(reviews[0].findings.map((f: any) => [f.severity, f.title, f.file, f.line]), [['must', '空のとき落ちる', 'src/A.java', 3], ['nit', '名前', '', 0]]);
	assert.equal(reviews[1].round, 2);
	assert.equal(reviews[1].fixed_earlier, 1);
	// PR の本文には最後のレビューの節。直したコミットも push されている
	const pr = server.calls.find((c) => c.method === 'POST' && c.path === '/repos/ecx/sample/pulls');
	assert.match(pr!.body.body, /^まとめ 2\n\n### AI のレビュー（別のセッション・2 回）\n\n指摘はありませんでした。\n---/);
	const log = execFileSync('git', ['--git-dir', bare, 'log', '--oneline', 'aicolle/PM-1']).toString();
	assert.match(log, /レビューで直すべきと言われたものを直す/);
	// レビュー役の道具は「実行: 」で始めない（テストを流した記録にしない）。原価は足す
	const tools = server.calls.filter((c) => c.path.endsWith('/events')).flatMap((c) => c.body.events ?? [c.body]).filter((e: any) => e.kind === 'tool');
	assert.ok(tools.some((e: any) => e.message === 'レビュー: 実行: git diff origin/main...HEAD'), JSON.stringify(tools));
	assert.ok(Math.abs(body.usage!.cost_usd - (0.2 + 0.1)) < 1e-9, String(body.usage!.cost_usd));
	server.close();
});

test('レビュー役の返事を読めなければ、レビューなしで PR を作る。設定が無ければレビューしない', async () => {
	const server = await fakeServer({});
	const seen: { prompt: string; options: any }[] = [];
	const body = await execute(
		spec(server.base, origin(), { ai: { ...spec('', '').ai, review: { prompt: 'レビューして', retries: 1 } } }),
		{ queryFn: withReviewer([], ['よさそうです'], seen), pollMs: 50 },
	);
	assert.equal(body.status, 'succeeded');
	assert.equal(seen.length, 1);
	assert.ok(!server.calls.some((c) => c.path.endsWith('/review')));
	const pr = server.calls.find((c) => c.method === 'POST' && c.path === '/repos/ecx/sample/pulls');
	assert.doesNotMatch(pr!.body.body, /AI のレビュー/);
	server.close();

	const off = await fakeServer({});
	const none: { prompt: string; options: any }[] = [];
	await execute(spec(off.base, origin()), { queryFn: withReviewer([], [], none), pollMs: 50 });
	assert.equal(none.length, 0);
	off.close();
});

test('完了の条件の対応表: 提出前チェックが返した表を、通っても PR の本文の最初に足す', async () => {
	const table = '### 完了の条件の対応表\n\n| # | 完了の条件 | 確かめたもの |\n| --- | --- | --- |\n| 1 | 空で 422 | `LoginTest` |';
	const server = await fakeServer({ presubmit: () => ({ problems: [], prompt: '', pr_note: '', conditions_note: table }) });
	const body = await execute(spec(server.base, origin(), { ai: { ...spec('', '').ai, presubmit: true, presubmit_retries: 1 } }), { queryFn: fakeQuery([]), pollMs: 50 });
	assert.equal(body.status, 'succeeded');
	const pr = server.calls.find((c) => c.method === 'POST' && c.path === '/repos/ecx/sample/pulls');
	assert.match(pr!.body.body, /^まとめ 1\n\n### 完了の条件の対応表\n\n\| # \| 完了の条件 \| 確かめたもの \|[\s\S]*\| 1 \| 空で 422 \| `LoginTest` \|\n---/);
	server.close();
});
