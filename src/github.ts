import type { RunSpec } from './spec.js';

/**
 * PR を作る（すでに開いていればそれを使う）
 *
 * @returns PR の番号
 */
export async function ensurePullRequest(
	spec: RunSpec,
	title: string,
	body: string,
	fetchFn: typeof fetch = fetch,
): Promise<number> {
	const { owner, repo, branch, default_branch, api_base_url } = spec.repository;
	const base = api_base_url.replace(/\/+$/, '');
	const headers = {
		Authorization: `Bearer ${spec.github_token}`,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		'User-Agent': 'aiColle-runner',
		'Content-Type': 'application/json',
	};

	const existing = await fetchFn(
		`${base}/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
		{ headers },
	);
	if (!existing.ok) {
		throw new Error(`PR の一覧を取れませんでした（GitHub: ${existing.status}）`);
	}
	const open = (await existing.json()) as { number: number }[];
	if (open.length > 0) {
		// 本文は最新のまとめに差し替える
		await fetchFn(`${base}/repos/${owner}/${repo}/pulls/${open[0].number}`, {
			method: 'PATCH',
			headers,
			body: JSON.stringify({ body }),
		});
		return open[0].number;
	}

	const created = await fetchFn(`${base}/repos/${owner}/${repo}/pulls`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ title, body, head: branch, base: default_branch, draft: false }),
	});
	if (!created.ok) {
		throw new Error(`PR を作れませんでした（GitHub: ${created.status} ${(await created.text()).slice(0, 300)}）`);
	}
	return ((await created.json()) as { number: number }).number;
}
