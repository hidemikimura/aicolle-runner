# aiColle runner

aiColle のチケットを Claude Agent SDK で進めるランナー。3つの場所で動く。

| 入口 | 場所 |
| --- | --- |
| `dist/src/main.js <spec.json>` | Cloudflare Sandbox のコンテナ・手元（`local`） |
| `dist/src/actions.js`（`action.yml`） | 利用者のリポジトリの GitHub Actions |

GitHub Actions では、aiColle が workflow_dispatch で起こしたジョブの中で使う。

```yaml
- uses: ecx/aicolle-runner@v1
  with:
    run_id: ${{ inputs.run_id }}
    nonce: ${{ inputs.nonce }}
    server: ${{ inputs.server }}
```

ワークフローには `permissions: id-token: write` が要る。Secrets は要らない（ジョブは GitHub の OIDC トークンで aiColle に名乗る）。
仕組みは aiColle の `docs/design/github-actions-runner.md`。

```bash
npm ci && npm test
```
