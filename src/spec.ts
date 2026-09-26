/**
 * サーバーから渡される実行の中身（aicolle.ai.AiRunService#buildSpec と同じ形）
 *
 * 形を変えたらサーバー側も直す（docs/design/ai-run.md）。
 */
export interface RunSpec {
	run_id: number;
	attempt: number;
	target_level: 'requirement' | 'design' | 'develop';
	instructions: string;
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
	};
	question_wait_seconds: number;
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
