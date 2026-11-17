'use strict';

const { indexSource, splitList } = require('./source');

function escapePattern(text) {
    return text.replace(/[.*+?^\x24{}()|[\]\\]/g, '\\$&');
}

function codeSnippets(hovers) {
    const snippets = [];
    for (const hover of hovers ?? []) {
        for (const content of hover.contents ?? []) {
            if (typeof content !== 'string' && ['c', 'cpp', 'c++'].includes(content.language)) {
                snippets.push(content.value);
                continue;
            }
            const value = typeof content === 'string' ? content : content.value;
            const fence = /^ {0,3}\x60{3}(?:c|cpp|c\+\+)[ \t]*\r?\n([\s\S]*?)\r?\n {0,3}\x60{3}/im.exec(value ?? '');
            if (fence) {
                snippets.push(fence[1]);
            }
        }
    }
    return snippets;
}

function singleValue(values) {
    const unique = [...new Set(values.filter(Boolean))];
    return unique.length === 1 ? unique[0] : undefined;
}

function enumValue(hovers, name) {
    const numeral = /[+-]?(?:0[xX][\dA-Fa-f](?:'?[\dA-Fa-f])*|0[bB][01](?:'?[01])*|\d(?:'?\d)*)(?:[uUlLzZ]{0,3})/.source;
    const member = '(?:^|[\\s:])' + escapePattern(name);
    const value = new RegExp(member + '\\s*=\\s*(' + numeral + ')\\s*[,;]?\\s*$');
    return singleValue(codeSnippets(hovers).map(snippet => {
        if (/\benum(?:\s+class)?\b[^{]*\{/.test(snippet)) {
            return undefined;
        }
        return singleValue(snippet.trim().split(/\r?\n/).map(line =>
            value.exec(line.trim())?.[1]?.replace(/[uUlLzZ]+$/, '')
        ));
    }));
}

const errorTypeMarker = /<\s*(?:[^<>]*(?:\u9519\u8bef|\u672a\u77e5|\u65e0\u6548|\u672a\u89e3\u6790)[^<>]*|(?:error|invalid|unresolved|dependent)(?:[ _-]+type)?)\s*>/gi;
const bareIdentifier = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const knownTypeWord = /^(?:u?int\d+_t|u?int_(?:fast|least)\d+_t|u?intptr_t|u?intmax_t|bool|_Bool|char|short|int|long|float|double|void|const|volatile|restrict|signed|unsigned|size_t|ptrdiff_t)$/;

function typeText(text) {
    const result = text?.trim().replace(/\s+/g, ' ');
    if (!result || result.length > 100 || /[;{}\r\n=]|(?:^|\W)(?:auto|decltype|unknown|__unknown__|__error_type__)(?:\W|$)/i.test(result) ||
        result.replace(errorTypeMarker, '') !== result || /\berror[ _-]+type\b/i.test(result)) {
        return undefined;
    }
    return result;
}

function parameterDeclaration(text) {
    const declaration = text?.trim();
    if (!declaration || declaration === 'void' || declaration === '...') { return {}; }
    const named = /^(.+?(?:\s|[*&>]))([\p{L}_][\p{L}\p{N}_]*)\s*((?:\[[^\[\]]*\]\s*)*)(?:=.*)?$/u.exec(declaration);
    if (!named || knownTypeWord.test(named[2]) ||
        /^(?:(?:const|volatile|restrict|struct|union|enum|class|typename)\s*)+$/.test(named[1].trim()) || /::$/.test(named[1].trim())) {
        return { type: typeText(declaration) };
    }
    const type = typeText(named[1]);
    return { name: named[2], type: type && (type + (named[3] ? ' ' + named[3].trim() : '')) };
}

function deducedType(hovers, name) {
    const variable = new RegExp('^(.+?(?:\\s|[*&]))' + escapePattern(name) + '(?:\\s*=.*|\\s*;)?$');
    return singleValue(codeSnippets(hovers).map(snippet => {
        const declaration = snippet.trim().replace(/^\((?:variable|local variable)\)\s*/i, '').split(/\r?\n/, 1)[0];
        return typeText(variable.exec(declaration)?.[1]);
    }));
}

function deducedReturnType(hovers, name) {
    const prefix = new RegExp('^(.+?(?:\\s|[*&]))(?:[\\w:]+::)?' + escapePattern(name) + '\\s*\\(');
    return singleValue(codeSnippets(hovers).map(snippet => {
        const declaration = snippet.trim().replace(/^\((?:function|method|member function)\)\s*/i, '');
        const opening = prefix.exec(declaration);
        if (!opening) { return undefined; }
        const before = opening[1].replace(/^(?:(?:inline|static|constexpr|virtual)\s+)+/, '');
        if (before.trim() !== 'auto') { return typeText(before); }
        const { tokens, offsets } = indexSource(declaration);
        const close = tokens[offsets.get(opening[0].length - 1)]?.close;
        return close === undefined ? undefined : typeText(/^\s*->\s*(.+?)\s*;?$/.exec(declaration.slice(tokens[close].end))?.[1]);
    }));
}

function signatureParameters(signature) {
    const label = signature.label;
    if (typeof label !== 'string') {
        return [];
    }
    return (signature.parameters ?? []).map(param => {
        const declaration = Array.isArray(param.label)
            ? label.slice(param.label[0], param.label[1])
            : param.label;
        if (typeof declaration !== 'string') {
            return {};
        }
        return signatureParameter(declaration);
    });
}

function signatureParameter(text) {
    const declaration = text.trim();
    if (bareIdentifier.test(declaration) && !knownTypeWord.test(declaration)) {
        return { name: declaration };
    }
    return parameterDeclaration(declaration);
}

function signatureInfo(help, callee) {
    const signature = help?.signatures?.length === 1 && help.signatures[0];
    const functionName = new RegExp('(?:^|[\\s*&:])' + escapePattern(callee) + '\\s*\\(');
    const label = signature?.label;
    const match = typeof label === 'string' && functionName.exec(label);
    if (!match) { return undefined; }
    const metadata = signatureParameters(signature);
    // Error placeholders use angle brackets. Hide these from the tokenizer so
    // that they don't force a fallback to parameter-name-only metadata.
    const cleaned = label.replace(errorTypeMarker, marker => ' '.repeat(marker.length));
    const { tokens, offsets } = indexSource(cleaned);
    const list = splitList(tokens, offsets.get(match.index + match[0].length - 1));
    if (!list || list.ambiguous) { return { parameters: metadata }; }
    const declarations = list.items.map(({ start, end }) => label.slice(tokens[start].start, tokens[end - 1].end));
    const variadic = declarations.at(-1) === '...';
    if (variadic) { declarations.pop(); }
    const parameters = declarations.map((text, i) => {
        const written = signatureParameter(text);
        const meta = metadata[i];
        return { name: written.name ?? meta?.name, type: written.type ?? meta?.type };
    });
    return { parameters: declarations.length === 1 && declarations[0] === 'void' ? [] : parameters, variadic };
}

function hoveredSignature(hovers, callee) {
    const signatures = codeSnippets(hovers).map(snippet => signatureInfo({ signatures: [{ label: snippet }] }, callee))
        .filter(Boolean);
    const unique = new Set(signatures.map(signature => JSON.stringify(signature)));
    return unique.size === 1 ? signatures[0] : undefined;
}

function parameterType(help, name) {
    const signature = help?.signatures?.length === 1 && help.signatures[0];
    if (!signature) { return undefined; }
    const parameters = signatureParameters(signature).filter(parameter => parameter.name === name);
    return parameters.length === 1 ? parameters[0].type : undefined;
}

module.exports = { enumValue, deducedType, deducedReturnType, signatureInfo, hoveredSignature, parameterType, parameterDeclaration };
