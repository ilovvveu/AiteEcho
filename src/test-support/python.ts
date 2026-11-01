import { spawnSync } from 'node:child_process';

export const documentTestPython = process.env.QQ_DOCUMENT_TEST_PYTHON || 'python3';
export const textPythonAvailable = spawnSync(documentTestPython, ['-I', '-B', '-c', 'import sys'], { timeout: 10000, stdio: 'ignore' }).status === 0;
export const documentPythonAvailable = textPythonAvailable && spawnSync(documentTestPython,
  ['-I', '-B', '-c', 'import pypdf, docx, openpyxl, reportlab'], { timeout: 10000, stdio: 'ignore' }).status === 0;
