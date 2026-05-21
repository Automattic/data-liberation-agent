import { describe, it, expect } from 'vitest';
import { sanitizeMediaFilename, deriveFilenameFromUrl } from './media.js';

describe('sanitizeMediaFilename', () => {
  it('slugifies spaces and %-encoding, preserves extension', () => {
    expect(sanitizeMediaFilename('logo white_edited.png')).toBe('logo-white_edited.png');
    expect(sanitizeMediaFilename('logo%20white_edited.png')).toBe('logo-white_edited.png');
    expect(sanitizeMediaFilename('Al%20pic.avif')).toBe('Al-pic.avif');
  });
  it('leaves already-safe names unchanged', () => {
    expect(sanitizeMediaFilename('hero-image.jpg')).toBe('hero-image.jpg');
    expect(sanitizeMediaFilename('follow_guidelines.jpg')).toBe('follow_guidelines.jpg');
  });
  it('collapses parens / special chars to single dashes', () => {
    expect(sanitizeMediaFilename('photo (1).JPG')).toBe('photo-1.JPG');
  });
  it('falls back to "image" when the base reduces to nothing', () => {
    expect(sanitizeMediaFilename('%20.png')).toBe('image.png');
  });
});

describe('deriveFilenameFromUrl', () => {
  it('derives a safe filename from a Wix transform URL with a spaced name', () => {
    const u = new URL('https://static.wixstatic.com/media/e20b04_hash~mv2.png/v1/fill/w_111,h_48,enc_avif/logo%20white_edited.png');
    expect(deriveFilenameFromUrl(u)).toBe('logo-white_edited.png');
  });
  it('truncates at the Wix /:/ transform marker', () => {
    const u = new URL('https://static.wixstatic.com/media/abc.jpg/:/cr=t:0/file.jpg');
    expect(deriveFilenameFromUrl(u)).toBe('abc.jpg');
  });
});
