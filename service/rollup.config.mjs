import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import alias from '@rollup/plugin-alias';
import json from '@rollup/plugin-json';
import copy from 'rollup-plugin-copy';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
    input: 'src/service-api.ts',
    output: {
        dir: '.build-service',
        format: 'cjs',
        sourcemap: true,
        preserveModules: true,
        preserveModulesRoot: path.resolve(__dirname),
    },
    plugins: [
        copy({
            targets: [
                {
                    src: 'src/matplotlib.py',
                    dest: '.build-service/src',
                },
            ],
        }),
        json(),
        alias({
            entries: [
                { find: '@', replacement: path.resolve(__dirname, 'src') },
            ],
        }),
        resolve({
            preferBuiltins: true,
            extensions: ['.ts', '.js'],
        }),
        commonjs(),
        typescript({
            tsconfig: './tsconfig.esm.json',
            include: ['src/**/*.ts', '../shared/telemetry-core.ts'],
            sourceMap: true,
            declaration: false,
            declarationMap: false,
            outDir: undefined,
        }),
    ],
    external: [],
};
