/**
 * サーバーから渡される実行の中身（aicolle.ai.AiRunService#buildSpec と同じ形）
 *
 * 形を変えたらサーバー側も直す（docs/design/ai-run.md）。
 */
export interface RunSpec {
	run_id: number;
	attempt: number;
	/** audit = docs とコードの乖離の見回り（ファイルを変えない・コミットも PR もしない。docs/design/drift.md） */
	target_level: 'requirement' | 'design' | 'develop' | 'audit';
	instructions: string;
	/** やり直す工程（空 = 続きから / goal = 最初から: ブランチを既定ブランチから作り直す / requirement / design / implement）。古いサーバーは送らない */
	restart_from?: '' | 'goal' | 'requirement' | 'design' | 'implement';
	/** エージェントへの最初の指示（サーバーが conf/prompts/run.md から組み立てたもの） */
	prompt: string;
	/** 判断依頼から再開するとき */
	resume: { session_id?: string; prompt?: string; previous_cost_usd?: number };
	ticket: { id: number; key: string; title: string };
	repository: {
		owner: string;
		repo: string;
		default_branch: string;
		branch: string;
		docs_root: string;
		clone_url: string;
		api_base_url: string;
	};
	/** そのリポジトリだけ・1時間だけ使える GitHub のトークン（空なら push も PR もしない） */
	github_token: string;
	callback: { base_url: string; token: string };
	mcp: { url: string };
	ai: {
		model: string;
		max_budget_usd: number | null;
		max_test_retries: number;
		time_limit_minutes: number;
		test_command: string;
		/** PR を作る前に提出前チェックを呼ぶか（古いサーバーは送らない = 呼ばない。docs/design/presubmit.md） */
		presubmit?: boolean;
		/** 提出前チェックで見つかったものをエージェントに直させる回数 */
		presubmit_retries?: number;
	};
	question_wait_seconds: number;
	/** 回答の出た判断依頼（決定記録として {docs_root}/decisions/{キー}.md に書く。古いサーバーは送らない） */
	decisions?: Decision[];
}

/** 回答の出た判断依頼 */
export interface Decision {
	question: string;
	options: string[];
	recommended: string;
	reason: string;
	answer: string;
	answered_at: string;
}

/** サーバーへ送る出来事 */
export interface RunEvent {
	kind: string;
	message: string;
	payload?: Record<string, unknown>;
}

/** 終わったときにサーバーへ送るもの */
export interface FinishBody {
	status: 'succeeded' | 'failed' | 'cancelled' | 'waiting_answer';
	session_id?: string;
	branch?: string;
	pr_number?: number;
	summary?: string;
	error?: string;
	usage?: { input_tokens: number; output_tokens: number; cost_usd: number };
	sandbox_seconds?: number;
}
