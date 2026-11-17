'use strict';

const identifier = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const integer = /^(?:0[xX][0-9a-f]+|0[bB][01]+|0[0-7]*|[1-9][0-9]*)(?:[uUlL]{0,3})$/i;
const minInt = -(1n << 31n);
const maxInt = (1n << 31n) - 1n;
const conditionalDirective = /^\s*#\s*(?:if|ifdef|ifndef|elif|elifdef|elifndef|else|endif)\b/;

function parseInteger(value) {
    if (value?.length > 128 || !integer.test(value ?? '')) { return undefined; }
    const raw = value.replace(/[uUlL]+$/, '');
    return /^0[0-7]+$/.test(raw) ? BigInt('0o' + raw.slice(1)) : BigInt(raw);
}

function enumInitializer(tokens, member) {
    if (tokens[member + 1]?.value !== '=') { return undefined; }
    let index = member + 2;
    const sign = tokens[index]?.value;
    if (sign === '+' || sign === '-') { index++; }
    if (![',', '}'].includes(tokens[index + 1]?.value)) { return undefined; }
    const literal = tokens[index]?.value;
    if (sign === '-' && /[uU]/.test(literal ?? '')) { return undefined; }
    const value = parseInteger(literal);
    return value === undefined ? undefined : (sign === '-' ? -value : value).toString();
}

const precedence = new Map([
    ['|', 1], ['^', 2], ['&', 3], ['<<', 4], ['>>', 4],
    ['+', 5], ['-', 5], ['*', 6], ['/', 6], ['%', 6]
]);

function enumExpression(tokens, start, end, known) {
    if (end - start > 120) { return undefined; }
    const bounded = value => value >= minInt && value <= maxInt;
    let cursor = start;
    function primary() {
        if (cursor >= end) { return undefined; }
        const token = tokens[cursor++].value;
        if (token === '(') {
            const value = expression(1);
            return cursor < end && tokens[cursor++].value === ')' ? value : undefined;
        }
        if (token === '+' || token === '-' || token === '~') {
            const arg = primary();
            if (!arg || (arg.unsigned && (token === '-' || token === '~'))) { return undefined; }
            const value = token === '-' ? -arg.value : token === '~' ? ~arg.value : arg.value;
            return bounded(value) ? { ...arg, value } : undefined;
        }
        const value = parseInteger(token);
        if (value !== undefined) {
            return bounded(value) ? { value, unsigned: /[uU]/.test(token) } : undefined;
        }
        return known.get(token);
    }
    function expression(minimum) {
        let left = primary();
        while (left && cursor < end) {
            const op = tokens[cursor].value;
            const rank = precedence.get(op);
            if (rank === undefined || rank < minimum) { break; }
            cursor++;
            const right = expression(rank + 1);
            if (!right) { return undefined; }
            const a = left.value;
            const b = right.value;
            const unsigned = left.unsigned || right.unsigned;
            if (unsigned && (a < 0n || b < 0n)) { return undefined; }
            let value;
            switch (op) {
                case '+': value = a + b; break;
                case '-': value = a - b; break;
                case '*': value = a * b; break;
                case '/': if (b) { value = a / b; } break;
                case '%': if (b && !(a === minInt && b === -1n)) { value = a % b; } break;
                case '|': value = a | b; break;
                case '^': value = a ^ b; break;
                case '&': value = a & b; break;
                case '<<': case '>>':
                    if (a >= 0n && b >= 0n && b < 32n) { value = op === '<<' ? a << b : a >> b; }
                    break;
            }
            if (value === undefined || !bounded(value) || (unsigned && value < 0n)) { return undefined; }
            left = { value, unsigned };
        }
        return left;
    }
    const result = expression(1);
    return cursor === end ? result : undefined;
}

function enumGroups(tokens) {
    const groups = [];
    for (let start = 0; start < tokens.length; start++) {
        if (tokens[start].value !== 'enum') { continue; }
        let brace = start + 1;
        if (['class', 'struct'].includes(tokens[brace]?.value)) { brace++; }
        if (identifier.test(tokens[brace]?.value ?? '')) { brace++; }
        let minimum;
        let maximum;
        if (tokens[brace]?.value === ':') {
            brace++;
            const typeStart = brace;
            while (identifier.test(tokens[brace]?.value ?? '') || tokens[brace]?.value === '::') { brace++; }
            const type = tokens.slice(typeStart, brace).map(token => token.value).join('');
            const fixed = /^(?:std::)?(u?)int(8|16|32|64)_t$/.exec(type);
            if (fixed) {
                const bits = BigInt(fixed[2]);
                const unsigned = Boolean(fixed[1]);
                minimum = unsigned ? 0n : -(1n << (bits - 1n));
                maximum = unsigned ? (1n << bits) - 1n : (1n << (bits - 1n)) - 1n;
            }
        }
        const open = tokens[brace];
        if (open?.value !== '{' || open.close === undefined) { continue; }
        const list = splitList(tokens, brace, true);
        const group = { start: open.start, end: tokens[open.close].end, members: [] };
        groups.push(group);
        start = open.close;
        if (!list) { continue; }
        const known = new Map();
        let next = { value: 0n, unsigned: false };
        let hexadecimal = false;
        let previousEnd = brace + 1;
        for (const item of list.items) {
            // The source scanner doesn't choose an active preprocessor branch.
            if (list.hasDirectives && tokens.slice(previousEnd, item.start).some(token => token.directive && conditionalDirective.test(token.value))) {
                hexadecimal = false;
            }
            previousEnd = item.end;
            const name = tokens[item.start];
            const implicit = item.end === item.start + 1;
            const initialized = tokens[item.start + 1]?.value === '=';
            if (!identifier.test(name.value) || known.has(name.value) || (!implicit && !initialized)) {
                next = undefined;
                hexadecimal = false;
                continue;
            }
            let resolved;
            let assignment;
            if (initialized) {
                const expression = tokens.slice(item.start + 2, item.end);
                const hexLiteral = expression.find(token => /^0x[\da-f]/i.test(token.value));
                hexadecimal = !expression.some(token => token.directive) && Boolean(hexLiteral);
                assignment = {
                    equalsOffset: tokens[item.start + 1].start,
                    valueStart: expression[0]?.start,
                    hexDigits: hexadecimal ? /^0x([\da-f']+)/i.exec(hexLiteral.value)[1].replaceAll("'", '').length : 0
                };
            }
            if (!list.hasDirectives) {
                resolved = implicit ? next : enumExpression(tokens, item.start + 2, item.end, known);
                if (!resolved && initialized) {
                    const literal = enumInitializer(tokens, item.start);
                    if (literal !== undefined) {
                        resolved = { value: BigInt(literal), unsigned: /[uU]/.test(tokens[item.end - 1].value) };
                    }
                }
                if (resolved && minimum !== undefined && (resolved.value < minimum || resolved.value > maximum)) {
                    resolved = undefined;
                }
            }
            known.set(name.value, resolved);
            const limit = maximum ?? maxInt;
            next = resolved && resolved.value < limit ? { ...resolved, value: resolved.value + 1n } : undefined;
            const delimiter = tokens[item.end];
            const after = delimiter.value === ',' ? delimiter.end : tokens[item.end - 1].end;
            group.members.push({ name: name.value, offset: name.start, end: name.end, after, implicit, assignment,
                hexadecimal, value: resolved?.value.toString() });
        }
    }
    return groups;
}

// The tokenizer finds positions and groups. IntelliSense supplies signatures,
// deduced types, enum values and the locations of struct definitions.
function indexSource(text) {
    const tokens = [];
    const offsets = new Map();
    const nesting = [];
    const closeFor = { '(': ')', '[': ']', '{': '}' };
    const pattern = /^[ \t]*#(?:\\\r?\n|[^\r\n])*(?:\r?\n|$)|\/\*[\s\S]*?(?:\*\/|$)|\/\/(?:\\\r?\n|[^\r\n])*|(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\([\s\S]*?\)\1"|(?:u8|u|U|L)?(?:"(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*')|(?:[0-9]|\.[0-9])(?:[a-zA-Z_0-9.]|'(?=\w))*|[\p{L}_][\p{L}\p{N}_]*|::|->|>>|<<|&&|<=|>=|[^\s]/gmu;
    for (const match of text.matchAll(pattern)) {
        const value = match[0];
        const token = { value, start: match.index, end: match.index + value.length };
        if (/^\s*#/.test(value)) {
            token.directive = true;
        } else if (/^\/[/*]/.test(value)) {
            continue;
        }
        const index = tokens.length;
        offsets.set(token.start, index);
        tokens.push(token);
        if (Object.hasOwn(closeFor, value)) {
            nesting.push(index);
        } else if (value === ')' || value === ']' || value === '}') {
            const openIndex = nesting.pop();
            const open = tokens[openIndex];
            if (open && closeFor[open.value] === value) {
                open.close = index;
                token.open = openIndex;
            } else {
                nesting.length = 0;
            }
        }
    }
    return { tokens, offsets };
}

function splitList(tokens, openIndex, allowDirectives = false) {
    const open = tokens[openIndex];
    if (open?.close === undefined) {
        return undefined;
    }
    const items = [];
    let start = openIndex + 1;
    let ambiguous = false;
    let hasDirectives = false;
    for (let i = start; i < open.close; i++) {
        const token = tokens[i];
        if (token.directive) {
            if (!allowDirectives) { return undefined; }
            hasDirectives = true;
            if (i === start) { start++; }
            continue;
        }
        if (token.close !== undefined) {
            i = token.close;
        } else if (token.value === ',') {
            if (i === start) {
                return undefined;
            }
            items.push({ start, end: i });
            start = i + 1;
        } else if (['<', '>', '>>'].includes(token.value)) {
            ambiguous = true;
        }
    }
    if (start < open.close) {
        items.push({ start, end: open.close });
    }
    return { items, ambiguous, hasDirectives, close: tokens[open.close] };
}

function findCall(tokens, index) {
    const open = tokens[index + 1];
    if (open?.value !== '(' || open.close === undefined || !identifier.test(tokens[index]?.value ?? '') ||
        /^(?:if|for|while|switch|sizeof|_Alignof|alignof|_Generic|_Static_assert|static_assert|decltype|typeid|catch|noexcept|return|case|defined|new|delete|static_cast|dynamic_cast|const_cast|reinterpret_cast)$/.test(tokens[index].value)) {
        return undefined;
    }
    const previous = tokens[index - 1]?.value;
    if (identifier.test(previous ?? '') && !['return', 'co_return', 'throw', 'case'].includes(previous)) {
        return undefined;
    }
    const next = tokens[open.close + 1]?.value;
    if (['{', 'const', 'noexcept', 'override', '->'].includes(next)) {
        return undefined;
    }
    return splitList(tokens, index + 1);
}

// Read simple C prototypes/definitions without resolving typedefs or macros.
function functionDeclaration(tokens, index) {
    const open = tokens[index + 1];
    if (open?.value !== '(' || open.close === undefined || !identifier.test(tokens[index]?.value ?? '') ||
        ![';', '{'].includes(tokens[open.close + 1]?.value)) { return undefined; }
    let head = index;
    while (head > 0 && !tokens[head - 1].directive && ![';', '{', '}'].includes(tokens[head - 1].value)) {
        if (index - head >= 24) { return undefined; }
        head--;
    }
    const prefix = tokens.slice(head, index).map(token => token.value);
    if (!prefix.length || !prefix.every(word => word === '*' || identifier.test(word)) ||
        prefix.some(word => /^(?:typedef|return|co_return|case|else|throw|goto|using|if|for|while|switch|do|auto)$/.test(word)) ||
        !prefix.some(word => !/^(?:\*|static|extern|inline|register|const|volatile|restrict)$/.test(word))) { return undefined; }
    const list = splitList(tokens, index + 1);
    if (!list || list.ambiguous) { return undefined; }
    return { ...list, head: tokens[head].start, name: tokens[index], definition: tokens[open.close + 1].value === '{' };
}

function cFunctions(tokens) {
    const functions = new Map();
    let conditional = 0;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.directive) {
            if (/^\s*#\s*(?:if|ifdef|ifndef)\b/.test(token.value)) { conditional++; }
            if (/^\s*#\s*endif\b/.test(token.value)) { conditional = Math.max(0, conditional - 1); }
        } else if (token.close !== undefined) {
            i = token.close;
        } else if (tokens[i + 1]?.value === '(') {
            const declaration = functionDeclaration(tokens, i);
            if (declaration) {
                const entries = functions.get(token.value) ?? [];
                entries.push({ ...declaration, conditional: conditional > 0 });
                functions.set(token.value, entries);
            }
        }
    }
    return functions;
}

function isSimpleAuto(tokens, index) {
    if (!['=', '{', '('].includes(tokens[index + 1]?.value)) {
        return false;
    }
    let i = index - 1;
    while (['const', 'volatile', '*', '&', '&&'].includes(tokens[i]?.value)) {
        i--;
    }
    return tokens[i]?.value === 'auto';
}

function arrayItems(tokens, list) {
    const hints = [];
    let index = 0n;
    for (const item of list.items) {
        const first = tokens[item.start];
        if (first.value === '[') {
            if (tokens[first.close + 1]?.value !== '=') { break; }
            const value = parseInteger(tokens[item.start + 1]?.value);
            if (first.close !== item.start + 2 || value === undefined) {
                // The compiler decides complex designators. Avoid assigning
                // uncertain indices to the remaining entries.
                break;
            }
            index = value;
        } else {
            hints.push({ item, index });
        }
        index++;
    }
    return hints;
}

function aggregateAt(tokens, openIndex) {
    if (tokens[openIndex]?.value !== '{' || tokens[openIndex - 1]?.value !== '=') {
        return undefined;
    }
    const previous = tokens[openIndex - 2];
    const isArray = previous?.value === ']' && previous.open !== undefined;
    const declarator = isArray ? previous.open - 1 : openIndex - 2;
    const name = tokens[declarator];
    if (!identifier.test(name?.value ?? '')) {
        return undefined;
    }
    let typeAt = declarator - 1;
    while (['const', 'volatile', '*'].includes(tokens[typeAt]?.value)) {
        typeAt--;
    }
    const type = tokens[typeAt];
    if (!identifier.test(type?.value ?? '') || ['return', 'case', 'else'].includes(type.value)) {
        return undefined;
    }
    return { type, isArray };
}

function structFields(tokens, anchor) {
    const candidates = [];
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].value !== 'struct') { continue; }
        const tag = tokens[i + 1]?.value !== '{' ? tokens[i + 1] : undefined;
        const brace = i + (tag ? 2 : 1);
        const open = tokens[brace];
        if (open?.value !== '{' || open.close === undefined) { continue; }
        const close = tokens[open.close];
        const alias = tokens[open.close + 1];
        if (tokens[i].start !== anchor && tag?.start !== anchor &&
            alias?.start !== anchor && open.start !== anchor) {
            continue;
        }
        if (close.start - open.start > 20000) { return undefined; }
        const names = [];
        let start = brace + 1;
        for (let j = start; j < open.close; j++) {
            const token = tokens[j];
            if (token.directive || ['{', '}', ':', '=', '<', ','].includes(token.value)) {
                return undefined;
            }
            if (token.value === ';') {
                let field = j - 1;
                if (tokens[field]?.value === ')') {
                    const pointerClose = tokens[field].open - 1;
                    const pointerOpen = tokens[pointerClose]?.open;
                    if (tokens[pointerClose]?.value !== ')' || pointerOpen === undefined ||
                        tokens[pointerOpen + 1]?.value !== '*' || pointerClose !== pointerOpen + 3 ||
                        !identifier.test(tokens[pointerOpen + 2]?.value ?? '')) {
                        return undefined;
                    }
                    names.push(tokens[pointerOpen + 2].value);
                    start = j + 1;
                    continue;
                }
                while (tokens[field]?.value === ']' && tokens[field].open !== undefined) {
                    field = tokens[field].open - 1;
                }
                if (field <= start || !identifier.test(tokens[field]?.value ?? '') ||
                    ['static', 'typedef', 'using'].includes(tokens[start]?.value)) {
                    return undefined;
                }
                names.push(tokens[field].value);
                start = j + 1;
            } else if (token.value === '(' && token.close !== undefined) {
                j = token.close;
            }
        }
        if (start === open.close && names.length) { candidates.push(names); }
    }
    return candidates.length === 1 ? candidates[0] : undefined;
}

module.exports = { indexSource, splitList, findCall, functionDeclaration, cFunctions, isSimpleAuto,
    arrayItems, aggregateAt, structFields, enumGroups };
