import ts from 'typescript';
import { type Input } from '../../util/input.js';
export declare const getReactBabelPlugins: (sourceFile: ts.SourceFile) => string[];
export declare const getIndexHtmlEntries: (rootDir: string) => Promise<Input[]>;
