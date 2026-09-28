import type { ReviewFinding } from './client.js';

/**
 * レビュー役の AI の返事から指摘を読む（docs/design/ai-review.md）
 *
 * 最後の ```json コードブロック（無ければ最後の {"findings": …}）を読む。読めなければ null（レビューなしで進める）。
 */
export function parseFindings(text: string): ReviewFinding[] | null {
	// 最後のコードブロックから試し、どれも読めなければ本文の {"findings": …} を試す
	const candidates: string[] = [...text.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)```/g)].map((m) => m[1]).reverse();
	const start = text.search(/\{\s*"findings"\s*:/);
	if (start >= 0) {
		candidates.push(text.slice(start, text.lastIndexOf('}') + 1));
	}

	for (const candidate of candidates) {
		try {
			const value = JSON.parse(candidate.trim()) as { findings?: unknown };
			if (value && Array.isArray(value.findings)) {
				return value.findings
					.filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
					.map((f) => ({
						severity: String(f.severity ?? 'should'),
						title: String(f.title ?? ''),
						detail: typeof f.detail === 'string' ? f.detail : '',
						file: typeof f.file === 'string' ? f.file : '',
						line: typeof f.line === 'number' ? f.line : 0,
					}))
					.filter((f) => f.title.trim() !== '');
			}
		} catch {
			// 次の候補を試す
		}
	}
	return null;
}
