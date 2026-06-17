import { describe, expect, it } from 'vitest';

import { buildJetpackFormParityCssImpl } from './jetpack-form-css-impl.js';

describe('buildJetpackFormParityCssImpl', () => {
  it('carries representative source declarations to Jetpack form selectors', () => {
    const { css } = buildJetpackFormParityCssImpl({
      formsConverted: 1,
      sourceCss: `
        .form-input,
        form input[type="email"],
        .form-select,
        textarea.form-textarea {
          border: 1px solid #123456;
          border-radius: 6px;
          padding: 12px 14px;
          font-family: "Inter", sans-serif;
          font-size: 16px;
          line-height: 1.4;
          letter-spacing: .02em;
          color: #111;
          background-color: #fff;
          box-shadow: 0 1px 2px rgba(0,0,0,.2);
          width: 100%;
          max-width: 40rem;
          margin: 32px;
        }

        .form-label,
        form label {
          color: #555;
          font-weight: 700;
          font-size: .875rem;
          margin-bottom: 8px;
        }

        .form-submit,
        form button[type="submit"],
        form input[type="submit"] {
          background: #111;
          color: #fff;
          border: 0;
          border-radius: 999px;
          padding: 10px 24px;
          font-weight: 600;
        }
      `,
    });

    expect(css).toContain(
      '.wp-block-jetpack-contact-form .contact-form.commentsblock.jetpack-contact-form__form input.grunion-field:not([type=checkbox]):not([type=radio]):not([type=hidden])',
    );
    expect(css).toContain(
      '.jetpack-contact-form-container .contact-form.commentsblock.jetpack-contact-form__form textarea.grunion-field',
    );
    expect(css).toContain(
      '.wp-block-jetpack-contact-form .contact-form.commentsblock.jetpack-contact-form__form .grunion-field-url-wrap input.grunion-field[type=text]',
    );
    expect(css).toContain(
      '.jetpack-contact-form-container .contact-form.commentsblock.jetpack-contact-form__form .contact-form__select-wrapper select',
    );
    expect(css).toContain(
      '.wp-block-jetpack-contact-form .contact-form.commentsblock.jetpack-contact-form__form .grunion-field-label',
    );
    expect(css).toContain('.wp-block-jetpack-contact-form .wp-block-jetpack-button .wp-block-button__link');
    expect(css).toContain(
      '.jetpack-contact-form-container .contact-form.commentsblock.jetpack-contact-form__form .contact-submit button[type=submit]',
    );
    expect(css).toContain(
      '.jetpack-contact-form-container .contact-form.commentsblock.jetpack-contact-form__form button.pushbutton-wide',
    );

    expect(css).toContain('border:1px solid #123456');
    expect(css).toContain('border-radius:6px');
    expect(css).toContain('padding:12px 14px');
    expect(css).toContain('font-family:"Inter", sans-serif');
    expect(css).toContain('line-height:1.4');
    expect(css).toContain('letter-spacing:.02em');
    expect(css).toContain('background-color:#fff');
    expect(css).toContain('box-shadow:0 1px 2px rgba(0,0,0,.2)');
    expect(css).toContain('max-width:40rem');
    expect(css).not.toContain('margin:32px');
  });

  it('emits Jetpack focus control selectors from source focus rules', () => {
    const { css } = buildJetpackFormParityCssImpl({
      formsConverted: 1,
      sourceCss: `
        .contact-form input:focus,
        textarea.form-textarea:focus {
          border-color: #0055ff;
          box-shadow: 0 0 0 3px rgba(0,85,255,.2);
          outline: none;
        }
      `,
    });

    expect(css).toContain(
      '.wp-block-jetpack-contact-form .contact-form.commentsblock.jetpack-contact-form__form input.grunion-field:not([type=checkbox]):not([type=radio]):not([type=hidden]):focus',
    );
    expect(css).toContain(
      '.jetpack-contact-form-container .contact-form.commentsblock.jetpack-contact-form__form .grunion-field-url-wrap input.grunion-field[type=text]:focus',
    );
    expect(css).toContain('border-color:#0055ff');
    expect(css).toContain('box-shadow:0 0 0 3px rgba(0,85,255,.2)');
    expect(css).toContain('outline:none');
  });

  it('carries source form and field-wrapper rules to Jetpack wrapper selectors', () => {
    const { css } = buildJetpackFormParityCssImpl({
      formsConverted: 1,
      sourceCss: `
        .contact-form {
          display: grid;
          gap: 18px;
          max-width: 42rem;
          margin: 0 auto;
        }

        .form-group,
        .form-check {
          display: grid;
          gap: 6px;
          margin-bottom: 14px;
        }
      `,
    });

    expect(css).toContain('.wp-block-jetpack-contact-form');
    expect(css).toContain('.jetpack-contact-form-container');
    expect(css).toContain(
      '.wp-block-jetpack-contact-form .contact-form.commentsblock.jetpack-contact-form__form',
    );
    expect(css).toContain('display:grid');
    expect(css).toContain('gap:18px');
    expect(css).toContain('max-width:42rem');
    expect(css).toContain('margin:0 auto');
    expect(css).toContain(
      '.jetpack-contact-form-container .contact-form.commentsblock.jetpack-contact-form__form [class*="grunion-field-"][class*="-wrap"]',
    );
    expect(css).toContain(
      '.wp-block-jetpack-contact-form .contact-form.commentsblock.jetpack-contact-form__form .contact-form__select-wrapper',
    );
    expect(css).toContain('margin-bottom:14px');
  });

  it('maps bare source form button rules to Jetpack submit targets', () => {
    const { css } = buildJetpackFormParityCssImpl({
      formsConverted: 1,
      sourceCss: `
        .contact-form button {
          background: #2255aa;
          color: #fff;
          border-radius: 4px;
          padding: 10px 16px;
        }
      `,
    });

    expect(css).toContain('.wp-block-jetpack-contact-form .wp-block-jetpack-button .wp-block-button__link');
    expect(css).toContain(
      '.jetpack-contact-form-container .contact-form.commentsblock.jetpack-contact-form__form .contact-submit button[type=submit]',
    );
    expect(css).toContain('background:#2255aa');
    expect(css).toContain('border-radius:4px');
    expect(css).not.toContain('.wp-block-jetpack-contact-form{background:#2255aa');
  });

  it('returns empty CSS when no forms were converted', () => {
    const { css } = buildJetpackFormParityCssImpl({
      formsConverted: 0,
      sourceCss: '.form-input{border:1px solid red}',
    });

    expect(css).toBe('');
  });

  it('returns empty CSS when no source rules match form elements', () => {
    const { css } = buildJetpackFormParityCssImpl({
      formsConverted: 1,
      sourceCss: '.hero{color:red}.site-nav a{font-weight:700}',
    });

    expect(css).toBe('');
  });
});
