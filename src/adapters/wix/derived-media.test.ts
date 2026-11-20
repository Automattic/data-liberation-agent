import { describe, expect, it } from 'vitest';
import * as cheerio from 'cheerio';
import { deriveMemberDocument, compareDerivedWithCapture } from '../../lib/template-clusters.js';
import { rewriteWixDerivedMedia } from './derived-media.js';

const rendition = ( uri: string, width = 342 ) => `https://static.wixstatic.com/media/${ uri }/v1/fill/w_${ width },h_${ width },q_85/${ uri }`;
const image = ( uri: string, src?: string ) => `<wow-image data-image-info='${ JSON.stringify( { imageData: { uri } } ) }'><img alt="Photo"${ src ? ` src="${ src }"` : '' }></wow-image>`;
const page = ( content: string ) => `<html><head><title>Article</title></head><body><main id="content">${ content }</main></body></html>`;
const source = {
	repServerHtml: page( image( 'first.jpg' ) ),
	repProcessedHtml: page( image( 'first.jpg', rendition( 'first.jpg' ) ) ),
	memberServerHtml: page( `<p>Member</p>${ image( 'second.jpg' ) }${ image( 'second.jpg' ) }` ),
	memberRenderedHtml: page( `<p>Member</p>${ image( 'second.jpg', rendition( 'second.jpg' ) ) }${ image( 'second.jpg', rendition( 'second.jpg', 684 ) ) }` ),
	baseUrl: 'https://fixture.example/article',
	contentSlotSelector: '#content',
};

describe( 'member light-render media', () => {
	it( 'resolves member-only images by identity and occurrence, not representative geometry', () => {
		const before = deriveMemberDocument( source );
		expect( before.ok && compareDerivedWithCapture( { derivedHtml: before.html, realHtml: source.memberRenderedHtml, baseUrl: source.baseUrl } ).checks.images ).toBe( false );
		const result = deriveMemberDocument( { ...source, rewriteDerivedMedia: rewriteWixDerivedMedia } );
		expect( result.ok ).toBe( true );
		if ( ! result.ok ) return;
		expect( compareDerivedWithCapture( { derivedHtml: result.html, realHtml: source.memberRenderedHtml, baseUrl: source.baseUrl } ).equal ).toBe( true );
		expect( cheerio.load( result.html )( 'img' ).map( ( _, node ) => node.attribs.src ).get() ).toEqual( [ rendition( 'second.jpg' ), rendition( 'second.jpg', 684 ) ] );
	} );

	it.each( [ undefined, page( image( 'second.jpg' ) ), page( image( 'second.jpg', rendition( 'second.jpg' ).replace( 'q_85', 'blur_2' ) ) ) ] )( 'declines missing, partial or blurred light renders', memberRenderedHtml => {
		expect( deriveMemberDocument( { ...source, memberRenderedHtml, rewriteDerivedMedia: rewriteWixDerivedMedia } ) ).toMatchObject( { ok: false, gate: { code: 'runtime_media_unmapped' } } );
	} );

	it( 'retargets retained card identities and copies srcsets without weakening verification', () => {
		const memberRenderedHtml = page( image( 'second.jpg', rendition( 'second.jpg' ) ).replace( '<img ', `<img srcset="${ rendition( 'second.jpg' ) } 1x, ${ rendition( 'second.jpg', 684 ) } 2x" ` ) );
		const result = deriveMemberDocument( { ...source, contentSlotSelector: undefined, memberServerHtml: page( image( 'second.jpg' ) ), memberRenderedHtml, rewriteDerivedMedia: rewriteWixDerivedMedia } );
		expect( result.ok && compareDerivedWithCapture( { derivedHtml: result.html, realHtml: memberRenderedHtml, baseUrl: source.baseUrl } ).equal ).toBe( true );
		expect( rewriteWixDerivedMedia( { ...source, memberRenderedHtml: memberRenderedHtml.replaceAll( 'static.wixstatic.com', 'other.example' ), derivedHtml: memberRenderedHtml } ) ).toBeUndefined();
	} );
} );
