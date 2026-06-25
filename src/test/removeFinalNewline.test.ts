import * as assert from 'assert';
import {
    computeTrailingNewlineLength,
    matchesAnyPattern,
    shouldStripFor,
    stripTrailingNewlines
} from '../utils/removeFinalNewline';

describe('removeFinalNewline.stripTrailingNewlines', () => {
    it('returns the input unchanged when there is no trailing newline', () => {
        const input = "const a = 1;\nconst b = 2;";
        const { text, removed } = stripTrailingNewlines(input);
        assert.strictEqual(text, input);
        assert.strictEqual(removed, 0);
    });

    it('removes a single trailing LF', () => {
        const { text, removed } = stripTrailingNewlines("const a = 1;\n");
        assert.strictEqual(text, "const a = 1;");
        assert.strictEqual(removed, 1);
    });

    it('removes a single trailing CRLF', () => {
        const { text, removed } = stripTrailingNewlines("const a = 1;\r\n");
        assert.strictEqual(text, "const a = 1;");
        assert.strictEqual(removed, 2);
    });

    it('removes multiple trailing LFs', () => {
        const { text, removed } = stripTrailingNewlines("body\n\n\n");
        assert.strictEqual(text, "body");
        assert.strictEqual(removed, 3);
    });

    it('removes multiple trailing CRLFs', () => {
        const { text, removed } = stripTrailingNewlines("body\r\n\r\n");
        assert.strictEqual(text, "body");
        assert.strictEqual(removed, 4);
    });

    it('removes mixed CRLF/LF run at end', () => {
        const { text, removed } = stripTrailingNewlines("body\r\n\n");
        assert.strictEqual(text, "body");
        assert.strictEqual(removed, 3);
    });

    it('does not strip non-newline trailing whitespace', () => {
        const input = "body  \t";
        const { text, removed } = stripTrailingNewlines(input);
        assert.strictEqual(text, input);
        assert.strictEqual(removed, 0);
    });

    it('handles empty string', () => {
        const { text, removed } = stripTrailingNewlines("");
        assert.strictEqual(text, "");
        assert.strictEqual(removed, 0);
    });

    it('is idempotent: running twice yields no further change', () => {
        const first = stripTrailingNewlines("body\n\n");
        const second = stripTrailingNewlines(first.text);
        assert.strictEqual(first.text, "body");
        assert.strictEqual(first.removed, 2);
        assert.strictEqual(second.text, "body");
        assert.strictEqual(second.removed, 0);
    });

    it('preserves interior newlines', () => {
        const input = "line1\nline2\nline3\n";
        const { text, removed } = stripTrailingNewlines(input);
        assert.strictEqual(text, "line1\nline2\nline3");
        assert.strictEqual(removed, 1);
    });
});

describe('removeFinalNewline.computeTrailingNewlineLength', () => {
    it('returns 0 for content without trailing newline', () => {
        assert.strictEqual(computeTrailingNewlineLength("a"), 0);
    });

    it('counts LF runs', () => {
        assert.strictEqual(computeTrailingNewlineLength("a\n\n"), 2);
    });

    it('counts CRLF as two characters', () => {
        assert.strictEqual(computeTrailingNewlineLength("a\r\n"), 2);
    });
});

describe('removeFinalNewline.matchesAnyPattern', () => {
    const patterns = [
        'force-app/main/default/components/lwc/**/*.js',
        'force-app/main/default/components/lwc/**/*.html',
        'force-app/main/default/components/lwc/**/*.css'
    ];

    it('matches LWC js path', () => {
        assert.strictEqual(
            matchesAnyPattern('force-app/main/default/components/lwc/foo/foo.js', patterns),
            true
        );
    });

    it('matches LWC html path', () => {
        assert.strictEqual(
            matchesAnyPattern('force-app/main/default/components/lwc/foo/foo.html', patterns),
            true
        );
    });

    it('does not match unrelated path', () => {
        assert.strictEqual(
            matchesAnyPattern('force-app/main/default/classes/Foo.cls', patterns),
            false
        );
    });

    it('returns false for empty pattern list', () => {
        assert.strictEqual(matchesAnyPattern('a/b/c.js', []), false);
    });

    it('normalizes Windows backslashes to forward slashes', () => {
        assert.strictEqual(
            matchesAnyPattern('force-app\\main\\default\\components\\lwc\\foo\\foo.js', patterns),
            true
        );
    });

    it('ignores empty pattern entries', () => {
        assert.strictEqual(matchesAnyPattern('a/b/c.js', ['', 'a/**/*.js']), true);
    });
});

describe('removeFinalNewline.shouldStripFor', () => {
    const baseInput = {
        enabled: true,
        languageId: 'javascript',
        relPath: 'force-app/main/default/components/lwc/foo/foo.js',
        languages: ['javascript', 'javascriptreact', 'html', 'css'],
        patterns: ['force-app/main/default/components/lwc/**/*.js']
    };

    it('returns false when enabled=false', () => {
        assert.strictEqual(shouldStripFor({ ...baseInput, enabled: false }), false);
    });

    it('returns true when language and pattern both match', () => {
        assert.strictEqual(shouldStripFor(baseInput), true);
    });

    it('returns false when language is not in the list', () => {
        assert.strictEqual(
            shouldStripFor({ ...baseInput, languageId: 'plaintext' }),
            false
        );
    });

    it('returns false when path does not match any pattern', () => {
        assert.strictEqual(
            shouldStripFor({
                ...baseInput,
                relPath: 'force-app/main/default/classes/Foo.cls',
                languages: ['javascript', 'apex']
            }),
            false
        );
    });

    it('returns false when patterns is empty (must opt in via at least one glob)', () => {
        assert.strictEqual(shouldStripFor({ ...baseInput, patterns: [] }), false);
    });

    it('returns false when languages list is empty', () => {
        assert.strictEqual(shouldStripFor({ ...baseInput, languages: [] }), false);
    });
});
