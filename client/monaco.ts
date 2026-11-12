import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/languages/features/json/json.worker.js?worker';
import CssWorker from 'monaco-editor/languages/features/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/languages/features/html/html.worker.js?worker';
import TsWorker from 'monaco-editor/languages/features/typescript/ts.worker.js?worker';
self.MonacoEnvironment = {
    getWorker(_moduleId: string, label: string) {
        if (label === 'json')
            return new JsonWorker();
        if (['css', 'scss', 'less'].includes(label))
            return new CssWorker();
        if (['html', 'handlebars', 'razor'].includes(label))
            return new HtmlWorker();
        if (['typescript', 'javascript'].includes(label))
            return new TsWorker();
        return new EditorWorker();
    },
};
loader.config({ monaco });
monaco.editor.defineTheme('cortex-dark', { base: 'vs-dark', inherit: true, rules: [{ token: 'comment', foreground: '87948e' }, { token: 'keyword', foreground: 'e1a16c' }], colors: { 'editor.background': '#1b1e21', 'editorLineNumber.foreground': '#666d74', 'editor.selectionBackground': '#4a3c32', 'editor.lineHighlightBackground': '#22272a' } });
monaco.editor.defineTheme('cortex-light', { base: 'vs', inherit: true, rules: [{ token: 'keyword', foreground: '925b32' }], colors: { 'editor.background': '#f8f5ef', 'editor.selectionBackground': '#ead7c5' } });
