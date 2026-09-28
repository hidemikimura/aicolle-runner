import { AicolleMcp } from './mcp-bridge.js';
import type { FinishBody, RunEvent, RunSpec } from './spec.js';

/** /runner/runs/{id}/state の応答 */
export interface RunState {
	status: string;
	cancel_requested: boolean;
	pending_questions: number;
	answers: { question_id: number; question: string; answer: string }[];
}

/**
 * サーバーへの呼び戻し（docs/design/ai-run.md「ランナーとの約束」）
 *
 * 出来事はためて 1 秒ごとにまとめて送る。送れなかったものは次にまとめて送り直す。
 */
/** 提出前チェックの結果 */
/** レビュー役の指摘を送った結果（docs/design/ai-review.md） */
export interface ReviewResult {
	/** 直すべき指摘の数 */
	must: number;
	/** 直させるときに作業したセッションに渡す文 */
	prompt: string;
	/** PR の本文に足す文 */
	pr_note: string;
}

/** レビュー役の指摘 */
export interface ReviewFinding {
	severity: string;
	title: string;
	detail?: string;
	file?: string;
	line?: number;
}

export interface PresubmitResult {
	problems: { key: string; label: string; message: string; files: string[] }[];
	/** 直させるときにエージェントに渡す文 */
	prompt: string;
	/** 直しきれなかったときに PR の本文に足す文 */
	pr_note: string;
}

export class AicolleClient {
	private readonly base: string;
	private readonly token: string;
	private readonly runId: number;
	private queue: RunEvent[] = [];
	private timer: NodeJS.Timeout | null = null;
	private flushing: Promise<void> | null = null;

	constructor(spec: RunSpec, private readonly fetchFn: typeof fetch = fetch) {
		this.base = spec.callback.base_url.replace(/\/+$/, '');
		this.token = spec.callback.token;
		this.runId = spec.run_id;
	}

	/** 出来事を積む（すぐには送らない） */
	event(kind: string, message: string, payload: Record<string, unknown> = {}): void {
		this.queue.push({ kind, message: message.slice(0, 2000), payload });
		if (!this.timer) {
			this.timer = setTimeout(() => {
				this.timer = null;
				void this.flush();
			}, 1000);
		}
	}

	/** 積んだ出来事を送る */
	async flush(): Promise<void> {
		if (this.flushing) {
			await this.flushing;
		}
		if (this.queue.length === 0) {
			return;
		}
		const events = this.queue.splice(0, 200);
		this.flushing = this.request('POST', `/runner/runs/${this.runId}/events`, { events })
			.then(() => undefined)
			.catch((error) => {
				// 送れなければ戻して次に回す（サーバーが一時的に落ちていても出来事を失わない）
				this.queue.unshift(...events);
				console.error('出来事を送れませんでした', error);
			})
			.finally(() => {
				this.flushing = null;
			});
		await this.flushing;
		if (this.queue.length > 0) {
			await this.flush();
		}
	}

	async state(): Promise<RunState> {
		return (await this.request('GET', `/runner/runs/${this.runId}/state`)) as RunState;
	}

	/** 回答をエージェントに渡したと知らせる（渡すまでは /state が同じ回答を返し続ける） */
	async ackAnswers(questionIds: number[]): Promise<void> {
		if (questionIds.length > 0) {
			await this.request('POST', `/runner/runs/${this.runId}/answers/ack`, { question_ids: questionIds });
		}
	}

	async finish(body: FinishBody): Promise<void> {
		await this.flush();
		// 終わりの知らせは必ず届けたいので、何度か試す
		for (let attempt = 1; ; attempt++) {
			try {
				await this.request('POST', `/runner/runs/${this.runId}/finish`, body);
				return;
			} catch (error) {
				if (attempt >= 5) {
					throw error;
				}
				await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
			}
		}
	}

	/** 提出前チェック（push したあと、PR を作る前）。problems が空なら通った */
	async presubmit(summary: string): Promise<PresubmitResult> {
		return (await this.request('POST', `/runner/runs/${this.runId}/presubmit`, { summary })) as PresubmitResult;
	}

	/** レビュー役の指摘を送る（round は 1 から。fixed_earlier は前のレビューで直させた数） */
	async review(round: number, findings: ReviewFinding[], fixedEarlier: number): Promise<ReviewResult> {
		return (await this.request('POST', `/runner/runs/${this.runId}/review`, { round, findings, fixed_earlier: fixedEarlier })) as ReviewResult;
	}

	async appendSession(sessionId: string, subpath: string, entries: unknown[]): Promise<void> {
		await this.request('POST', `/runner/sessions/${encodeURIComponent(sessionId)}`, { subpath, entries });
	}

	async loadSession(sessionId: string, subpath: string): Promise<unknown[] | null> {
		const query = subpath ? `?subpath=${encodeURIComponent(subpath)}` : '';
		const body = (await this.request('GET', `/runner/sessions/${encodeURIComponent(sessionId)}${query}`)) as {
			entries: unknown[] | null;
		};
		return body.entries ?? null;
	}

	/** MCP の接続設定に入れるヘッダ */
	authHeaders(): Record<string, string> {
		return { Authorization: `Bearer ${this.token}` };
	}

	/** aiColle の MCP（2026-07-28 版）を呼ぶ口。SDK には mcp-bridge.ts の橋渡しを通して渡す */
	mcp(url: string): AicolleMcp {
		return new AicolleMcp(url, this.authHeaders(), this.fetchFn);
	}

	private async request(method: string, path: string, body?: unknown): Promise<unknown> {
		const response = await this.fetchFn(this.base + path, {
			method,
			headers: {
				Authorization: `Bearer ${this.token}`,
				Accept: 'application/json',
				...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 300)}`);
		}
		return text.startsWith('{') ? JSON.parse(text) : {};
	}
}
