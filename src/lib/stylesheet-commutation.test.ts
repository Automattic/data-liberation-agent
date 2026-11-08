import { expect, it } from 'vitest';
import * as cheerio from 'cheerio';
import { stylesheetCommutation } from './stylesheet-commutation.js';

it.each( [
	[ '.a{color:red}', '.b{color:blue}', false ],
	[ '.a{color:red}', '#target{color:blue}', true ],
	[ '.a{margin:0!important}', '.b{margin-left:2px}', false ],
	[ '.a{font:12px serif}', '.b{line-height:2}', false ],
	[ '.a{inset:0}', '.b{top:2px}', false ],
	[ '.a{--Theme:red}', '.b{--theme:blue}', true ],
	[ '.a{color:red}', '.b::before{color:blue}', true ],
	[ '.a::before{color:red}', '.b::before{color:blue}', false ],
	[ '.a{color:red}', ':focus{color:blue}', false ],
	[ '.a{color:red}', '.absent :focus{color:blue}', true ],
	[ '.a:not(:hover){color:red}', '.b{color:blue}', false ],
	[ '.c:not(.absent){color:red}', '.b{color:blue}', true ],
	[ ':is(.a){color:red}', '.b{color:blue}', false ],
	[ '.a{color:red}', ':unknown{color:blue}', false ],
	[ '.a{color:red}', '@supports(display:grid){@media(print){.b{color:blue}}}', false ],
	[ '@font-face{font-family:"Neutral";src:url(a)}', "@font-face{font-family:'NEUTRAL';src:url(b)}", false ],
	[ '@font-face{font-family:One;src:url(a)}', '@font-face{font-family:Two;src:url(b)}', true ],
	[ '@font-face{font-family:Same;src:url(a)}', '@font-face{font-family:Same;src:url(a)}', true ],
	[ '@keyframes spin{to{opacity:0}}', '@keyframes spin{to{opacity:1}}', false ],
	[ '@keyframes spin{to{opacity:0}}', '@keyframes fade{to{opacity:1}}', true ],
	[ '@layer base{.a{color:red}}', '.b{margin:0}', false ],
	[ '@property --theme{syntax:"<color>";inherits:false;initial-value:red}', '.b{margin:0}', false ],
	[ '@import url(a);', '.b{margin:0}', false ],
	[ '@unknown{}', '.b{margin:0}', false ],
	[ undefined, '.b{margin:0}', false ],
] as const )( 'proves commutation conservatively: %s / %s', ( left, right, expected ) => {
	const source = cheerio.load( '<div id="target" class="a b"></div>' );
	const commute = stylesheetCommutation();
	expect( commute( left, right, source ) ).toBe( expected );
	expect( commute( right, left, source ) ).toBe( expected );
} );

it( 'does not reuse DOM matches between captured documents', () => {
	const commute = stylesheetCommutation();
	const left = '.a{color:red}', right = '.b{color:blue}';
	expect( commute( left, right, cheerio.load( '<div class="a"></div><div class="b"></div>' ) ) ).toBe( true );
	expect( commute( left, right, cheerio.load( '<div class="a b"></div>' ) ) ).toBe( false );
} );
