import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const transports: Record<string, number> = {
  'egress-gateway-client.ts': 4,
  'egress-gateway.ts': 7,
  'hosted-app/microvm-runtime.ts': 3,
  'runtime-session/checkpoint.ts': 4,
  'runtime-session/files.ts': 1,
  'sandbox-backend/http.ts': 1,
  'sandbox-backend/lambda-microvm.ts': 2,
  'service/programmatic-router.ts': 3,
  'service/replay-state.ts': 2,
  'service/router.ts': 5,
};

// Every request to these internal endpoints must stay on its original origin.
describe('internal transport redirect policy', () => {
  for (const [file, count] of Object.entries(transports)) {
    test(`${file} rejects redirects on every internal request`, () => {
      const source = ts.createSourceFile(file,
        fs.readFileSync(path.join(__dirname, file), 'utf8'), ts.ScriptTarget.Latest, true);
      let requests = 0;
      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node)) {
          const name = node.expression.getText(source);
          const fetchCall = name === 'fetch' || name === 'this.deps.fetch';
          const axiosCall = name === 'axios' || /^axios\.(get|post|delete)$/.test(name);
          if (fetchCall || axiosCall) {
            requests++;
            let index = 1;
            if (name === 'axios') index = 0;
            if (name === 'axios.post') index = 2;
            let options = node.arguments[index];
            while (options && (ts.isAsExpression(options) || ts.isTypeAssertionExpression(options))) {
              options = options.expression;
            }
            expect(options && ts.isObjectLiteralExpression(options)).toBe(true);
            if (!options || !ts.isObjectLiteralExpression(options)) return;
            const property = options.properties.find(prop => ts.isPropertyAssignment(prop)
              && prop.name.getText(source) === (fetchCall ? 'redirect' : 'maxRedirects'));
            expect(property && ts.isPropertyAssignment(property)).toBe(true);
            if (property && ts.isPropertyAssignment(property)) {
              expect(property.initializer.getText(source)).toBe(fetchCall ? '\'error\'' : '0');
            }
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
      expect(requests).toBe(count);
    });
  }
});
