import { aicolleMcpServer } from './mcp-bridge.js';
/**
 * セッションの写しをサーバーに置く（別のサンドボックスで再開するため）
 */
export function sessionStore(client) {
    return {
        async append(key, entries) {
            await client.appendSession(key.sessionId, key.subpath ?? '', entries);
        },
        async load(key) {
            return (await client.loadSession(key.sessionId, key.subpath ?? ''));
        },
    };
}
/**
 * エージェントを1回動かす
 */
export async function runAgent(spec, client, cwd, input, queryFn, abortController) {
    // aiColle のツールは橋渡しを通す（SDK の MCP クライアントは aiColle の版を話せない。mcp-bridge.ts）
    // 一覧を取れなければここで投げて、ツールの無いまま動かさない
    const aicolle = await aicolleMcpServer(client.mcp(spec.mcp.url));
    const options = {
        cwd,
        abortController,
        // リポジトリの CLAUDE.md と .claude/skills/ を読む（ナレッジの正本）
        settingSources: ['project'],
        systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: 'あなたは aiColle のサンドボックスの中で動いている。人との連絡は MCP の aicolle のツールだけで行う。' +
                'git のコミット・push・PR 作成はランナーが行うので、あなたはしない。' +
                // 再開（resume）のときも毎回付くので、途中から英語に戻らない
                '人に向けて書くもの（最後のまとめ・判断依頼・進捗・成果物・要件・設計・ドキュメント）は必ず日本語で書く。' +
                '英語で考えた・英語の出力を読んだときも、返すときは日本語にする。コード・識別子・コマンド・エラーの原文はそのままでよい。' +
                // 再開のときも毎回付く。aiColle は 15 分連絡の無い実行を止める
                'aiColle は 15 分連絡の無い実行を止めるので、長い作業の前後と、少なくとも 5 分に1回は report_progress で進み具合を知らせる。' +
                '10 分を超えそうなコマンドはタイムアウトを付けるか分けて走らせ、返ってこないコマンド（開発サーバーなど）は走らせない。' +
                (spec.target_level === 'audit' ? 'いまは乖離の見回りなので、ファイルを変えず、見つけた食い違いは report_drift で報告する。' : ''),
        },
        // サンドボックスの中なので確認なしで道具を使う（外への通信は Sandbox 側で絞る）
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        mcpServers: { aicolle },
        // 乖離の見回りは読むだけ（書き換える道具を渡さない。Bash での grep やテストは使える）
        ...(spec.target_level === 'audit' ? { disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] } : {}),
        sessionStore: sessionStore(client),
        ...(spec.ai.model ? { model: spec.ai.model } : {}),
        ...(spec.ai.max_budget_usd != null ? { maxBudgetUsd: Math.max(0.01, spec.ai.max_budget_usd) } : {}),
        ...(input.resume ? { resume: input.resume } : {}),
        stderr: (data) => process.stderr.write(data),
        // リポジトリの hooks（aiColle が配るもの。docs/design/claude-hooks.md）が、サーバーの AI の中だと分かるように
        env: { ...process.env, AICOLLE_AGENT: 'runner' },
    };
    const result = {
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
export function describeTool(name, input) {
    const args = (input ?? {});
    const pick = (key) => (typeof args[key] === 'string' ? String(args[key]) : '');
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
//# sourceMappingURL=agent.js.map