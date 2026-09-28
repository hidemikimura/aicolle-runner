import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
/**
 * git の操作
 *
 * トークンは URL にもコマンドの引数にも入れず、GIT_CONFIG_* の環境変数で http.extraheader を渡す。
 * 引数に入れると失敗したときのエラーの文（execFile は実行したコマンドを載せる）に出てしまう。
 * 念のため、エラーの文からトークンを消してから投げ直す。
 */
export class Git {
    dir;
    spec;
    constructor(dir, spec) {
        this.dir = dir;
        this.spec = spec;
    }
    basic() {
        return Buffer.from(`x-access-token:${this.spec.github_token}`).toString('base64');
    }
    env() {
        const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
        if (this.spec.github_token) {
            env.GIT_CONFIG_COUNT = '1';
            env.GIT_CONFIG_KEY_0 = 'http.extraheader';
            env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${this.basic()}`;
        }
        return env;
    }
    /** エラーの文からトークンを消す */
    redact(text) {
        const token = this.spec.github_token;
        if (!token) {
            return text;
        }
        return text.split(token).join('***').split(this.basic()).join('***');
    }
    async exec(args, cwd) {
        try {
            const { stdout } = await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, env: this.env() });
            return stdout.trim();
        }
        catch (error) {
            const e = error;
            throw new Error(this.redact(`git ${args[0]} が失敗しました: ${e.stderr || e.message || String(error)}`));
        }
    }
    async git(...args) {
        return this.exec(args, this.dir);
    }
    /**
     * リポジトリを取り、チケットのブランチに切り替える
     *
     * ブランチがすでにあれば（再開・差戻し）その続きから、無ければ既定ブランチから作る。
     */
    async prepare() {
        const { clone_url, branch, default_branch } = this.spec.repository;
        await this.exec(['clone', '--no-tags', clone_url, this.dir]);
        await this.git('config', 'user.name', 'aiColle AI');
        await this.git('config', 'user.email', 'ai@aicolle.invalid');
        const remote = await this.git('ls-remote', '--heads', 'origin', branch);
        // 最初からやり直す: ブランチがあっても既定ブランチから作り直す。push はそのときの先頭を確かめて上書きする
        if (this.spec.restart_from === 'goal') {
            await this.git('checkout', '-B', branch, `origin/${default_branch}`);
            if (remote) {
                this.overwrite = remote.split(/\s+/)[0];
                return 'recreated';
            }
            return 'created';
        }
        if (remote) {
            await this.git('fetch', 'origin', `${branch}:refs/remotes/origin/${branch}`);
            await this.git('checkout', '-B', branch, `origin/${branch}`);
            return 'resumed';
        }
        await this.git('checkout', '-B', branch, `origin/${default_branch}`);
        return 'created';
    }
    /** 変更があればコミットする。コミットしたら true */
    async commitAll(message) {
        await this.git('add', '-A');
        const status = await this.git('status', '--porcelain');
        if (!status) {
            return false;
        }
        await this.git('commit', '-m', message);
        return true;
    }
    /** 既定ブランチより先に進んだコミットがあるか */
    async hasCommitsAhead() {
        const count = await this.git('rev-list', '--count', `origin/${this.spec.repository.default_branch}..HEAD`);
        return Number(count) > 0;
    }
    /** 作り直したブランチの、取ったときの先頭（上書きの push に使う。1回上書きしたら空に戻す） */
    overwrite = '';
    /** 最初からやり直して、まだ上書きしていないか（変更が無くても push して、古いコミットを消す） */
    needsOverwrite() {
        return this.overwrite !== '';
    }
    async push() {
        const { branch } = this.spec.repository;
        if (this.overwrite) {
            // 取ったあとで誰かが push していたら上書きしない（--force-with-lease）
            await this.git('push', `--force-with-lease=refs/heads/${branch}:${this.overwrite}`, 'origin', `HEAD:refs/heads/${branch}`);
            this.overwrite = '';
            return;
        }
        await this.git('push', 'origin', `HEAD:refs/heads/${branch}`);
    }
}
//# sourceMappingURL=git.js.map