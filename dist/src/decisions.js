import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
/**
 * 決定記録（docs/design/feedback.md「決まったことの記録」）
 *
 * 判断依頼に人が答えたものを `{docs_root}/decisions/{チケットのキー}.md` に書き、PR に入れる。
 * マージされるとナレッジの「決定記録」になり、ほかのチケットの AI も search_knowledge で引ける
 * （同じことを何度も聞かなくなる）。
 *
 * 中身は aiColle が持っている回答から毎回作り直す。手で直しても次の作業で上書きされるので、
 * 決まったことを変えたいときはチケットで判断し直す。
 */
/** 書く場所（リポジトリの中のパス） */
export function decisionsPath(spec) {
    const root = (spec.repository.docs_root || 'docs').replace(/^\/+|\/+$/g, '') || 'docs';
    return `${root}/decisions/${spec.ticket.key}.md`;
}
/** Markdown に組む */
export function renderDecisions(spec, decisions) {
    const lines = [
        '---',
        `id: decision-${spec.ticket.key}`,
        'kind: decision',
        `source_tickets: [${spec.ticket.key}]`,
        '---',
        '',
        `# ${spec.ticket.key} ${oneLine(spec.ticket.title)} で決まったこと`,
        '',
        'AI の判断依頼に人が答えたものです。aiColle が作業のたびに書き直します（手で直さない。変えるときはチケットで判断し直す）。',
    ];
    for (const decision of decisions) {
        lines.push('', `## ${oneLine(decision.question)}`, '');
        lines.push(`- 決まったこと: **${oneLine(decision.answer)}**${decision.answered_at ? `（${decision.answered_at.slice(0, 10)}）` : ''}`);
        if (decision.options.length > 0) {
            lines.push(`- 選択肢: ${decision.options.map(oneLine).join(' / ')}`);
        }
        if (decision.recommended) {
            lines.push(`- AI の推奨: ${oneLine(decision.recommended)}${decision.reason ? ` — ${oneLine(decision.reason)}` : ''}`);
        }
    }
    return lines.join('\n') + '\n';
}
/**
 * 書く（回答が1つも無ければ何もしない）
 *
 * @returns 書いたパス（書かなければ null）
 */
export async function writeDecisions(repoDir, spec) {
    const decisions = spec.decisions ?? [];
    if (decisions.length === 0) {
        return null;
    }
    const path = decisionsPath(spec);
    const full = join(repoDir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, renderDecisions(spec, decisions));
    return path;
}
/** 見出しや箇条書きを壊さないように1行にする */
function oneLine(text) {
    return String(text ?? '').replace(/\s*\n\s*/g, ' ').trim();
}
//# sourceMappingURL=decisions.js.map