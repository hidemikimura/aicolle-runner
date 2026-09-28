import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AicolleClient, type RunState } from './client.js';
import { runAgent, type AgentResult, type QueryFn } from './agent.js';
import { parseFindings } from './review.js';
import { Git } from './git.js';
import { ensurePullRequest } from './github.js';
import { writeDecisions } from './decisions.js';
import type { Decision, FinishBody, RunSpec } from './spec.js';

/** 差し替えられる部品（テスト用） */
export interface Deps {
	queryFn: QueryFn;
	fetchFn?: typeof fetch;
	workDir?: string;
	/** 待つ間隔（ミリ秒） */
	pollMs?: number;
}

/**
 * 1回の起動（docs/design/ai-run.md）
 *
 * 1. リポジトリを取ってブランチに切り替える
 * 2. エージェントを動かす（再開なら回答を渡して resume）
 * 3. 質問が残っていれば question_wait だけ待つ。回答が来たら resume、来なければ WIP を push して waiting_answer
 * 4. 変更をコミットして push する
 * 5. レビュー役の AI（設定でオンのとき）。別のセッションで差分をレビューし、直すべきものは review.retries 回まで直させて push し直す
 * 6. 提出前チェック（aiColle が GitHub のブランチを見る）。見つかれば presubmit_retries 回までエージェントに直させて push し直す
 * 7. PR を作って succeeded（レビューの指摘・直しきれなかったものは PR の本文に書く）
 */
export async function execute(spec: RunSpec, deps: Deps): Promise<FinishBody> {
	const startedAt = Date.now();
	const client = new AicolleClient(spec, deps.fetchFn);
	const abort = new AbortController();
	const pollMs = deps.pollMs ?? 5000;
	let abortReason: 'cancelled' | 'time_limit' | null = null;

	const elapsed = () => Math.round((Date.now() - startedAt) / 1000);
	const baselineCost = spec.resume?.previous_cost_usd ?? 0;
	let last: AgentResult | null = null;
	const received: Decision[] = [];

	// レビュー役（別のセッション）の分。作業したセッションの累計には入らないので足す
	const reviewer = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
	const usage = () => ({
		input_tokens: (last?.inputTokens ?? 0) + reviewer.inputTokens,
		output_tokens: (last?.outputTokens ?? 0) + reviewer.outputTokens,
		cost_usd: Math.max(0, (last?.totalCostUsd ?? 0) - baselineCost) + reviewer.costUsd,
	});

	// レビュー役に使ってよい原価（予算の上限があれば、その残り）
	const reviewBudget = () => (spec.ai.max_budget_usd == null ? null : Math.max(0, spec.ai.max_budget_usd - usage().cost_usd));

	// 中断の指示を見張る
	const watcher = setInterval(() => {
		client
			.state()
			.then((state) => {
				if (state.cancel_requested && !abort.signal.aborted) {
					abortReason = 'cancelled';
					abort.abort();
				}
			})
			.catch(() => undefined);
	}, Math.max(pollMs * 2, 1000));

	const timeLimit =
		spec.ai.time_limit_minutes > 0
			? setTimeout(() => {
					abortReason = 'time_limit';
					abort.abort();
				}, spec.ai.time_limit_minutes * 60_000)
			: null;

	try {
		const dir = deps.workDir ?? (await mkdtemp(join(tmpdir(), `aicolle-${spec.run_id}-`)));
		const repoDir = join(dir, 'repo');
		const git = new Git(repoDir, spec);

		const how = await git.prepare();
		client.event(
			'log',
			how === 'resumed'
				? `ブランチ ${spec.repository.branch} の続きから始めます`
				: how === 'recreated'
					? `最初からやり直すので、ブランチ ${spec.repository.branch} を既定ブランチから作り直しました`
					: `ブランチ ${spec.repository.branch} を作りました`,
		);

		let input = spec.resume?.session_id
			? { prompt: spec.resume.prompt ?? '続けてください', resume: spec.resume.session_id }
			: { prompt: spec.prompt };

		for (;;) {
			last = await runAgent(spec, client, repoDir, input, deps.queryFn, abort);

			if (abort.signal.aborted) {
				break;
			}

			if (last.isError) {
				await client.flush();
				return finishBody(spec, 'failed', last, usage, elapsed, {
					error: last.subtype === 'error_max_budget_usd' ? '予算の上限に達しました' : `エージェントが失敗しました（${last.subtype}）`,
				});
			}

			const state = await client.state();
			if (state.pending_questions === 0 && state.answers.length === 0) {
				break;
			}

			// 回答を待つ（サンドボックスは起こしたまま）。/state は ack するまで同じ回答を返すので question_id で束ねる
			const answers = new Map<number, RunState['answers'][number]>();
			const collect = (list: RunState['answers']) => list.forEach((a) => answers.set(a.question_id, a));
			collect(state.answers);
			let pending = state.pending_questions;
			const deadline = Date.now() + spec.question_wait_seconds * 1000;
			if (pending > 0) {
				client.event('log', `回答を待っています（最大 ${Math.round(spec.question_wait_seconds / 60)} 分）`);
			}
			while (pending > 0 && Date.now() < deadline && !abort.signal.aborted) {
				await sleep(pollMs);
				const current = await client.state();
				collect(current.answers);
				pending = current.pending_questions;
			}

			if (abort.signal.aborted) {
				break;
			}

			if (pending > 0 || answers.size === 0) {
				// 来なかった。作業中のものを残して止まる（届いた回答は ack しないので、次の起動で渡される）
				if (spec.github_token && spec.target_level !== 'audit') {
					await writeDecisionsWith(repoDir, spec, received);
				}
				if (spec.github_token && spec.target_level !== 'audit' && (await git.commitAll(`${spec.ticket.key}: 作業中（回答待ち）`))) {
					await git.push();
				}
				return finishBody(spec, 'waiting_answer', last, usage, elapsed);
			}

			await client.ackAnswers([...answers.keys()]);
			// この起動の中で受け取った回答も決定記録に入れる（spec.decisions は起動したときのもの）
			for (const a of answers.values()) {
				received.push({ question: a.question, answer: a.answer, options: [], recommended: '', reason: '', answered_at: new Date().toISOString() });
			}
			input = {
				prompt:
					'人から回答がありました。これを踏まえて作業を続けてください。\n' +
					[...answers.values()].map((a) => `\n- 質問: ${a.question}\n  回答: ${a.answer}`).join(''),
				resume: last.sessionId,
			};
			client.event('log', '回答を受け取ったので続けます');
		}

		if (abort.signal.aborted) {
			return finishBody(spec, abortReason === 'time_limit' ? 'failed' : 'cancelled', last, usage, elapsed, {
				error: abortReason === 'time_limit' ? `時間の上限（${spec.ai.time_limit_minutes} 分）に達しました` : undefined,
			});
		}

		// コミット・push・PR
		let summary = last?.resultText?.trim() || '作業が終わりました';
		let prNumber: number | undefined;

		// 乖離の見回りは読むだけ。変更があっても（テストの生成物など）コミットも push もしない
		if (spec.target_level === 'audit') {
			client.event('log', '見回りが終わりました（ファイルは変えていません）');
			return finishBody(spec, 'succeeded', last, usage, elapsed, { summary });
		}

		if (spec.github_token) {
			const written = await writeDecisionsWith(repoDir, spec, received);
			if (written) {
				client.event('log', `決まったことを ${written} に書きました`);
			}
			await git.commitAll(`${spec.ticket.key}: ${spec.ticket.title}`);
			if (git.needsOverwrite() && !(await git.hasCommitsAhead())) {
				// 最初からやり直して何も残らなかった: 古いコミットを消すために、既定ブランチの先頭で上書きする
				await git.push();
				client.event('log', '変更はありませんでした（ブランチを既定ブランチに戻しました）');
			} else if (await git.hasCommitsAhead()) {
				await git.push();
				const fix = (prompt: string) => runAgent(spec, client, repoDir, { prompt, resume: last?.sessionId }, deps.queryFn, abort);
				// レビュー役の AI（別のセッション）。直すべきものは作業したセッションに直させる（docs/design/ai-review.md）
				const reviewed = await review(spec, client, git, summary, fix
					, (prompt) => runAgent(spec, client, repoDir, { prompt }, deps.queryFn, abort, { kind: 'review', maxBudgetUsd: reviewBudget() })
					, reviewer, abort);
				if (reviewed.last) {
					last = reviewed.last;
				}
				summary = reviewed.summary;
				const checked = await presubmit(spec, client, git, summary, fix, abort);
				if (checked.last) {
					last = checked.last;
				}
				summary = checked.summary;
				const notes = [checked.conditions, reviewed.note, checked.note].filter((n) => n).map((n) => n.trimEnd() + '\n').join('\n');
				prNumber = await ensurePullRequest(
					spec,
					`${spec.ticket.key}: ${spec.ticket.title}`,
					`${summary}\n\n${notes}---\naiColle のチケット ${spec.ticket.key} から AI が作りました。`,
					deps.fetchFn,
				);
				client.event('pr', `PR #${prNumber} を作りました`, { pr_number: prNumber });
			} else {
				client.event('log', '変更はありませんでした');
			}
		}

		return finishBody(spec, 'succeeded', last, usage, elapsed, { summary, pr_number: prNumber });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return finishBody(spec, abortReason === 'cancelled' ? 'cancelled' : 'failed', last, usage, elapsed, { error: message });
	} finally {
		clearInterval(watcher);
		if (timeLimit) {
			clearTimeout(timeLimit);
		}
		await client.flush();
	}
}

/** 起動したときの回答と、この起動の中で受け取った回答を合わせて決定記録を書く（同じ質問は1つ） */
async function writeDecisionsWith(repoDir: string, spec: RunSpec, received: Decision[]): Promise<string | null> {
	const known = new Set((spec.decisions ?? []).map((d) => d.question));
	const decisions = [...(spec.decisions ?? []), ...received.filter((d) => !known.has(d.question))];
	return writeDecisions(repoDir, { ...spec, decisions });
}

/**
 * レビュー役の AI（docs/design/ai-review.md）
 *
 * 別のセッション（まっさらな文脈・ファイルを変えない）にチケットと差分だけを読ませて指摘を受け取り、aiColle に送る。
 * 直すべき（must）があれば review.retries 回まで作業したセッションに直させ、コミットして push し、新しいセッションでもう一度レビューする。
 * レビュー役が失敗した・返事を読めなかったときは止めずに進める（PR の本文にも書かない）。
 */
async function review(
	spec: RunSpec,
	client: AicolleClient,
	git: Git,
	summary: string,
	fix: (prompt: string) => Promise<AgentResult>,
	reviewAgent: (prompt: string) => Promise<AgentResult>,
	reviewer: { costUsd: number; inputTokens: number; outputTokens: number },
	abort: AbortController,
): Promise<{ summary: string; note: string; last: AgentResult | null }> {
	let current = summary;
	let last: AgentResult | null = null;
	const config = spec.ai.review;
	if (!config?.prompt) {
		return { summary: current, note: '', last };
	}
	const retries = Math.max(0, config.retries ?? 0);
	let note = '';
	let fixedEarlier = 0;
	for (let round = 1; ; round++) {
		if (abort.signal.aborted) {
			return { summary: current, note, last };
		}
		client.event('log', round === 1 ? '別のセッションで差分をレビューします' : `直したので、別のセッションでもう一度レビューします（${round} 回目）`);
		let result: AgentResult;
		try {
			result = await reviewAgent(config.prompt);
		} catch (error) {
			client.event('log', `レビュー役を動かせなかったので、レビューなしで進めます（${error instanceof Error ? error.message : String(error)}）`);
			return { summary: current, note, last };
		}
		reviewer.costUsd += result.totalCostUsd;
		reviewer.inputTokens += result.inputTokens;
		reviewer.outputTokens += result.outputTokens;
		if (abort.signal.aborted) {
			return { summary: current, note, last };
		}
		const findings = result.isError ? null : parseFindings(result.resultText);
		if (findings === null) {
			client.event('log', result.isError ? `レビュー役が失敗したので、レビューなしで進めます（${result.subtype}）` : 'レビュー役の返事を読めなかったので、レビューなしで進めます');
			return { summary: current, note, last };
		}
		let answer;
		try {
			answer = await client.review(round, findings, fixedEarlier);
		} catch (error) {
			client.event('log', `レビューの結果を送れなかったので、そのまま進めます（${error instanceof Error ? error.message : String(error)}）`);
			return { summary: current, note, last };
		}
		note = answer.pr_note;
		if (answer.must === 0 || round > retries) {
			client.event('log', answer.must === 0 ? 'レビューで直すべきものはありませんでした' : 'レビューで直すべきと言われて残ったものを PR の本文に書きます');
			return { summary: current, note, last };
		}
		client.event('log', `レビューで直すべきと言われた ${answer.must} 件を直します`);
		const fixed = await fix(answer.prompt);
		if (abort.signal.aborted || fixed.isError) {
			return { summary: current, note, last };
		}
		last = fixed;
		current = fixed.resultText?.trim() || current;
		fixedEarlier += answer.must;
		if (await git.commitAll(`${spec.ticket.key}: レビューで直すべきと言われたものを直す`)) {
			await git.push();
		}
	}
}

/**
 * 提出前チェック（docs/design/presubmit.md）
 *
 * aiColle が push したブランチを見て、docs の直し漏れ・まとめの言葉・決定記録・人が書いた段落・テストを確かめる。
 * 見つかれば presubmit_retries 回までエージェントに直させ（同じセッションで続ける）、コミットして push し直す。
 * チェックを呼べなかったときは止めずに PR を作る。
 */
async function presubmit(
	spec: RunSpec,
	client: AicolleClient,
	git: Git,
	summary: string,
	fix: (prompt: string) => Promise<AgentResult>,
	abort: AbortController,
): Promise<{ summary: string; note: string; conditions: string; last: AgentResult | null }> {
	let current = summary;
	let last: AgentResult | null = null;
	let conditions = '';
	if (!spec.ai.presubmit) {
		return { summary: current, note: '', conditions, last };
	}
	const retries = Math.max(0, spec.ai.presubmit_retries ?? 0);
	for (let attempt = 0; ; attempt++) {
		let result;
		try {
			result = await client.presubmit(current);
		} catch (error) {
			client.event('log', `提出前チェックを呼べなかったので、そのまま PR を作ります（${error instanceof Error ? error.message : String(error)}）`);
			return { summary: current, note: '', conditions, last };
		}
		conditions = result.conditions_note ?? '';
		if (result.problems.length === 0) {
			client.event('log', attempt === 0 ? '提出前チェックを通りました' : '直して、提出前チェックを通りました');
			return { summary: current, note: '', conditions, last };
		}
		if (attempt >= retries || abort.signal.aborted) {
			client.event('log', '提出前チェックで残ったものを PR の本文に書きます');
			return { summary: current, note: result.pr_note, conditions, last };
		}
		client.event('log', `提出前チェックで見つかったものを直します（${result.problems.map((p) => p.label).join('・')}）`);
		const fixed = await fix(result.prompt);
		if (abort.signal.aborted || fixed.isError) {
			return { summary: current, note: result.pr_note, conditions, last };
		}
		last = fixed;
		current = fixed.resultText?.trim() || current;
		if (await git.commitAll(`${spec.ticket.key}: 提出前チェックで見つかったものを直す`)) {
			await git.push();
		}
	}
}

function finishBody(
	spec: RunSpec,
	status: FinishBody['status'],
	last: AgentResult | null,
	usage: () => FinishBody['usage'],
	elapsed: () => number,
	extra: Partial<FinishBody> = {},
): FinishBody {
	return {
		status,
		session_id: last?.sessionId || spec.resume?.session_id || '',
		branch: spec.repository.branch,
		usage: usage(),
		sandbox_seconds: elapsed(),
		...extra,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 入口: node dist/src/main.js <spec.json> */
async function main(): Promise<void> {
	const path = process.argv[2];
	if (!path) {
		console.error('使い方: node dist/src/main.js <spec.json>');
		process.exit(2);
	}
	const spec = JSON.parse(await readFile(path, 'utf8')) as RunSpec;
	const { query } = await import('@anthropic-ai/claude-agent-sdk');
	const client = new AicolleClient(spec);

	const body = await execute(spec, { queryFn: query as unknown as QueryFn });
	console.log(`run ${spec.run_id}: ${body.status}${body.error ? ` (${body.error})` : ''}`);
	await client.finish(body);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
