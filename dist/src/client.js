import { AicolleMcp } from './mcp-bridge.js';
export class AicolleClient {
    fetchFn;
    base;
    token;
    runId;
    queue = [];
    timer = null;
    flushing = null;
    constructor(spec, fetchFn = fetch) {
        this.fetchFn = fetchFn;
        this.base = spec.callback.base_url.replace(/\/+$/, '');
        this.token = spec.callback.token;
        this.runId = spec.run_id;
    }
    /** 出来事を積む（すぐには送らない） */
    event(kind, message, payload = {}) {
        this.queue.push({ kind, message: message.slice(0, 2000), payload });
        if (!this.timer) {
            this.timer = setTimeout(() => {
                this.timer = null;
                void this.flush();
            }, 1000);
        }
    }
    /** 積んだ出来事を送る */
    async flush() {
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
    async state() {
        return (await this.request('GET', `/runner/runs/${this.runId}/state`));
    }
    /** 回答をエージェントに渡したと知らせる（渡すまでは /state が同じ回答を返し続ける） */
    async ackAnswers(questionIds) {
        if (questionIds.length > 0) {
            await this.request('POST', `/runner/runs/${this.runId}/answers/ack`, { question_ids: questionIds });
        }
    }
    async finish(body) {
        await this.flush();
        // 終わりの知らせは必ず届けたいので、何度か試す
        for (let attempt = 1;; attempt++) {
            try {
                await this.request('POST', `/runner/runs/${this.runId}/finish`, body);
                return;
            }
            catch (error) {
                if (attempt >= 5) {
                    throw error;
                }
                await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
            }
        }
    }
    /** 提出前チェック（push したあと、PR を作る前）。problems が空なら通った */
    async presubmit(summary) {
        return (await this.request('POST', `/runner/runs/${this.runId}/presubmit`, { summary }));
    }
    async appendSession(sessionId, subpath, entries) {
        await this.request('POST', `/runner/sessions/${encodeURIComponent(sessionId)}`, { subpath, entries });
    }
    async loadSession(sessionId, subpath) {
        const query = subpath ? `?subpath=${encodeURIComponent(subpath)}` : '';
        const body = (await this.request('GET', `/runner/sessions/${encodeURIComponent(sessionId)}${query}`));
        return body.entries ?? null;
    }
    /** MCP の接続設定に入れるヘッダ */
    authHeaders() {
        return { Authorization: `Bearer ${this.token}` };
    }
    /** aiColle の MCP（2026-07-28 版）を呼ぶ口。SDK には mcp-bridge.ts の橋渡しを通して渡す */
    mcp(url) {
        return new AicolleMcp(url, this.authHeaders(), this.fetchFn);
    }
    async request(method, path, body) {
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
//# sourceMappingURL=client.js.map