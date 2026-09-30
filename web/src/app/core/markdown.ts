import { Pipe, PipeTransform, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Marked } from 'marked';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Markdown renderer that never passes raw HTML through (LLM output is untrusted). */
const md = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html: ({ text }) => escapeHtml(text),
  },
});

// <sub> is the only inline tag Kavach emits itself (finding disclaimers); re-allow it after escaping.
const restoreSub = (html: string) => html.replace(/&lt;sub&gt;(.*?)&lt;\/sub&gt;/g, '<sub>$1</sub>');

/**
 * Renders Markdown and turns [D1] / [P3] citation tags into clickable chips.
 * `valid` marks tags that exist in the evidence; anything else is shown struck-through.
 */
export function renderMarkdown(src: string, valid?: Set<string>): string {
  const html = restoreSub(md.parse(src ?? '', { async: false }) as string);
  return html.replace(/\[((?:D|P)\d+)\]/g, (_m, tag: string) => {
    const kind = tag.startsWith('D') ? 'd' : 'p';
    const bogus = valid && !valid.has(tag) ? ' bogus' : '';
    return `<span class="cite ${kind}${bogus}" data-cite="${tag}" role="button" tabindex="0" title="Show evidence ${tag}">${tag}</span>`;
  });
}

@Pipe({ name: 'markdown', standalone: true })
export class MarkdownPipe implements PipeTransform {
  private sanitizer = inject(DomSanitizer);

  transform(src: string | null | undefined, valid?: string[] | Set<string>): SafeHtml {
    const set = valid ? new Set(valid) : undefined;
    // Content is escaped by the renderer above; trusting it keeps our data-* attributes intact.
    return this.sanitizer.bypassSecurityTrustHtml(renderMarkdown(src ?? '', set));
  }
}
