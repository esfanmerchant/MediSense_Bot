import { describe, expect, it } from 'vitest';

import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  MAX_DOCUMENT_BYTES,
  sanitizeFileName,
} from '../../src/services/storage/storage.service.js';

describe('upload validation rules', () => {
  it('accepts the document types the spec lists', () => {
    for (const type of ['application/pdf', 'image/jpeg', 'image/png']) {
      expect(ALLOWED_DOCUMENT_MIME_TYPES.has(type)).toBe(true);
    }
  });

  it('rejects executables and scripts disguised as uploads', () => {
    for (const type of [
      'application/x-msdownload',
      'text/html',
      'application/javascript',
      'application/x-sh',
      'application/zip',
    ]) {
      expect(ALLOWED_DOCUMENT_MIME_TYPES.has(type)).toBe(false);
    }
  });

  it('caps uploads at 20 MB', () => {
    expect(MAX_DOCUMENT_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe('filename sanitisation', () => {
  it('keeps an ordinary filename intact', () => {
    expect(sanitizeFileName('blood-report-march.pdf')).toBe('blood-report-march.pdf');
  });

  it('strips directory traversal on both separators', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('..\\..\\windows\\system32\\config')).toBe('config');
    expect(sanitizeFileName('/absolute/path/report.pdf')).toBe('report.pdf');
  });

  it('removes characters unsafe in a path or a download header', () => {
    const cleaned = sanitizeFileName('re<po>rt:"|?*.pdf');
    for (const char of ['<', '>', ':', '"', '|', '?', '*']) {
      expect(cleaned).not.toContain(char);
    }
    expect(cleaned.endsWith('.pdf')).toBe(true);
  });

  it('removes control characters, including a header-splitting newline', () => {
    const cleaned = sanitizeFileName('report\r\nContent-Type: text/html.pdf');
    expect(cleaned).not.toContain('\n');
    expect(cleaned).not.toContain('\r');
  });

  it('falls back to a default when nothing usable remains', () => {
    expect(sanitizeFileName('')).toBe('document');
    expect(sanitizeFileName('///')).toBe('document');
    expect(sanitizeFileName('<<<>>>')).toBe('document');
  });

  it('bounds the length of an absurdly long name', () => {
    expect(sanitizeFileName(`${'a'.repeat(5000)}.pdf`).length).toBeLessThanOrEqual(110);
  });
});
