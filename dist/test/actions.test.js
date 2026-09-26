import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInputs, runInActions } from '../src/actions.js';
/** GitHub（OIDC・PR）と aiColle（claim・呼び戻し）のふりをする */
async function fakeServer(claimStatus = 200) {
    const calls = [];
    let base = '';
    const server = createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req)
            raw += chunk;
        const body = raw ? JSON.parse(raw) : undefined;
        calls.push({ method: req.method, path: req.url, body, headers: req.headers });
        const json = (value, status = 200) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(value));
        };
        if (req.url.startsWith('/oidc?'))
            return json({ value: 'oidc-jwt' });
        if (req.url === '/actions/claim') {
            if (claimStatus !== 200)
                return json({ error: 'この実行の中身は受け取れません' }, claimStatus);
            return json({ spec: spec(base, origin()) });
        }
        if (req.url === '/runner/mcp') {
            // aiColle の MCP（2026-07-28 版）。一覧だけ返す
            return json({ jsonrpc: '2.0', id: body.id, result: { resultType: 'complete', tools: [{ name: 'get_ticket', inputSchema: { type: 'object' } }] } });
        }
        if (req.url.endsWith('/state'))
            return json({ status: 'running', cancel_requested: false, pending_questions: 0, answers: [] });
        if (req.url.startsWith('/repos/') && req.method === 'GET')
            return json([]);
        if (req.url.startsWith('/repos/') && req.method === 'POST')
            return json({ number: 42 }, 201);
        return json({ result: 'ok' });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    return { calls, base, close: () => server.close() };
}
function origin() {
    const root = mkdtempSync(join(tmpdir(), 'actions-test-'));
    const bare = join(root, 'origin.git');
    const work = join(root, 'seed');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
    execFileSync('git', ['init', '-b', 'main', work]);
    writeFileSync(join(work, 'README.md'), '# sample\n');
    const git = (...args) => execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
    git('add', '-A');
    git('commit', '-m', 'init');
    git('remote', 'add', 'origin', bare);
    git('push', 'origin', 'main');
    return bare;
}
function spec(base, cloneUrl) {
    return {
        run_id: 12,
        attempt: 1,
        target_level: 'develop',
        instructions: '',
        prompt: 'やって',
        resume: {},
        ticket: { id: 1, key: 'PM-1', title: 'ログイン画面' },
        repository: { owner: 'ecx', repo: 'sample', default_branch: 'main', branch: 'aicolle/PM-1', docs_root: 'docs', clone_url: cloneUrl, api_base_url: base },
        github_token: 'ghs_SECRET',
        callback: { base_url: base, token: '12.runsecret' },
        mcp: { url: `${base}/runner/mcp` },
        ai: { model: '', max_budget_usd: null, max_test_retries: 3, time_limit_minutes: 0, test_command: '' },
        question_wait_seconds: 1,
        platform: 'github_actions',
        anthropic: { base_url: `${base}/anthropic`, token: '12.runsecret' },
    };
}
/** 呼ばれたときの Claude API の宛先を覚えておく偽のエージェント */
function fakeQuery(seen, env) {
    return async function* ({ options }) {
        seen.baseUrl = env.ANTHROPIC_BASE_URL;
        seen.apiKey = env.ANTHROPIC_API_KEY;
        writeFileSync(join(options.cwd, 'done.md'), 'ok');
        yield {
            type: 'result', subtype: 'success', is_error: false, result: 'できました', session_id: 's',
            total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 1 },
        };
    };
}
test('OIDC トークンと合言葉で中身を受け取り、秘密を mask し、Claude API は aiColle の中継を使う', async () => {
    const server = await fakeServer();
    const summary = join(mkdtempSync(join(tmpdir(), 'summary-')), 'summary.md');
    const env = {
        AICOLLE_RUN_ID: '12',
        AICOLLE_NONCE: 'nonce-1',
        AICOLLE_SERVER: server.base + '/',
        ACTIONS_ID_TOKEN_REQUEST_URL: `${server.base}/oidc?api-version=2.0`,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'req-token',
        ANTHROPIC_API_KEY: 'someone-elses-key',
        ANTHROPIC_AUTH_TOKEN: 'x',
        GITHUB_STEP_SUMMARY: summary,
    };
    const lines = [];
    const seen = {};
    const body = await runInActions({ env, queryFn: fakeQuery(seen, env), log: (l) => lines.push(l), pollMs: 50 });
    assert.equal(body.status, 'succeeded');
    // OIDC は aud = aiColle の URL で取る
    const oidc = server.calls.find((c) => c.path.startsWith('/oidc?'));
    assert.match(oidc.path, new RegExp(`audience=${encodeURIComponent(server.base)}$`));
    assert.equal(oidc.headers.authorization, 'Bearer req-token');
    // 合言葉と OIDC トークンを出す
    const claimed = server.calls.find((c) => c.path === '/actions/claim');
    assert.deepEqual(claimed.body, { run_id: '12', nonce: 'nonce-1', id_token: 'oidc-jwt' });
    // 秘密は mask する
    for (const secret of ['oidc-jwt', '12.runsecret', 'ghs_SECRET']) {
        assert.ok(lines.includes(`::add-mask::${secret}`), secret);
    }
    assert.ok(!lines.some((l) => !l.startsWith('::add-mask::') && /runsecret|ghs_SECRET/.test(l)));
    // Claude API は中継へ。ジョブの環境の別のキーは使わない
    assert.equal(seen.baseUrl, `${server.base}/anthropic`);
    assert.equal(seen.apiKey, '12.runsecret');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    // aiColle のツールは受け取った実行トークンで、2026-07-28 版で呼ぶ
    const mcp = server.calls.find((c) => c.path === '/runner/mcp');
    assert.equal(mcp.headers.authorization, 'Bearer 12.runsecret');
    assert.equal(mcp.headers['mcp-protocol-version'], '2026-07-28');
    assert.equal(mcp.headers['mcp-method'], 'tools/list');
    // 終わりを知らせ、ジョブのまとめに残す
    assert.ok(server.calls.some((c) => c.path === '/runner/runs/12/finish' && c.body.status === 'succeeded'));
    assert.match(readFileSync(summary, 'utf8'), /PR #42/);
    server.close();
});
test('中身を受け取れなければ理由つきで失敗する', async () => {
    const server = await fakeServer(401);
    const env = {
        AICOLLE_RUN_ID: '12', AICOLLE_NONCE: 'x', AICOLLE_SERVER: server.base,
        ACTIONS_ID_TOKEN_REQUEST_URL: `${server.base}/oidc?api-version=2.0`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't',
    };
    await assert.rejects(runInActions({ env, queryFn: fakeQuery({}, env), log: () => undefined }), /受け取れません/);
    server.close();
});
test('入力が足りない・http の外部 URL・id-token の権限が無いときは始めない', async () => {
    assert.throws(() => readInputs({}), /aiColle が起こしたジョブではありません/);
    assert.throws(() => readInputs({ AICOLLE_RUN_ID: '1', AICOLLE_NONCE: 'n', AICOLLE_SERVER: 'http://example.com' }), /https/);
    await assert.rejects(runInActions({ env: { AICOLLE_RUN_ID: '1', AICOLLE_NONCE: 'n', AICOLLE_SERVER: 'https://aicolle.example' }, queryFn: fakeQuery({}, {}), log: () => undefined }), /id-token: write/);
});
//# sourceMappingURL=actions.test.js.map