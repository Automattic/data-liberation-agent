//
// ASCII diagram — stamping pipeline
// =====================================================================
//   manifest.json
//      │
//      ▼
//    read ──▶ { url → {slug, desktop, mobile, html, ...} }
//      │
//      ├────────────────────────────┬───────────────────────────┐
//      ▼                            ▼                           ▼
//    WXR                    products.jsonl                    (done)
//      │                            │
//      ▼                            ▼
//   readWxr()                readline-by-readline
//      │                            │
//      ▼                            ▼
//   WxrBuilder rebuild         for each product:
//   ├ inject _liberation_*     ├ overwrite .meta._liberation_*
//   │ postmeta via                │ (idempotent)
//   │ customPostmeta                │
//   ▼                            ▼
//   serialize(wxr.tmp)         write products.jsonl.tmp
//      │                            │
//      ▼                            ▼
//   rename(.tmp, .wxr)          rename(.tmp, .jsonl)
//
// SCOPE NOTE: The WXR rebuild covers attachment / page / post / nav_menu_item
// item types (i.e. everything WxrReader currently parses into `data.items`).
// Comments ride along the parent item because they're attached by postId.
// Terms (custom taxonomies) and authors/categories/tags are preserved by
// reading them out of WxrData and pushing them back into the new builder.
// If WxrReader grows support for additional item types, update the rebuild
// loop below.
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { readWxr } from '../extraction/wxr-reader.js';
import { WxrBuilder } from '../extraction/wxr-builder.js';
import type { WooProduct } from '../import/woo-product-csv.js';

const META_KEYS = {
  desktop: '_liberation_screenshot_desktop',
  desktopScrolled: '_liberation_screenshot_desktop_scrolled',
  mobile: '_liberation_screenshot_mobile',
  mobileScrolled: '_liberation_screenshot_mobile_scrolled',
  html: '_liberation_html',
} as const;

interface ManifestEntry {
  slug: string;
  desktop?: string;
  desktopScrolled?: string;
  mobile?: string;
  mobileScrolled?: string;
  html?: string;
}

interface ManifestFile {
  version: number;
  entries: Record<string, ManifestEntry>;
}

function metaForEntry(e: ManifestEntry): Record<string, string> {
  const out: Record<string, string> = {};
  if (e.desktop) out[META_KEYS.desktop] = e.desktop;
  if (e.desktopScrolled) out[META_KEYS.desktopScrolled] = e.desktopScrolled;
  if (e.mobile) out[META_KEYS.mobile] = e.mobile;
  if (e.mobileScrolled) out[META_KEYS.mobileScrolled] = e.mobileScrolled;
  if (e.html) out[META_KEYS.html] = e.html;
  return out;
}

function writeAtomic(path: string, content: string): void {
  const tmp = path + '.tmp';
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export async function stampJoinMetadata(args: { outputDir: string }): Promise<void> {
  const manifestPath = join(args.outputDir, 'screenshots', 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestFile;
  const byUrl = manifest.entries;

  // --- WXR ---
  const wxrPath = join(args.outputDir, 'output.wxr');
  if (existsSync(wxrPath)) {
    const data = readWxr(wxrPath);
    const rebuilt = new WxrBuilder({
      title: data.site.title,
      url: data.site.url,
      description: data.site.description,
      language: data.site.language,
    });

    for (const a of data.authors) {
      rebuilt.addAuthor({
        login: a.login,
        email: a.email,
        displayName: a.displayName,
        firstName: a.firstName,
        lastName: a.lastName,
      });
    }
    for (const c of data.categories) {
      rebuilt.addCategory({ slug: c.slug, name: c.name, parent: c.parent, description: c.description });
    }
    for (const t of data.tags) {
      rebuilt.addTag({ slug: t.slug, name: t.name, description: t.description });
    }
    for (const term of data.terms) {
      rebuilt.addTerm({
        taxonomy: term.taxonomy,
        slug: term.slug,
        name: term.name,
        parent: term.parent,
        description: term.description,
      });
    }

    // Map old postId -> new postId so comments re-attach correctly after rebuild.
    const postIdMap = new Map<number, number>();

    for (const it of data.items) {
      if (it.type === 'attachment') {
        const newId = rebuilt.addMedia({
          url: it.url,
          localPath: it.localPath,
          title: it.title,
          slug: it.slug,
          altText: it.altText,
          caption: it.caption,
        });
        postIdMap.set(it.id, newId);
      } else if (it.type === 'page' || it.type === 'post') {
        const entry = byUrl[it.sourceUrl];
        const customPostmeta: Record<string, string> = { ...it.customPostmeta };
        if (entry) Object.assign(customPostmeta, metaForEntry(entry));
        if (it.type === 'page') {
          const newId = rebuilt.addPage({
            title: it.title,
            slug: it.slug,
            content: it.content,
            excerpt: it.excerpt,
            date: it.date,
            parent: it.parent,
            menuOrder: it.menuOrder,
            author: it.author,
            seoTitle: it.seoTitle,
            seoDescription: it.seoDescription,
            sourceUrl: it.sourceUrl,
            customPostmeta,
          });
          postIdMap.set(it.id, newId);
        } else {
          const newId = rebuilt.addPost({
            title: it.title,
            slug: it.slug,
            content: it.content,
            excerpt: it.excerpt,
            date: it.date,
            categories: it.categories,
            tags: it.tags,
            featuredMediaId: it.featuredMediaId,
            author: it.author,
            seoTitle: it.seoTitle,
            seoDescription: it.seoDescription,
            sourceUrl: it.sourceUrl,
            customTerms: it.customTerms,
            customPostmeta,
          });
          postIdMap.set(it.id, newId);
        }
      } else if (it.type === 'nav_menu_item') {
        rebuilt.addMenuItem({
          title: it.title,
          url: it.url,
          menuSlug: it.menuSlug,
          parent: it.parent,
          order: it.menuOrder,
        });
      }
    }

    // Re-attach comments to their new post IDs.
    for (const c of data.comments) {
      const mappedPostId = postIdMap.get(c.postId) ?? c.postId;
      rebuilt.addComment({
        postId: mappedPostId,
        author: c.author,
        authorEmail: c.authorEmail,
        authorUrl: c.authorUrl,
        authorIp: c.authorIp,
        date: c.date,
        content: c.content,
        approved: c.approved === '1',
        type: c.type,
        parent: c.parent,
        userId: c.userId,
      });
    }

    for (const r of data.redirects) {
      rebuilt.addRedirect({ from: r.from, to: r.to });
    }

    // Serialize to a tmp path, then atomically rename into place.
    const tmp = wxrPath + '.tmp';
    rebuilt.serialize(tmp);
    renameSync(tmp, wxrPath);
  }

  // --- products.jsonl ---
  const productsPath = join(args.outputDir, 'products.jsonl');
  if (existsSync(productsPath)) {
    const raw = readFileSync(productsPath, 'utf8');
    const hadTrailingNewline = raw.endsWith('\n');
    const lines = raw.split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Preserve empty trailing line produced by split of a newline-terminated file.
      if (!line.trim()) {
        // Only push the empty string if it's not the synthetic trailing one — we'll
        // re-add the trailing newline at the end based on `hadTrailingNewline`.
        if (i < lines.length - 1) out.push('');
        continue;
      }
      let product: WooProduct;
      try {
        product = JSON.parse(line) as WooProduct;
      } catch {
        out.push(line);
        continue;
      }
      if (product.sourceUrl && byUrl[product.sourceUrl]) {
        const entry = byUrl[product.sourceUrl];
        product.meta = { ...(product.meta ?? {}), ...metaForEntry(entry) };
      }
      out.push(JSON.stringify(product));
    }
    const serialized = out.join('\n') + (hadTrailingNewline ? '\n' : '');
    writeAtomic(productsPath, serialized);
  }
}
