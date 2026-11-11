import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { expect, it } from 'vitest';
import { captureWebsite } from '../../index.js';
import { checkSelfConsistency } from '../../lib/fidelity/self-consistency.js';
import { readResolvedPage } from '../../lib/site-includes.js';

const source = `<!doctype html><html><head><meta name="generator" content="Carrd"><title>Neutral studio</title>
<style>section{padding:24px}section.inactive{display:none}footer{padding:20px}</style></head><body>
<header><a href="#home">Home</a><a href="#about">About</a></header><main>
<section id="home-section" class="active"><h1>Studio home</h1><a href="#contact">Contact</a><a href="#retired">Retired route</a></section>
<section id="about-section" data-title="About the studio" class="inactive" style="display:none"><h1>Our studio</h1><div class="inner" data-onvisible-trigger="1"><p>Faded in on view</p></div></section>
<section id="contact-section" data-title="Contact the studio" class="inactive" style="display:none"><h1>Write to us</h1></section>
</main><footer>Shared studio footer <a href="#about">About</a><a href="#contact">Contact</a></footer>
<script>(function(){var items=[].slice.call(document.querySelectorAll('[data-onvisible-trigger]'));items.forEach(function(e){e.style.opacity=0;});
function check(){items=items.filter(function(e){if(e.offsetParent===null)return true;var r=e.getBoundingClientRect();if(r.top>=innerHeight)return true;e.style.opacity=1;return false;});}
addEventListener('load',check);addEventListener('scroll',check);addEventListener('resize',check);check();})();</script></body></html>`;

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS))('captures Carrd sibling sections as three portable routes through the public API', async () => {
	const parent = join(process.cwd(), '.tmp-test');
	mkdirSync(parent, { recursive: true });
	const root = mkdtempSync(join(parent, 'carrd-'));
	const server = createServer((request, response) => {
		if (request.url !== '/') { response.writeHead(404); response.end(); return; }
		response.setHeader('Content-Type', 'text/html');
		response.end(source);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
	try {
		const result = await captureWebsite({ url, outputDir: root, trustedOrigins: [url], captureImages: false, learnFluid: false });
		expect(result.summary.routesCaptured).toBe(3);
		expect(result.summary.routesFailed).toBe(0);
		const website = join(root, 'website');
		expect(checkSelfConsistency(website, new Map([
			['/', 'index.html'], ['/about/', 'about/index.html'], ['/contact/', 'contact/index.html'],
		])).findings).toEqual([]);
		for (const [name, title] of [['home', 'Neutral studio'], ['about', 'About the studio'], ['contact', 'Contact the studio']]) {
			const html = readResolvedPage(website, join(website, name === 'home' ? '' : name, 'index.html'));
			const $ = cheerio.load(html);
			expect($('section').length).toBe(1);
			expect($('section').attr('id')).toBe(`${name}-section`);
			expect($('section').attr('class')).toContain('active');
			expect($('section').attr('style')).not.toContain('display: none');
			expect($('title').text()).toBe(title);
			expect($('header').text()).toContain('Home');
			expect($('footer').text()).toContain('Shared studio footer');
			expect(html).not.toMatch(/href=["']#(?:home|about|contact)["']/);
			const routeUrl = new URL(name === 'home' ? '/' : `/${name}/`, url);
			const destination = (href: string) => new URL(href, routeUrl).pathname.replace(/index\.html$/, '');
			expect(destination($('header a').first().attr('href')!)).toBe('/');
			expect(destination($('footer a').first().attr('href')!)).toBe('/about/');
			expect(destination($('footer a').last().attr('href')!)).toBe('/contact/');
			if (name === 'home') expect(destination($('section a').last().attr('href')!)).toBe('/');
			// Carrd's router re-runs its scroll events after a section switch, so
			// an on-visible fade in a non-home section plays on every device.
			if (name === 'about') {
				expect($('[data-onvisible-trigger]').attr('style')).toMatch(/opacity:\s*1/);
				expect(html).not.toMatch(/opacity:\s*0\s*!important/);
			}
		}
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
}, 180_000);
