import { describe, expect, test } from 'bun:test';
import {
    findUnregisteredToolCall,
    isRegisteredToolName,
    registeredToolNames,
} from './tool-scope';

describe('PTC tool scope checks', () => {
    test('blocking callbacks accept only tools registered on the execution', () => {
        const tools = [{ name: 'query_clickhouse' }, { name: 'render_chart' }];

        expect(isRegisteredToolName('query_clickhouse', tools)).toBe(true);
        expect(isRegisteredToolName('render_chart', tools)).toBe(true);
        expect(isRegisteredToolName('exfiltrate_everything', tools)).toBe(
            false,
        );
        expect(isRegisteredToolName('', tools)).toBe(false);
    });

    test('supports OpenAI-style function tool names for callers that pass that shape', () => {
        const tools = [
            { type: 'function', function: { name: 'search_docs' } },
            { name: 'legacy_tool' },
        ];

        expect(registeredToolNames(tools)).toEqual(
            new Set(['search_docs', 'legacy_tool']),
        );
        expect(isRegisteredToolName('search_docs', tools)).toBe(true);
    });

    test('replay identifies forged pending tool calls', () => {
        const calls = [
            { call_id: 'call_001', tool_name: 'query_clickhouse' },
            { call_id: 'call_002', tool_name: 'unknown_tool' },
        ];

        expect(
            findUnregisteredToolCall(calls, [{ name: 'query_clickhouse' }]),
        ).toEqual(calls[1]);
    });

    test('rejects all pending calls when no tools were registered', () => {
        expect(
            findUnregisteredToolCall(
                [{ call_id: 'call_001', tool_name: 'query_clickhouse' }],
                [],
            ),
        ).toEqual({ call_id: 'call_001', tool_name: 'query_clickhouse' });
    });
});
