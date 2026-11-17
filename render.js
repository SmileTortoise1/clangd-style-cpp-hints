'use strict';

const languages = new Set(['c', 'cpp']);
const preloadLines = 96;
const scrollMargin = 12;
const hintColors = {
    parameter: ['editorInlayHint.parameterForeground', 'editorInlayHint.parameterBackground'],
    general: ['editorInlayHint.foreground', 'editorInlayHint.background']
};

function hintPalette(hint) {
    if (hint.enumValue || hint.hintKind === 'field' || hint.hintKind === 'index') { return 'general'; }
    if (hint.hintKind === 'parameter' || hint.kind === 2) { return 'parameter'; }
    return undefined;
}

function mergeSpans(spans) {
    const merged = [];
    for (const span of spans.slice().sort((a, b) => a.first - b.first)) {
        const last = merged[merged.length - 1];
        if (last && span.first <= last.last + 1) {
            last.last = Math.max(last.last, span.last);
        } else {
            merged.push({ ...span });
        }
    }
    return merged;
}

function spansFor(editor, margin) {
    return mergeSpans(editor.visibleRanges.map(range => ({
        first: Math.max(0, range.start.line - margin),
        last: Math.min(editor.document.lineCount - 1, range.end.line + margin)
    })));
}

function covers(loaded, visible) {
    return visible.every(span => loaded.some(item => item.first <= span.first && item.last >= span.last));
}

function decorationOptions(vscode, document, hints) {
    const byPosition = new Map();
    for (const hint of hints) {
        const { line, character } = hint.position;
        const key = line + ':' + character;
        if (!byPosition.has(key)) { byPosition.set(key, []); }
        const group = byPosition.get(key);
        if (!group.some(previous => previous.label === hint.label && previous.enumValue === hint.enumValue)) {
            group.push(hint);
        }
    }
    const decorations = [...byPosition.values()].flatMap(group => {
        // Let the native parameter label precede our enum value when they share
        // the start of an argument, for example dispatch(mode: 1 MODE_RUN).
        group.sort((a, b) => Number(Boolean(a.enumValue)) - Number(Boolean(b.enumValue)));
        const { line, character } = group[0].position;
        if (line < 0 || line >= document.lineCount) { return []; }
        const text = document.lineAt(line).text;
        if (!text.length || character < 0 || character > text.length) { return []; }
        const atEnd = character === text.length;
        // Attach at the next character, or after the final character at EOL.
        let start = atEnd ? character - 1 : character;
        let end = atEnd ? character : character + 1;
        if (atEnd && start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) { start--; }
        if (!atEnd && /[\uD800-\uDBFF]/.test(text[start]) && end < text.length) { end++; }
        const gapLeft = group[0].marginColumns === undefined
            ? (group[0].paddingLeft ? '0.35em' : '0') : group[0].marginColumns + 'ch';
        const last = group[group.length - 1];
        const gapRight = last.rightMarginColumns === undefined ? (last.paddingRight ? '0.35em' : '0') : last.rightMarginColumns + 'ch';
        const width = group.length === 1 && last.widthColumns !== undefined ? { width: last.widthColumns + 'ch' } : {};
        const runs = [];
        for (const hint of group) {
            const palette = hintPalette(hint);
            const previous = runs[runs.length - 1];
            if (previous && previous.palette === palette) {
                previous.labels.push(hint.label);
            } else {
                runs.push({ palette, labels: [hint.label] });
            }
        }
        return runs.map(({ palette, labels }, index) => ({
            range: new vscode.Range(line, start, line, end),
            renderOptions: {
                [atEnd ? 'after' : 'before']: {
                    contentText: labels.join(' '),
                    margin: `0 ${index === runs.length - 1 ? gapRight : '0'} 0 ${index === 0 ? gapLeft : '1ch'}`,
                    ...(palette && {
                        color: new vscode.ThemeColor(hintColors[palette][0]),
                        backgroundColor: new vscode.ThemeColor(hintColors[palette][1])
                    }),
                    ...width
                }
            }
        }));
    });
    // Use the source gap before the comment to absorb the virtual assignment.
    for (const { suffixSpacing } of hints) {
        if (!suffixSpacing) { continue; }
        const { line, character } = suffixSpacing.position;
        decorations.push({
            range: new vscode.Range(line, character, line, character + 1),
            renderOptions: { before: { contentText: '', width: '0ch', margin: `0 ${suffixSpacing.columns}ch 0 0` } }
        });
    }
    return decorations;
}

function installRenderer(vscode, onRefresh, provider, log) {
    const colors = {
        color: new vscode.ThemeColor('clangdStyleCppHints.foreground'),
        backgroundColor: new vscode.ThemeColor('clangdStyleCppHints.background'),
        fontStyle: 'normal',
        fontWeight: 'normal'
    };
    const decoration = vscode.window.createTextEditorDecorationType({
        before: colors,
        after: colors,
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });
    const pending = new Map();
    const displayed = new Map();
    const isEligible = editor => languages.has(editor.document.languageId);
    function cancel(editor) {
        const job = pending.get(editor);
        if (job) {
            clearTimeout(job.timer);
            job.isCancellationRequested = true;
            pending.delete(editor);
        }
    }
    function schedule(editor, force = false, delay = 55) {
        const document = editor.document;
        const mode = vscode.workspace.getConfiguration('editor', document).get('inlayHints.enabled', 'on');
        const enabled = vscode.workspace.getConfiguration('clangdStyleCppHints', document).get('enabled', true);
        if (!isEligible(editor) || !enabled || mode === 'off' || mode === 'offUnlessPressed') {
            cancel(editor);
            if (displayed.delete(editor)) { editor.setDecorations(decoration, []); }
            return;
        }
        const version = document.version;
        const viewport = spansFor(editor, 0);
        if (!viewport.length) { return; }
        const sameVersion = snapshot => snapshot?.document === document && snapshot.version === version;
        const active = pending.get(editor);
        const previous = displayed.get(editor);
        if (!force && sameVersion(active) && covers(active.spans, viewport)) { return; }
        if (!force && sameVersion(previous) && covers(previous.spans, spansFor(editor, scrollMargin))) { return; }
        cancel(editor);
        const job = { document, version, spans: spansFor(editor, preloadLines), visibleSpans: viewport,
            tabSize: typeof editor.options?.tabSize === 'number' && editor.options.tabSize > 0 ? editor.options.tabSize : 4,
            isCancellationRequested: false };
        pending.set(editor, job);
        job.timer = setTimeout(async () => {
            try {
                const ranges = job.spans.map(span => new vscode.Range(
                    document.lineAt(span.first).range.start, document.lineAt(span.last).range.end));
                const fresh = (await Promise.all(ranges.map(range => provider.provideInlayHints(document, range, job)))).flat();
                if (job.isCancellationRequested || editor.document !== document || document.version !== version) { return; }
                if (job.waitingForSemanticTokens && previous?.hints.length && previous.document === document) { return; }
                const retain = !force && sameVersion(previous) && previous.hints.length < 3000 && previous.spans.length < 16;
                const hints = retain ? previous.hints.filter(hint =>
                    !job.spans.some(span => hint.position.line >= span.first && hint.position.line <= span.last)).concat(fresh) : fresh;
                const spans = retain ? mergeSpans(job.spans.concat(previous.spans)) : job.spans;
                const decorations = decorationOptions(vscode, document, hints);
                const signature = JSON.stringify(decorations);
                // The editor tracks existing ranges across edits. Replace them
                // only after the new result is ready, without an empty frame.
                if (!sameVersion(previous) || signature !== previous.signature) {
                    editor.setDecorations(decoration, decorations);
                }
                displayed.set(editor, { document, version, spans, hints, signature });
            } catch (error) {
                log?.appendLine(error.message);
            } finally {
                if (pending.get(editor) === job) { pending.delete(editor); }
            }
        }, delay);
    }
    const refresh = () => vscode.window.visibleTextEditors.forEach(editor => schedule(editor, true));
    const subscriptions = [
        onRefresh(refresh),
        vscode.window.onDidChangeVisibleTextEditors(editors => {
            for (const editor of pending.keys()) {
                if (!editors.includes(editor)) { cancel(editor); }
            }
            for (const editor of displayed.keys()) {
                if (!editors.includes(editor)) { displayed.delete(editor); }
            }
            editors.forEach(editor => schedule(editor));
        }),
        vscode.window.onDidChangeTextEditorVisibleRanges(event => schedule(event.textEditor)),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (!event.contentChanges.length) { return; }
            for (const editor of vscode.window.visibleTextEditors) {
                if (editor.document === event.document) { schedule(editor, true, 220); }
            }
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('editor.inlayHints.enabled')) { refresh(); }
        })
    ];
    refresh();
    return {
        dispose() {
            for (const editor of pending.keys()) { cancel(editor); }
            displayed.clear();
            for (const subscription of subscriptions) { subscription.dispose(); }
            decoration.dispose();
        }
    };
}

module.exports = { installRenderer, decorationOptions };
